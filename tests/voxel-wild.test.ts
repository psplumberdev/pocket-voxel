import { Scene } from "../voxelmon/game/scene.ts";
import { MELEE_FLASH_TICKS, isOverworldAttackSpecies, overworldAttacksFor } from "../voxelmon/game/world/overworld-attack.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixtureData } from "./fixtures/voxelmon/fixture-data.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
import { WildPopulation, WILD_ACTOR_SLOTS, WILD_LIMIT, WILD_RADIUS, pickWild, rollsAggressive } from "../voxelmon/game/world/wild.ts";
import { fixedRng, seededRng, seqRng } from "../voxelmon/game/rng.ts";
import { ENT_FLAG, ENTS_MAX, VOX_BTN, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, type MapDef, type TilesetDef } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Ctx } from "../voxelmon/import/ctx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { GfxBin, GfxImage } from "../voxelmon/import/gfx.ts";
import { extractPartyIconGraphics, partyIconsBySpecies } from "../voxelmon/import/stages/party-icons.ts";
import type { Manifest } from "../voxelmon/import/manifest.ts";

function fixture() {
  const data = fixtureData();
  data.partyIcons = { MON: 100 };
  for (const mon of Object.values(data.pokemon)) mon.partyIcon = "MON";
  const def: MapDef = { id: "WILD_TEST", label: "WildTest", index: 10, tileset: "OVERWORLD",
    width: 16, height: 16, blocks: Array(256).fill(0), borderBlock: 0,
    connections: {}, warps: [], objects: [], signs: [] };
  const ts = { id: "OVERWORLD", blocks: [Array(16).fill(1)], walkable: [1],
    grassTile: 1, counterTiles: [], doorTiles: [], warpTiles: [] } as unknown as TilesetDef;
  data.encounters.WILD_TEST = { grass: { rate: 255, buckets: [128, 256], slots: [
    { species: "FIXMON_A", level: 3 }, { species: "FIXMON_C", level: 7 },
  ] } };
  const map = new GameMap(def, ts);
  const player = { cellX: 16, cellY: 16, surfing: false };
  return { data, def, ts, map, player };
}

function seedSlot(pop: WildPopulation, x: number, y: number) {
  const wild = pop.slots[0];
  Object.assign(wild, { active: true, species: "FIXMON_A", level: 3, icon: "MON",
    cellX: x, cellY: y, px: x * 16, py: y * 16, timer: 500 });
  return wild;
}

