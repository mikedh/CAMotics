#!/usr/bin/env python3
"""Generate synthetic CAMotics viewer fixtures.

Outputs (matching the viewer data contract):
  - toolpath.json : ToolPath JSON (moves, tools, duration, bounds)
  - workpiece.stl : binary STL of a box roughly matching the toolpath bounds

The real C++ core (camsim) will later emit exactly this same contract; this
script exists purely to lock and test the contract against fixture data.

Run:  python3 gen_fixtures.py
"""
import json
import math
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent


def build_toolpath():
    """A raster/zigzag pocket over a square, plumbed in by rapids.

    Geometry (mm):
      stock top is z=0, we cut a pocket at z=-2 over an XY square.
      raster lines run along X, stepping over in Y.
    """
    moves = []

    # --- pocket parameters ---
    x0, x1 = 5.0, 55.0          # raster X extents
    y0, y1 = 5.0, 55.0          # raster Y extents
    step = 1.5                  # stepover in Y
    z_safe = 5.0                # rapid/clearance height
    z_cut = -2.0                # cutting depth
    tool = 1

    feed_cut = 600.0            # mm/min
    feed_plunge = 200.0
    speed = 12000.0             # rpm

    t = 0.0
    pos = [0.0, 0.0, z_safe]    # start at origin, safe height

    def add(mtype, end, feed, spd, dt):
        nonlocal t, pos
        start = list(pos)
        end = list(end)
        m = {
            "type": mtype,
            "start": [round(c, 4) for c in start],
            "end": [round(c, 4) for c in end],
            "tool": tool,
            "feed": round(feed, 3),
            "speed": round(spd, 3),
            "tStart": round(t, 4),
            "tEnd": round(t + dt, 4),
        }
        moves.append(m)
        t += dt
        pos = end

    def dist(a, b):
        return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))

    # time = distance / feed (feed in mm/min -> convert to mm/s)
    def cut_time(start, end, feed_mm_min):
        d = dist(start, end)
        f = max(feed_mm_min / 60.0, 1e-6)
        return max(d / f, 0.05)

    # 1) Rapid over to the start of the first raster line (above z_safe)
    add("rapid", [x0, y0, z_safe], feed_cut, speed,
        cut_time(pos, [x0, y0, z_safe], 5000.0))

    # 2) Plunge down to cutting depth
    add("cut", [x0, y0, z_cut], feed_plunge, speed,
        cut_time(pos, [x0, y0, z_cut], feed_plunge))

    # 3) Raster zigzag along X, stepping in Y
    y = y0
    direction = 1
    while y <= y1 + 1e-6:
        # cut across in X
        xe = x1 if direction > 0 else x0
        add("cut", [xe, y, z_cut], feed_cut, speed,
            cut_time(pos, [xe, y, z_cut], feed_cut))
        # step over in Y (unless we're at the last pass)
        ny = y + step
        if ny <= y1 + 1e-6:
            add("cut", [xe, ny, z_cut], feed_cut, speed,
                cut_time(pos, [xe, ny, z_cut], feed_cut))
        y = ny
        direction *= -1

    # 4) Retract to safe height
    add("rapid", [pos[0], pos[1], z_safe], feed_cut, speed,
        cut_time(pos, [pos[0], pos[1], z_safe], 5000.0))

    # 5) A finishing contour pass around the perimeter (more cut moves, helix-y)
    add("rapid", [x0, y0, z_safe], feed_cut, speed,
        cut_time(pos, [x0, y0, z_safe], 5000.0))
    add("cut", [x0, y0, z_cut], feed_plunge, speed,
        cut_time(pos, [x0, y0, z_cut], feed_plunge))
    perimeter = [[x1, y0, z_cut], [x1, y1, z_cut], [x0, y1, z_cut], [x0, y0, z_cut]]
    for p in perimeter:
        add("cut", p, feed_cut * 0.8, speed,
            cut_time(pos, p, feed_cut * 0.8))
    add("rapid", [x0, y0, z_safe], feed_cut, speed,
        cut_time(pos, [x0, y0, z_safe], 5000.0))

    # final rapid home
    add("rapid", [0.0, 0.0, z_safe], feed_cut, speed,
        cut_time(pos, [0.0, 0.0, z_safe], 5000.0))

    # --- bounds from all points ---
    pts = []
    for m in moves:
        pts.append(m["start"])
        pts.append(m["end"])
    mn = [min(p[i] for p in pts) for i in range(3)]
    mx = [max(p[i] for p in pts) for i in range(3)]

    doc = {
        "moves": moves,
        "tools": {
            "1": {"shape": "cylindrical", "diameter": 3.0, "length": 10.0}
        },
        "duration": round(moves[-1]["tEnd"], 4),
        "bounds": {
            "min": [round(c, 4) for c in mn],
            "max": [round(c, 4) for c in mx],
        },
    }
    return doc


def write_binary_stl(path, triangles):
    """triangles: list of (n, (v0, v1, v2)) where each v is (x,y,z)."""
    with open(path, "wb") as f:
        f.write(b"\x00" * 80)                      # 80-byte header
        f.write(struct.pack("<I", len(triangles)))  # uint32 triangle count
        for normal, (v0, v1, v2) in triangles:
            f.write(struct.pack("<3f", *normal))
            f.write(struct.pack("<3f", *v0))
            f.write(struct.pack("<3f", *v1))
            f.write(struct.pack("<3f", *v2))
            f.write(struct.pack("<H", 0))           # attribute byte count


def box_triangles(mn, mx):
    """12 triangles for an axis-aligned box from mn to mx."""
    x0, y0, z0 = mn
    x1, y1, z1 = mx
    # 8 corners
    v = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]
    # faces as (indices, normal)
    faces = [
        ([0, 1, 2, 3], (0, 0, -1)),   # bottom
        ([4, 7, 6, 5], (0, 0, 1)),    # top
        ([0, 4, 5, 1], (0, -1, 0)),   # front
        ([1, 5, 6, 2], (1, 0, 0)),    # right
        ([2, 6, 7, 3], (0, 1, 0)),    # back
        ([3, 7, 4, 0], (-1, 0, 0)),   # left
    ]
    tris = []
    for idx, n in faces:
        a, b, c, d = idx
        tris.append((n, (v[a], v[b], v[c])))
        tris.append((n, (v[a], v[c], v[d])))
    return tris


def build_workpiece(toolpath):
    """Box stock sized to the toolpath XY bounds, with a flat top at z=0."""
    bmn = toolpath["bounds"]["min"]
    bmx = toolpath["bounds"]["max"]
    pad = 5.0
    mn = (bmn[0] - pad, bmn[1] - pad, -10.0)
    mx = (bmx[0] + pad, bmx[1] + pad, 0.0)
    return box_triangles(mn, mx)


def main():
    toolpath = build_toolpath()
    (HERE / "toolpath.json").write_text(json.dumps(toolpath, indent=2))
    print(f"toolpath.json: {len(toolpath['moves'])} moves, "
          f"duration={toolpath['duration']}s, bounds={toolpath['bounds']}")

    tris = build_workpiece(toolpath)
    write_binary_stl(HERE / "workpiece.stl", tris)
    size = (HERE / "workpiece.stl").stat().st_size
    print(f"workpiece.stl: {len(tris)} triangles, {size} bytes (binary STL)")


if __name__ == "__main__":
    main()
