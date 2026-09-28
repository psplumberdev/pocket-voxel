import art from "../art/projectiles/indexed.json";
import { ATLAS_KIND } from "../../contracts/spec/voxel-spec.ts";
import type { PageDef } from "./atlas.ts";

export function buildProjectileAtlas(): { page: PageDef; palette: Uint32Array } {
  const pixels = new Uint8Array(128 * 256).fill(255);
  const palette = new Uint32Array(256);
  art.colors.flat().forEach(([r, g, b], i) => { palette[i] = (0xff000000 | b! << 16 | g! << 8 | r!) >>> 0; });
  art.frames.forEach((rows, tile) => rows.forEach((row, y) => [...row].forEach((shade, x) => {
    if (shade !== ".") pixels[(Math.floor(tile / 8) * 16 + y) * 128 + tile % 8 * 16 + x] = Math.floor(tile / 5) * 5 + Number(shade);
  })));
  return { page: { w: 128, h: 256, kind: ATLAS_KIND.sprites, frames: [pixels], name: "projectiles/elements" }, palette };
}