describe("visible wild population (ROM-free)", () => {
  test("uses original cumulative slot probabilities and levels", () => {
    const { data } = fixture();
    const table = data.encounters.WILD_TEST.grass!;
    for (let roll = 0; roll < 256; roll++) {
      expect(pickWild(table, fixedRng(roll))).toEqual(table.slots[roll < 128 ? 0 : 1]);
    }
  });
  test("four reusable slots stay bounded through long walks and map resets", () => {
    const { data, map, player } = fixture();
    const pop = new WildPopulation(seededRng(8));
    const slots = [...pop.slots];
    let max = 0;
    for (let tick = 0; tick < 12000; tick++) {
      if (tick % 120 === 0) player.cellX = player.cellX === 16 ? 10 : 16;
      pop.update(data, map, player, [player]);
      const active = pop.slots.filter(w => w.active);
      max = Math.max(max, active.length);
      expect(active.length).toBeLessThanOrEqual(WILD_LIMIT);
      for (const w of active) {
        expect(map.isGrassCell(w.cellX, w.cellY)).toBe(true);
        expect(w.cellX === player.cellX && w.cellY === player.cellY).toBe(false);
        expect(data.encounters.WILD_TEST.grass!.slots).toContainEqual({ species: w.species, level: w.level });
      }
    }
    expect(max).toBe(WILD_LIMIT);
    pop.clear();
    expect(pop.slots.every(w => !w.active)).toBe(true);
    slots.forEach((slot, i) => expect(pop.slots[i]).toBe(slot));
  });
  test("spawns avoid player, NPC/reserved cells, doors and adjacent exit cells", () => {
    const { data, def, ts, player } = fixture();
    def.warps.push({ x: 19, y: 16, destMap: "OTHER", destWarp: 1 });
    const map = new GameMap(def, ts);
    const npc = { cellX: 16, cellY: 19, targetX: 17, targetY: 19 };
    const pop = new WildPopulation(seededRng(45));
    expect(pop.habitatAt(data, map, 19, 16)).toBeNull();
    expect(pop.habitatAt(data, map, 18, 16)).toBeNull();
    for (let tick = 0; tick < 1200; tick++) {
      pop.update(data, map, player, [player, npc]);
      for (const w of pop.slots.filter(w => w.active)) {
        expect(pop.habitatAt(data, map, w.cellX, w.cellY)).toBe("grass");
        expect(w.cellY === 19 && (w.cellX === 16 || w.cellX === 17)).toBe(false);
      }
    }
  });
  test("no spawns without tables, icon assets, or render slots", () => {
    for (const mode of ["tables", "assets", "full"] as const) {
      const { data, map, player } = fixture();
      if (mode === "tables") data.encounters = {};
      if (mode === "assets") delete data.partyIcons;
      const entities = mode === "full" ? Array(ENTS_MAX).fill(player) : [player];
      const pop = new WildPopulation(seededRng(2));
      for (let tick = 0; tick < 600; tick++) pop.update(data, map, player, entities);
      expect(pop.slots.some(w => w.active)).toBe(false);
    }
  });
  test("one remaining actor slot allows only one wild Pokémon", () => {
    const { data, map, player } = fixture();
    const pop = new WildPopulation(seededRng(2));
    for (let tick = 0; tick < 600; tick++) pop.update(data, map, player, Array(WILD_ACTOR_SLOTS - 1).fill(player));
    expect(pop.slots.filter(w => w.active).length).toBe(1);
  });
  test("consuming a creature keeps its identity and gives a respawn grace period", () => {
    const { data, map, player } = fixture();
    const pop = new WildPopulation();
    const w = seedSlot(pop, 18, 16);
    expect(pop.consume(w)).toEqual({ species: "FIXMON_A", level: 3 });
    expect(pop.atCell(18, 16)).toBeUndefined();
    for (let tick = 0; tick < 179; tick++) pop.update(data, map, player, [player]);
    expect(pop.slots.every(w => !w.active)).toBe(true);
  });
  test("wandering respects habitat edges and tile-pair barriers", () => {
    const { data, map, player } = fixture();
    // Right direction, timer=30; choose spawn positions too close to player.
    const rng = { int: (n: number) => n === 4 ? 3 : n === WILD_RADIUS * 2 + 1 ? WILD_RADIUS : 0, byte: () => 0 };
    const pop = new WildPopulation(rng);
    player.cellX = 12; player.cellY = 12;
    const w = seedSlot(pop, 10, 10); w.timer = 0;
    pop.update(data, map, player, [player], { land: [{ tileset: "OVERWORLD", a: 1, b: 1 }] });
    expect(w.moving).toBe(false);
    w.timer = 0;
    pop.update(data, map, player, [player]);
    expect(w.moving).toBe(true);
    for (let i = 0; i < 24; i++) pop.update(data, map, player, [player]);
    expect([w.cellX, w.cellY, w.px]).toEqual([11, 10, 176]);
    map.isGrassCell = (x) => x <= 11;
    w.timer = 0;
    pop.update(data, map, player, [player]);
    expect(w.moving).toBe(false);
  });
  test("water creatures require surfing and stay on water; cave floors are habitat", () => {
    const { data, def, ts, player } = fixture();
    data.encounters.WILD_TEST.water = data.encounters.WILD_TEST.grass;
    ts.blocks = [Array(16).fill(0x14)];
    const water = new GameMap(def, ts);
    const pop = new WildPopulation(seededRng(2));
    for (let i = 0; i < 600; i++) pop.update(data, water, player, [player]);
    expect(pop.slots.some(w => w.active)).toBe(false);
    player.surfing = true;
    for (let i = 0; i < 600; i++) pop.update(data, water, player, [player]);
    expect(pop.slots.some(w => w.active && w.surfing)).toBe(true);
    ts.blocks = [Array(16).fill(1)]; delete ts.grassTile;
    data.field = { indoorEncounters: { firstIndoorMap: 10, excludedTileset: "FOREST" } };
    const cave = new GameMap(def, ts);
    expect(pop.habitatAt(data, cave, 10, 10)).toBe("grass");
    def.tileset = "FOREST";
    expect(pop.habitatAt(data, cave, 10, 10)).toBeNull();
  });
});

