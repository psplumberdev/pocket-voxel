import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectileAtlas } from "../voxelmon/cook/projectiles.ts";
import { PROJECTILE_FAMILIES, projectileFamily, projectileFrame } from "../voxelmon/shared/projectiles.ts";
import { patchProjectilePak } from "../tools/projectile-pak.ts";
import { writePak } from "../voxelmon/cook/pak.ts";
import { VXPK_TAG, COLOR_PAL_NONE } from "../contracts/spec/voxel-spec.ts";

test("15 elemental families have four flight frames and one impact with a 33 KiB asset budget", () => {
  const { page, palette } = buildProjectileAtlas();
  expect(page.frames).toHaveLength(1);
  expect(page.frames[0]!.byteLength + palette.byteLength).toBe(33 * 1024);
  expect(palette[255]).toBe(0);
  for (const type of PROJECTILE_FAMILIES) {
    const flight = [0, 8, 16, 24].map(tick => projectileFrame("TEST", type, tick));
    expect(new Set(flight).size).toBe(4);
    expect(projectileFrame("TEST", type, 32)).toBe(flight[0]);
    const frames = [...flight, projectileFrame("TEST", type, 0, true)];
    const shapes: string[] = [];
    for (const tile of frames) {
      const pixels: number[] = [];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels.push(page.frames[0]![(Math.floor(tile / 8) * 16 + y) * 128 + tile % 8 * 16 + x]!);
      expect(pixels.some(p => p !== 255)).toBe(true);
      expect(pixels.some(p => p === 255)).toBe(true);
      for (const pixel of pixels) if (pixel !== 255) expect(palette[pixel]! >>> 24).toBe(255);
      shapes.push(pixels.join(","));
    }
    expect(new Set(shapes).size).toBe(5);
  }
});

test("handoff overrides take precedence over ROM move types and preserve imported aliases", () => {
  expect(projectileFamily("FLASH", "NORMAL")).toBe("ELECTRIC");
  expect(projectileFamily("SAND_ATTACK", "NORMAL")).toBe("GROUND");
  expect(projectileFamily("GUST", "NORMAL")).toBe("FLYING");
  expect(projectileFamily("WHIRLWIND", "NORMAL")).toBe("FLYING");
  expect(projectileFamily("THUNDERSHOCK", "NORMAL")).toBe("ELECTRIC");
  expect(projectileFamily("SING", "NORMAL")).toBe("NORMAL");
  expect(projectileFamily("TELEPORT", "PSYCHIC")).toBe("PSYCHIC");
  expect(projectileFamily("FUTURE_MOVE")).toBe("NORMAL");
});

test("incremental asset packaging preserves map sections and existing texture bindings, and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "voxel-projectiles-"));
  try {
    const original = writePak({ maps: [{ mapId: 7, chunks: [], stamps: [] }],
      palettes: [new Uint32Array(256)], pages: [{ w: 64, h: 32, kind: 1, frames: [new Uint8Array(2048).fill(3)], name: "old" }],
      glyphs: [[65, 1]], gameJson: new TextEncoder().encode('{"maps":{"TEST":{"index":7}},"partyIcons":{"BALL":0}}'), emotePage: null }).bytes;
    const input = join(root, "input"), output = join(root, "output"), twice = join(root, "twice");
    writeFileSync(input, original); patchProjectilePak(input, output); patchProjectilePak(output, twice);
    const old = Buffer.from(original), patched = readFileSync(output);
    expect(readFileSync(twice)).toEqual(patched);
    function section(b: Buffer, tag: number): Buffer {
      for (let i = 0; i < 9; i++) { const at = 16 + i * 16; if (b.readUInt32LE(at) === tag) return b.subarray(b.readUInt32LE(at + 4), b.readUInt32LE(at + 4) + b.readUInt32LE(at + 8)); }
      throw new Error("Missing section");
    }
    for (const tag of [VXPK_TAG.chunks, VXPK_TAG.stamps, VXPK_TAG.audio, VXPK_TAG.charmap]) expect(section(patched, tag)).toEqual(section(old, tag));
    const meta = section(patched, VXPK_TAG.meta);
    expect(meta.readUInt32LE(0)).toBe(1);
    expect(meta.readUInt32LE(4)).toBe(2);
    expect(meta.readUInt32LE(8)).toBe(2);
    expect(meta.subarray(12)).toEqual(section(old, VXPK_TAG.meta).subarray(12));
    expect(JSON.parse(section(patched, VXPK_TAG.game).toString())).toEqual({ maps: { TEST: { index: 7 } }, partyIcons: { BALL: 0 }, projectilePage: 1 });
    const oldAtlas = section(old, VXPK_TAG.atlas), atlas = section(patched, VXPK_TAG.atlas);
    expect(atlas.readUInt16LE(0)).toBe(2);
    const oldOffset = oldAtlas.readUInt32LE(10), offset = atlas.readUInt32LE(10);
    expect(atlas.subarray(offset, offset + 2048)).toEqual(oldAtlas.subarray(oldOffset, oldOffset + 2048));
    const color = section(patched, VXPK_TAG.color);
    expect(color.readUInt16LE(4)).toBe(2);
    expect(color.readUInt16LE(24)).toBe(COLOR_PAL_NONE);
    expect(color.readUInt16LE(26)).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
