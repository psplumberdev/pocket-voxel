import type { GameMap } from "./data.ts";
import type { PackedMesh, StampOut, UvTransform } from "./mesh.ts";
import type { ChapterDoor } from "../shared/chapter.ts";

/** Doors are small removable terrain meshes over the permanently open floor.
 * The existing STMP protocol keeps graphics and collision in sync on PSP. */
export function chapterStamp(map: GameMap, door: ChapterDoor, uv: UvTransform): StampOut {
  const mesh: PackedMesh = { verts: [], indices: [] };
  const closed = map.tileset.blocks[door.block];
  const opened = map.tileset.blocks[door.open];
  const quad = (points: number[][], tile: number, shade: number) => {
    const x = (tile % map.tileset.tilesPerRow) * 8, y = Math.floor(tile / map.tileset.tilesPerRow) * 8;
    const tex = [[x, y], [x + 8, y], [x + 8, y + 8], [x, y + 8]];
    const base = mesh.verts.length;
    for (let i = 0; i < 4; i++) mesh.verts.push({ x: points[i][0], y: points[i][1], z: points[i][2],
      u: (tex[i][0] + uv.baseX) / uv.pageW, v: (tex[i][1] + uv.baseY) / uv.pageH,
      abgr: (0xff000000 | shade << 16 | shade << 8 | shade) >>> 0 });
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
    const index = ty * 4 + tx, tile = closed[index];
    if (tile === opened[index]) continue;
    const x = door.bx * 32 + tx * 8, z = door.by * 32 + ty * 8;
    const h = map.walkable.has(tile) ? 1 : 16;
    quad([[x, h, z], [x + 8, h, z], [x + 8, h, z + 8], [x, h, z + 8]], tile, 255);
    quad([[x, 0, z + 8], [x + 8, 0, z + 8], [x + 8, h, z + 8], [x, h, z + 8]], tile, 200);
    quad([[x + 8, 0, z], [x, 0, z], [x, h, z], [x + 8, h, z]], tile, 200);
    quad([[x, 0, z], [x, 0, z + 8], [x, h, z + 8], [x, h, z]], tile, 180);
    quad([[x + 8, 0, z + 8], [x + 8, 0, z], [x + 8, h, z], [x + 8, h, z + 8]], tile, 180);
  }
  return { cx: door.bx * 2, cy: door.by * 2, mesh };
}