describe("party icon extraction (synthetic bytes)", () => {
  test("dex mapping reads high nibble first and handles the odd final species", () => {
    const ctx = new Ctx(new Rom(new Uint8Array([0x01, 0x20])), {
      dexOrder: ["A", "B", "C"], iconOrder: ["MON", "BUG", "GRASS"], symbols: { MonPartyData: [0, 0] },
    } as unknown as Manifest, new GfxBin());
    expect(partyIconsBySpecies(ctx)).toEqual({ A: "MON", B: "BUG", C: "GRASS" });
  });
  test("original halves are mirrored and menu rest/alternate frames preserved", () => {
    const bytes = new Uint8Array(128); bytes.fill(0xff, 0, 32);
    const gfx = new GfxBin();
    const sheet = new GfxImage(16, 96); sheet.set(0, 48, 2); sheet.set(0, 0, 1);
    gfx.add("sprites/monster", sheet);
    const ctx = new Ctx(new Rom(bytes), { iconOrder: ["MON", "BUG"], symbols: {
      BugIconFrame1: [0, 32], BugIconFrame2: [0, 0],
    } } as unknown as Manifest, gfx);
    extractPartyIconGraphics(ctx);
    const decoded = gfx.bytes();
    const mon = gfx.directory["icons/party_MON"], bug = gfx.directory["icons/party_BUG"];
    expect([mon.w, mon.h]).toEqual([16, 32]);
    expect(decoded[mon.off]).toBe(2);
    expect(decoded[mon.off + 15]).toBe(2);
    expect(decoded[mon.off + 256]).toBe(1);
    expect(decoded[bug.off]).toBe(3);
    expect(decoded[bug.off + 256]).toBe(255);
  });
});

const genDir = join(import.meta.dir, "../dist/voxelmon/gen");
const hasGen = existsSync(join(genDir, "pokemon.json"));
const runtime = hasGen ? await loadRuntimeData(genDir) : null;
function gameWithIcons() {
  const data = structuredClone(runtime!);
  // Synthetic page numbers allow the gameplay tests before a ROM recook.
  data.partyIcons ??= { MON: 10000 };
  for (const def of Object.values(data.pokemon)) def.partyIcon ??= "MON";
  const host = new RecorderHost();
  const game = new VoxelmonGame(data, host, 5);
  game.newGame(); game.chooseStarter("SQUIRTLE");
  game.overworld.setMap("ROUTE_1", 11, 6, "down");
  return { game, host };
}

