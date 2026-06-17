// ---------------------------------------------------------------------------
// Keyframe + delta ("video-encoding") metadata for the analytic cut SDF.
//
// The SDF cost is O(started-moves-per-cell): at the end of a dense program every
// cell scans all its moves. So we bake periodic full-state SDF snapshots F_k at
// checkpoint times t_k, and at scrub time T render
//
//     solid(p) = max( F_k(p) ,  -min over moves in (t_k, T] of sweptToolDist(p) )
//
// i.e. sample the nearest keyframe field and only re-evaluate the moves SINCE it.
// This module computes (pure JS, from the baked CutData): the K interval boundary
// times t_k, and per cell the CSR index where each interval starts (so the shader's
// per-cell loop can skip straight past the moves already folded into the keyframe).
// The field itself is baked on the GPU in viewer.ts by reusing the exact shader SDF.
// ---------------------------------------------------------------------------

import type { CutData } from './camotics';

export interface KeyframeMeta {
  count: number; // K (>= 2; fewer than 2 means "off" and buildKeyframes returns null)
  times: Float32Array; // t_k seconds, length K (t_0 = 0)
  cellKfStart: Uint32Array; // nCells*K: first CSR index in cell c with move tStart >= t_k
  dims: [number, number, number]; // field voxel grid W,H,D (one keyframe; stacked K-deep in Z)
}

const TARGET_PER_INTERVAL = 3000; // ~moves per keyframe interval (caps the per-pixel delta)
const MAX_K = 24; // memory/passes ceiling
const FIELD_BUDGET = 600_000; // voxels per keyframe (× K × 2B ≈ memory; ~29 MB at K=24)
const MIN_DIM = 8;
const MAX_DIM = 256;

export function buildKeyframes(cut: CutData): KeyframeMeta | null {
  const n = cut.nMoves;
  const K = Math.min(MAX_K, Math.max(1, Math.ceil(n / TARGET_PER_INTERVAL)));
  if (K < 2 || n < 2) return null; // light scene -> stay on the exact analytic path

  // moves are exported tStart-ascending; move p's tStart is moves[p*9 + 6].
  const tStartOf = (p: number) => cut.moves[p * 9 + 6];
  const times = new Float32Array(K);
  times[0] = 0;
  for (let k = 1; k < K; k++) times[k] = tStartOf(Math.floor((k * n) / K));

  // per cell, per checkpoint: first index in the cell's CSR slice whose move's tStart
  // >= t_k (binary search; the slice is already tStart-sorted).
  const cs = cut.cellStart;
  const cm = cut.cellMoves;
  const nCells = cs.length - 1;
  const cellKfStart = new Uint32Array(nCells * K);
  for (let c = 0; c < nCells; c++) {
    const lo = cs[c],
      hi = cs[c + 1];
    for (let k = 0; k < K; k++) {
      const tk = times[k];
      let a = lo,
        b = hi;
      while (a < b) {
        const mid = (a + b) >> 1;
        if (tStartOf(cm[mid]) < tk) a = mid + 1;
        else b = mid;
      }
      cellKfStart[c * K + k] = a;
    }
  }

  // field grid: fit FIELD_BUDGET voxels to the stock aspect ratio.
  const sx = Math.max(cut.stockMax[0] - cut.stockMin[0], 1e-3);
  const sy = Math.max(cut.stockMax[1] - cut.stockMin[1], 1e-3);
  const sz = Math.max(cut.stockMax[2] - cut.stockMin[2], 1e-3);
  const v = Math.cbrt((sx * sy * sz) / FIELD_BUDGET); // target voxel edge
  const clamp = (x: number) => Math.min(MAX_DIM, Math.max(MIN_DIM, Math.round(x)));
  const dims: [number, number, number] = [clamp(sx / v), clamp(sy / v), clamp(sz / v)];

  return { count: K, times, cellKfStart, dims };
}
