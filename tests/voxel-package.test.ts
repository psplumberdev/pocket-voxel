import { expect, test } from "bun:test";
import { DEFAULT_MAPS } from "../voxelmon/cook/core.ts";
import { writePak, type PakInput } from "../voxelmon/cook/pak.ts";

test("experimental campaign packages every selected map exactly once", () => {
  expect(new Set(DEFAULT_MAPS).size).toBe(DEFAULT_MAPS.length);
  expect(DEFAULT_MAPS.filter(id => id === "MR_FUJIS_HOUSE")).toHaveLength(1);
  expect(DEFAULT_MAPS).toContain("POKEMON_TOWER_7F");
  expect(DEFAULT_MAPS).toContain("SILPH_CO_11F");
  expect(DEFAULT_MAPS).toContain("ROUTE_12");
  expect(DEFAULT_MAPS).toContain("ROUTE_12_GATE_1F");
  expect(DEFAULT_MAPS).toContain("ROUTE_12_GATE_2F");
  expect(DEFAULT_MAPS).toContain("ROUTE_12_SUPER_ROD_HOUSE");
});

test("pack writer rejects duplicate numeric IDs before emitting an invalid PSP pack", () => {
  const input = { maps: [{ mapId: 7, chunks: [], stamps: [] }, { mapId: 7, chunks: [], stamps: [] }] } as unknown as PakInput;
  expect(() => writePak(input)).toThrow("duplicate map id: 7");
});

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPspPackage } from "../tools/psp-package.ts";

test("installer copies both exact launch filenames and preserves saves", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-package-"));
  try {
    const source = await mkdtemp(join(root, "build-"));
    const destination = await mkdtemp(join(root, "VOXELMON-"));
    await writeFile(join(source, "EBOOT.PBP"), "new executable");
    await writeFile(join(source, "voxelmon.vxpak"), "validated assets");
    await writeFile(join(destination, "save.json"), "keep my save");
    const hashes = await installPspPackage(source, destination);
    expect(Object.keys(hashes)).toEqual(["voxelmon.vxpak", "EBOOT.PBP"]);
    expect(await readFile(join(destination, "EBOOT.PBP"), "utf8")).toBe("new executable");
    expect(await readFile(join(destination, "voxelmon.vxpak"), "utf8")).toBe("validated assets");
    expect(await readFile(join(destination, "save.json"), "utf8")).toBe("keep my save");
  } finally { await rm(root, { recursive: true }); }
});

test("a missing asset pack cannot overwrite the installed executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-package-"));
  try {
    const source = await mkdtemp(join(root, "build-"));
    const destination = await mkdtemp(join(root, "VOXELMON-"));
    await writeFile(join(source, "EBOOT.PBP"), "new executable");
    await writeFile(join(destination, "EBOOT.PBP"), "working executable");
    await expect(installPspPackage(source, destination)).rejects.toThrow();
    expect(await readFile(join(destination, "EBOOT.PBP"), "utf8")).toBe("working executable");
  } finally { await rm(root, { recursive: true }); }
});