describe.skipIf(!hasGen)("visible wild integration", () => {
  test("walking into a visible Pokémon starts one classic battle with that encounter", () => {
    const { game } = gameWithIcons();
    const w = seedSlot(game.overworld.wild, 11, 7);
    Object.assign(w, { species: "PIDGEY", level: 4 });
    for (let i = 0; i < 30; i++) game.tick(VOX_BTN.down);
    expect(game.overworld.player.cellY).toBe(6);
    expect(game.overworld.encounterCount).toBe(1);
    expect(game.battleView()?.battle.enemy.mon.species).toBe("PIDGEY");
    expect(game.battleView()?.battle.enemy.mon.level).toBe(4);
    expect(w.active).toBe(false);
  });
  test("contact stays in field combat until attack mode is exited", () => {
    const { game } = gameWithIcons();
    const ow = game.overworld;
    ow.startPokemonPilot();
    const w = seedSlot(ow.wild, 11, 7);
    Object.assign(w, { species: "PIDGEY", level: 4, mon: newMon(game.data, "PIDGEY", 4) });
    for (let i = 0; i < 30; i++) {
      game.input.setButtons(VOX_BTN.down); game.input.step(); ow.updatePokemonPilot();
    }
    expect(ow.encounterCount).toBe(0);
    expect(game.battleView()).toBeNull();
    expect(w.active).toBe(true);
    ow.stopPokemonPilot();
    for (let i = 0; i < 30; i++) game.tick(VOX_BTN.down);
    expect(ow.encounterCount).toBe(1);
    expect(game.battleView()?.battle.enemy.mon.species).toBe("PIDGEY");
    expect(w.active).toBe(false);
  });
  test("wild contact cannot start a battle through impassable terrain", () => {
    const { game } = gameWithIcons();
    const ow = game.overworld;
    const w = seedSlot(ow.wild, 11, 7);
    Object.assign(w, { species: "PIDGEY", level: 4 });
    ow.map.isWalkableCell = () => false;
    for (let i = 0; i < 30; i++) game.tick(VOX_BTN.down);
    expect(ow.encounterCount).toBe(0);
    expect(game.battleView()).toBeNull();
    expect(w.active).toBe(true);
  });
  test("A can engage a visible creature, and absent creatures do not roll invisible battles", () => {
    const { game } = gameWithIcons();
    game.rng = seqRng(0);
    game.overworld.onStepComplete();
    expect(game.battleView()).toBeNull();
    Object.assign(seedSlot(game.overworld.wild, 11, 7), { species: "RATTATA", level: 3 });
    game.tick(VOX_BTN.a);
    expect(game.battleView()?.battle.enemy.mon.species).toBe("RATTATA");
  });
  test("adding a wild sprite leaves every background, camera, player and NPC op unchanged", () => {
    const plain = gameWithIcons(), visible = gameWithIcons();
    for (const { game } of [plain, visible]) game.overworld.wild.consume(game.overworld.wild.slots[0]);
    const wild = seedSlot(visible.game.overworld.wild, 11, 9);
    wild.species = "PIDGEY";
    plain.game.tick(0); visible.game.tick(0);
    const slot = visible.game.overworld.npcs.length + 1 + (visible.game.data.followerSprites ? 1 : 0);
    const extra = `o ${VOX_OP.ent} ${slot} `;
    const lines = visible.host.text().split("\n");
    expect(lines.some(line => line.startsWith(extra))).toBe(true);
    expect(lines.filter(line => !line.startsWith(extra)).join("\n")).toBe(plain.host.text());
  });

  test("natural spawning does not consume battle RNG or alter the save schema", () => {
    const { game, host } = gameWithIcons();
    game.overworld.setMap("ROUTE_1", 14, 9, "down");
    let rolls = 0;
    game.rng = { byte: () => { rolls++; return 0; }, int: () => { rolls++; return 0; } };
    for (let i = 0; i < 600; i++) game.tick(0);
    expect(game.overworld.wild.slots.some(w => w.active)).toBe(true);
    expect(rolls).toBe(0);
    expect(game.saveGame()).toBe(true);
    const save = JSON.parse(host.savedJson!);
    expect(save.save.wild).toBeUndefined();
    expect(game.loadGame()).toBe(true);
    expect(game.overworld.map.id).toBe("ROUTE_1");
    expect(game.overworld.wild.slots.every(w => !w.active)).toBe(true);
  });

  test("no wilds spawn before a healthy party is available", () => {
    const { game } = gameWithIcons();
    game.save.party = [];
    for (let i = 0; i < 600; i++) game.tick(0);
    expect(game.overworld.wild.slots.some(w => w.active)).toBe(false);
  });

  test("wilds freeze while a menu is open and disappear on map changes", () => {
    const { game } = gameWithIcons();
    const w = seedSlot(game.overworld.wild, 11, 9);
    game.tick(VOX_BTN.start);
    const animation = w.animation;
    for (let i = 0; i < 200; i++) game.tick(0);
    expect(w.animation).toBe(animation);
    game.overworld.setMap("DIGLETTS_CAVE", 6, 5, "down");
    expect(game.overworld.wild.slots.every(w => !w.active)).toBe(true);
  });
});

test("hostile wild movement takes the same number of ticks as player walking", () => {
  const { data, map, player } = fixture();
  const pop = new WildPopulation(seededRng(8));
  const wild = seedSlot(pop, player.cellX - 3, player.cellY);
  wild.aggro = true;
  pop.update(data, map, player, [player]);
  expect(wild.moving).toBe(true);
  const startX = wild.cellX;
  for (let tick = 1; tick <= 15; tick++) {
    pop.update(data, map, player, [player]);
    expect(wild.cellX).toBe(startX);
    expect(wild.px).toBe(startX * 16 + tick);
  }
  pop.update(data, map, player, [player]);
  expect(wild.cellX).toBe(startX + 1);
  expect(wild.moving).toBe(false);
});

