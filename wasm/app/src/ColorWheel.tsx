// ---------------------------------------------------------------------------
// Zero-dependency HSV color wheel popover (hue = angle, saturation = radius) with
// a value slider. Anchored near the click; emits a hex string live as you drag.
// ---------------------------------------------------------------------------

import { useRef, useEffect, useState, useCallback } from 'preact/hooks';

const SIZE = 168; // wheel diameter in px
const R = SIZE / 2;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [(h + 360) % 360, mx ? d / mx : 0, mx];
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function parseHex(s: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return [154, 160, 166];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawWheel(canvas: HTMLCanvasElement, value: number) {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px - R + 0.5,
        dy = py - R + 0.5;
      const dist = Math.hypot(dx, dy);
      const i = (py * SIZE + px) * 4;
      if (dist > R) {
        d[i + 3] = 0;
        continue;
      }
      const hue = (Math.atan2(dy, dx) * 180) / Math.PI;
      const [r, g, b] = hsvToRgb(hue, Math.min(1, dist / R), value);
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

interface Props {
  x: number;
  y: number;
  color: string;
  onChange: (hex: string) => void;
  onClose: () => void;
}

export function ColorWheel({ x, y, color, onChange, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(...parseHex(color)));

  useEffect(() => {
    if (canvasRef.current) drawWheel(canvasRef.current, hsv[2]);
  }, [hsv[2]]);

  useEffect(() => {
    const [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2]);
    onChange(toHex(r, g, b));
  }, [hsv[0], hsv[1], hsv[2]]);

  const pick = useCallback((e: PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - R;
    const dy = e.clientY - rect.top - R;
    const hue = (Math.atan2(dy, dx) * 180) / Math.PI;
    const sat = Math.min(1, Math.hypot(dx, dy) / R);
    setHsv((h) => [hue, sat, h[2]]);
  }, []);

  const onDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pick(e);
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons & 1) pick(e);
  };

  // marker position on the wheel
  const mx = R + Math.cos((hsv[0] * Math.PI) / 180) * hsv[1] * R;
  const my = R + Math.sin((hsv[0] * Math.PI) / 180) * hsv[1] * R;
  const [pr, pg, pb] = hsvToRgb(hsv[0], hsv[1], hsv[2]);
  const hexStr = toHex(pr, pg, pb);

  // keep the popover on-screen
  const left = Math.min(x, window.innerWidth - SIZE - 40);
  const top = Math.min(y, window.innerHeight - SIZE - 110);

  return (
    <div class="cw-backdrop" onPointerDown={onClose}>
      <div
        class="cw-pop"
        style={{ left: `${left}px`, top: `${top}px` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div class="cw-wheel" style={{ width: `${SIZE}px`, height: `${SIZE}px` }}>
          <canvas
            ref={canvasRef}
            width={SIZE}
            height={SIZE}
            onPointerDown={onDown}
            onPointerMove={onMove}
          />
          <div class="cw-marker" style={{ left: `${mx}px`, top: `${my}px` }} />
        </div>
        <input
          class="cw-value"
          type="range"
          min="0"
          max="100"
          value={String(Math.round(hsv[2] * 100))}
          onInput={(e) =>
            setHsv((h) => [h[0], h[1], parseInt((e.currentTarget as HTMLInputElement).value, 10) / 100])
          }
        />
        <div class="cw-foot">
          <span class="cw-swatch" style={{ background: hexStr }} />
          <input
            class="cw-hex"
            value={hexStr}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (/^#?[0-9a-f]{6}$/i.test(v.trim())) setHsv(rgbToHsv(...parseHex(v)));
            }}
          />
          <button class="cw-done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