describe.skipIf(!hasGen)("overworld move projectiles", () => {
  test("player and enemy shots render all four elemental frames and the matching impact on one page", () => {
    const { game, host } = gameWithIcons();
    game.data.projectilePage = 7777;
    const ow = game.overworld;
    const enemy = ow.wild.slots[0]!;
    const entities: number[][] = [];
    host.ent = (...args: number[]) => { entities.push(args); };
    for (const source of [undefined, enemy]) for (let frame = 0; frame < 4; frame++) {
      ow.pokemonProjectiles = [{ x: 11, y: 7, dx: -1, dy: 0, remaining: 5, name: "FLASH",
        monIndex: 0, frame: frame * 8, ticks: 0, stepTicks: 12, move: { id: "FLASH", pp: 1 }, source }];
      ow.pokemonImpacts = [{ x: 11, y: 8, moveId: "FLASH", ticks: 12 }];
      entities.length = 0;
      new Scene(host).emit(game);
      const visuals = entities.filter(args => args[1] === 7777);
      expect(visuals.map(args => args[2])).toEqual([20 + frame, 24]);
      expect(visuals[0]![6]! & ENT_FLAG.tiled).toBe(ENT_FLAG.tiled);
      expect(visuals[0]![6]! & ENT_FLAG.mirror).toBe(ENT_FLAG.mirror);
    }
    ow.setMap("ROUTE_1", 11, 6, "down");
    expect(ow.pokemonImpacts).toHaveLength(0);
  });

  test("player projectiles take half a walking step per tile and spend PP even when blocked", () => {
    const { game } = gameWithIcons();
    const mon = newMon(game.data, "PIKACHU", 10);
    mon.moves = [{ id: "THUNDERSHOCK", pp: 10 }];
    game.save.party = [mon];
    const ow = game.overworld;
    ow.wild.clear();
    ow.wild.update = () => {};
    expect(ow.startPokemonPilot()).toBe(true);
    (ow as unknown as { firePokemonAttack(): void }).firePokemonAttack();
    expect(mon.moves[0]!.pp).toBe(9);
    const shot = ow.pokemonProjectile!;
    expect(shot).toBeDefined();
    for (let i = 1; i < ow.player.stepFrames / 2; i++) ow.updatePokemonPilot();
    expect(shot.y).toBe(ow.player.cellY);
    ow.updatePokemonPilot();
    expect(shot.y).toBe(ow.player.cellY + 1);
    ow.map.isWalkableCell = () => false;
    for (let i = 0; i < ow.player.stepFrames / 2; i++) ow.updatePokemonPilot();
    expect(ow.pokemonProjectile).toBeUndefined();
    expect(mon.moves[0]!.pp).toBe(9);
    expect(ow.pokemonImpacts).toHaveLength(1);
    expect(ow.pokemonImpacts[0]!.moveId).toBe("THUNDERSHOCK");
    for (let i = 0; i < 12; i++) ow.updatePokemonPilot();
    expect(ow.pokemonImpacts).toHaveLength(0);
  });

  test("pursuing enemies stop to emit visible melee and ranged attacks", () => {
    for (const [move, distance] of [["TACKLE", 1], ["ROCK_THROW", 3]] as const) {
      const { game, host } = gameWithIcons();
      const ow = game.overworld;
      game.save.party = [newMon(game.data, "PIKACHU", 30)];
      ow.wild.clear();
      ow.startPokemonPilot();
      game.data.partyIcons!.BALL ??= game.data.partyIcons!.MON!;
      const wild = seedSlot(ow.wild, ow.player.cellX, ow.player.cellY + distance);
      Object.assign(wild, { species: "ONIX", level: 20, aggressive: true, aggro: true,
        habitat: "grass", facing: "down", attackCooldown: 0 });
      wild.mon = newMon(game.data, "ONIX", 20);
      wild.mon.moves = [{ id: move, pp: 20 }];
      // Keep actual movement/AI active, with a walkable habitat for pursuit.
      (ow.wild as any).habitatAt = () => "grass";
      ow.updatePokemonPilot();
      expect(wild.facing).toBe("up");
      expect(wild.moving).toBe(false);
      const scene = new Scene(host);
      scene.emit(game); host.frameDone(0, 0);
      const entities = host.text().split("\n").filter(line => line.startsWith(`o ${VOX_OP.ent} `));
      if (distance === 1) {
        expect(ow.pokemonMeleeFlashes).toContainEqual(expect.objectContaining({ x: ow.player.cellX, y: ow.player.cellY }));
        expect(entities.some(line => line.endsWith(` ${ENT_FLAG.melee}`))).toBe(true);
      } else {
        expect(ow.pokemonProjectile?.source).toBe(wild);
        expect(ow.pokemonProjectile?.dy).toBe(-1);
        expect(entities.some(line => line.split(" ").map(Number)[7] === 6)).toBe(true);
      }
    }
  });

  test("wild Pokémon launch their learned ranged moves without immediate contact damage", () => {
    const { game } = gameWithIcons();
    game.save.party = [newMon(game.data, "PIKACHU", 10)];
    const ow = game.overworld;
    ow.wild.clear();
    ow.wild.update = () => {};
    expect(ow.startPokemonPilot()).toBe(true);
    const wild = seedSlot(ow.wild, ow.player.cellX, ow.player.cellY + 3);
    Object.assign(wild, { species: "ONIX", level: 20, aggressive: true, aggro: true });
    wild.mon = newMon(game.data, "ONIX", 20);
    wild.mon.moves = [{ id: "ROCK_THROW", pp: 15 }];
    const hp = game.save.party[0]!.hp;
    ow.updatePokemonPilot();
    expect(ow.pokemonProjectile?.source).toBe(wild);
    expect(ow.pokemonProjectile?.move.id).toBe("ROCK_THROW");
    expect(game.save.party[0]!.hp).toBe(hp);
    expect(wild.attackCooldown).toBe(180);
  });
});

test("spawn loading precedes fully initialized stats, HP, learned moves and battler", () => {
  const { data, map, player } = fixture();
  const pop = new WildPopulation(seededRng(8));
  for (let i = 0; i < 300 && !pop.loading; i++) pop.update(data, map, player, [player]);
  expect(pop.loading).toBe(true);
  expect(pop.slots.some(w => w.active)).toBe(false);
  pop.update(data, map, player, [player]);
  expect(pop.loading).toBe(false);
  const wild = pop.slots.find(w => w.active)!;
  expect(wild.mon).toBeDefined();
  expect(wild.mon!.moves.length).toBeGreaterThan(0);
  expect(wild.hp).toBe(wild.mon!.stats.hp);
  expect(wild.battler!.mon).toBe(wild.mon!);
  expect(wild.mon!.stats.speed).toBeGreaterThan(0);
});

test("aggression is exactly one of five equally likely spawn outcomes", () => {
  expect([0, 1, 2, 3, 4].map(roll => rollsAggressive({ int: () => roll, byte: () => 0 })))
    .toEqual([true, false, false, false, false]);
});

describe.skipIf(!hasGen)("field encounter rules", () => {
  function field() {
    const { game, host } = gameWithIcons();
    const ow = game.overworld;
    ow.wild.clear();
    ow.wild.update = () => {};
    const mon = newMon(game.data, "IVYSAUR", 30);
    mon.moves = [{ id: "TACKLE", pp: 35 }];
    game.save.party = [mon];
    ow.startPokemonPilot();
    const wild = seedSlot(ow.wild, ow.player.cellX, ow.player.cellY + 1);
    Object.assign(wild, { species: "RATTATA", level: 3 });
    wild.mon = newMon(game.data, "RATTATA", 3);
    const fire = () => (ow as unknown as { firePokemonAttack(): void }).firePokemonAttack();
    return { game, host, ow, mon, wild, fire };
  }

  test("passive neighbors stay passive until attacked; misses still provoke", () => {
    const { ow, wild, game, fire } = field();
    for (let i = 0; i < 30; i++) ow.updatePokemonPilot();
    expect(wild.aggro).toBe(false);
    game.data.moves.TACKLE!.accuracy = 0;
    fire();
    expect(wild.provoked).toBe(true);
    expect(wild.hp).toBe(wild.mon!.stats.hp);
    ow.updatePokemonPilot();
    expect(wild.aggro).toBe(true);
  });

  test("melee marks the facing cell on misses and enemy attacks", () => {
    const { ow, wild, mon, fire, game, host } = field();
    ow.player.facing = "up";
    fire();
    expect(ow.pokemonMeleeFlashes).toContainEqual(expect.objectContaining({ x: ow.player.cellX, y: ow.player.cellY - 1 }));
    expect(wild.provoked).toBe(false);
    wild.aggressive = true; wild.aggro = true; wild.facing = "up";
    wild.mon!.moves = [{ id: "TACKLE", pp: 35 }];
    ow.updatePokemonPilot();
    expect(ow.pokemonMeleeFlashes.some(f => f.x === ow.player.cellX && f.y === ow.player.cellY)).toBe(true);
    const scene = new Scene(host);
    scene.emit(game);
    host.frameDone(0, 0);
    expect(host.text().split("\n").some(line => line.startsWith(`o ${VOX_OP.ent} `) && line.endsWith(` ${ENT_FLAG.melee}`))).toBe(true);
    for (let i = 0; i < MELEE_FLASH_TICKS; i++) ow.updatePokemonPilot();
    expect(ow.pokemonMeleeFlashes).toHaveLength(0);
    expect(mon.hp).toBeGreaterThan(0);
  });

  test("melee includes the facing tile in all four directions", () => {
    for (const [dir, dx, dy] of [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]] as const) {
      const { ow, wild, fire } = field();
      ow.player.facing = dir;
      Object.assign(wild, { cellX: ow.player.cellX + dx, cellY: ow.player.cellY + dy,
        px: (ow.player.cellX + dx) * 16, py: (ow.player.cellY + dy) * 16 });
      fire();
      expect(ow.pokemonMeleeFlashes).toHaveLength(5);
      expect(ow.pokemonMeleeFlashes).toContainEqual(expect.objectContaining({ x: wild.cellX, y: wild.cellY }));
      expect(wild.provoked).toBe(true);
    }
  });

  test("enemy melee cannot hit behind its facing or while stepping", () => {
    const { ow, wild, mon } = field();
    wild.aggressive = wild.aggro = true;
    wild.mon!.moves = [{ id: "TACKLE", pp: 35 }];
    wild.facing = "down";
    const hp = mon.hp;
    ow.updatePokemonPilot();
    expect(ow.pokemonMeleeFlashes).toHaveLength(0);
    expect(mon.hp).toBe(hp);
    wild.facing = "up"; wild.moving = true;
    ow.updatePokemonPilot();
    expect(ow.pokemonMeleeFlashes).toHaveLength(0);
    wild.moving = false;
    ow.updatePokemonPilot();
    expect(ow.pokemonMeleeFlashes).toHaveLength(5);
    expect(ow.pokemonMeleeFlashes).toContainEqual(expect.objectContaining({ x: ow.player.cellX, y: ow.player.cellY }));
  });

  test("changing input mid-step keeps facing and melee aligned with travel", () => {
    const { ow, game, fire } = field();
    const x = ow.player.cellX, y = ow.player.cellY;
    Object.assign(ow.player, { facing: "right", moving: true, targetX: x + 1, targetY: y,
      progress: 16, stepFramesCur: 24 });
    game.input.isDown = dir => dir === "up";
    ow.updatePokemonPilot();
    expect(ow.player.facing).toBe("right");
    expect(ow.player.py).toBe(y * 16);
    fire();
    expect(ow.pokemonMeleeFlashes).toContainEqual(expect.objectContaining({ x: x + 2, y }));
  });

  test("sleep freezes player movement and prevents player and enemy attacks", () => {
    const { ow, mon, wild, fire, game } = field();
    mon.status = "SLP";
    wild.mon!.status = "SLP";
    wild.aggressive = wild.aggro = true;
    wild.facing = "up";
    Object.assign(ow.player, { moving: true, targetX: ow.player.cellX + 1,
      targetY: ow.player.cellY, facing: "right", progress: 5, stepFramesCur: 24 });
    game.input.isDown = dir => dir === "right";
    const x = ow.player.px, pp = mon.moves[0]!.pp;
    for (let i = 0; i < 299; i++) { fire(); ow.updatePokemonPilot(); }
    expect(ow.player.px).toBe(x);
    expect(ow.player.progress).toBe(5);
    expect(mon.moves[0]!.pp).toBe(pp);
    expect(ow.pokemonMeleeFlashes).toHaveLength(0);
    expect(ow.pokemonProjectiles).toHaveLength(0);
    ow.updatePokemonPilot();
    expect(mon.status).toBeNull();
    expect(ow.player.progress).toBe(6);
  });

  test("kill XP is applied once to the controlled Pokémon", () => {
    const { ow, wild, mon, fire, game } = field();
    game.data.moves.TACKLE!.accuracy = 100;
    wild.mon!.hp = wild.hp = 1;
    const before = mon.exp;
    for (let i = 0; i < 10 && wild.active; i++) { ow.pokemonAttackCooldown = 0; fire(); }
    expect(wild.active).toBe(false);
    expect(wild.rewarded).toBe(true);
    expect(mon.exp).toBeGreaterThan(before);
    const after = mon.exp;
    ow.pokemonAttackCooldown = 0; fire();
    expect(mon.exp).toBe(after);
  });

  test("every Pokémon through #050 has stats, graphics and valid original moves", () => {
    const { game } = gameWithIcons();
    const species = Object.values(game.data.pokemon).filter(p => p.dex <= 50);
    expect(species).toHaveLength(50);
    for (const def of species) {
      expect(isOverworldAttackSpecies(def.id)).toBe(true);
      expect(game.data.partyIcons?.[def.partyIcon!]).toBeDefined();
      for (const stat of Object.values(def.baseStats)) expect(stat).toBeGreaterThan(0);
      for (const id of [...def.level1Moves, ...def.learnset.map(m => m.move)]) {
        const move = game.data.moves[id];
        expect(move).toBeDefined();
        expect(move!.pp).toBeGreaterThan(0);
        expect(overworldAttacksFor(def.id, [{ id }], game.data.moves)[0]!.power).toBe(move!.power);
      }
    }
  });
});

describe.skipIf(!hasGen)("field pacing at the host's fastest 60 Hz logic rate", () => {
  test("an adjacent ranged target takes 12 ticks, with visible positions across 6 presented frames", () => {
    const { game, host } = gameWithIcons();
    const ow = game.overworld;
    const mon = newMon(game.data, "PIKACHU", 10);
    mon.moves = [{ id: "THUNDERSHOCK", pp: 10 }];
    game.save.party = [mon];
    game.data.partyIcons!.BALL ??= game.data.partyIcons!.MON!;
    ow.wild.clear(); ow.wild.update = () => {};
    ow.startPokemonPilot();
    const wild = seedSlot(ow.wild, ow.player.cellX, ow.player.cellY + 1);
    Object.assign(wild, { species: "RATTATA", level: 3 });
    wild.mon = newMon(game.data, wild.species, wild.level);
    const hp = wild.mon.hp;
    (ow as unknown as { firePokemonAttack(): void }).firePokemonAttack();
    const shot = ow.pokemonProjectile!;
    expect(shot.stepTicks).toBe(12);
    const scene = new Scene(host);
    let presented = 0;
    for (let tick = 0; tick < 12; tick++) {
      if (tick % 2 === 0) { scene.emit(game); host.frameDone(tick, 0); presented++; }
      expect(ow.pokemonProjectile).toBe(shot);
      expect(wild.mon.hp).toBe(hp);
      ow.updatePokemonPilot();
    }
    expect(presented).toBe(6);
    expect(ow.pokemonProjectile).toBeUndefined();
    const points = host.text().split("\n").filter(line => line.startsWith(`o ${VOX_OP.ent} `))
      .map(line => line.split(" ").map(Number)).filter(args => args[7] === 6);
    expect(new Set(points.map(args => args[6])).size).toBeGreaterThanOrEqual(6);
  });

  test("cycling and music cannot speed up the field pilot", () => {
    const { game } = gameWithIcons();
    game.save.party = [newMon(game.data, "PIKACHU", 10)];
    game.overworld.startPokemonPilot();
    for (const cycling of [false, true]) for (const music of [false, true]) {
      game.cycling = cycling;
      game.setMusicEnabled(music);
      expect(game.overworld.player.stepFrames).toBe(24);
    }
    game.overworld.stopPokemonPilot();
    game.cycling = false;
    game.setMusicEnabled(false);
    expect(game.overworld.player.stepFrames).toBe(16);
  });
});
