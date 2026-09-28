import { describe, expect, test as baseTest } from "bun:test";
import { existsSync } from "node:fs";
import { loadRuntimeData, type MapDef, type TilesetDef } from "../voxelmon/game/data.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { WildBattle } from "../voxelmon/game/battle/battle.ts";
import { useRareCandy } from "../voxelmon/game/rules/rare-candy.ts";
import { expForLevel } from "../voxelmon/game/rules/growth.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { canMove, type Mover } from "../voxelmon/game/world/collision.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
import { WildPopulation } from "../voxelmon/game/world/wild.ts";
import { seededRng } from "../voxelmon/game/rng.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const gen = `${import.meta.dir}/../dist/voxelmon/gen`;
const hasGen = existsSync(`${gen}/pokemon.json`);
const data = hasGen ? await loadRuntimeData(gen) : null!;
const test = baseTest.skipIf(!hasGen);
function game(species = "SQUIRTLE") {
  const g = new VoxelmonGame(data, new RecorderHost(), 42); g.newGame();
  g.save.party = [newMon(data, species, 20)];
  g.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
  g.overworld.setMap("PALLET_TOWN", 5, 6);
  return g;
}
function tap(g: VoxelmonGame, button: number) { g.tick(button); g.tick(0); }
function idle(g: VoxelmonGame, ticks = 100) { for (let n = 0; n < ticks; n++) g.tick(0); }
function testMap(tile = 1) {
  const def: MapDef = { id: "PASSIVE_TEST", label: "PassiveTest", index: 10, tileset: "OVERWORLD", width: 16, height: 16,
    blocks: Array(256).fill(0), borderBlock: 0, connections: {}, warps: [], objects: [], signs: [] };
  const ts = { id: "OVERWORLD", blocks: [Array(16).fill(tile)], walkable: [1], waterTiles: [2], shoreTiles: [],
    grassTile: 1, counterTiles: [], doorTiles: [], warpTiles: [] } as unknown as TilesetDef;
  return new GameMap(def, ts);
}

describe("passive movement", () => {
  test("Flying and Water cross water without Surf, but walls, bounds and NPCs still block", () => {
    for (const ability of ["flying", "waterWalking"] as const) {
      const mover: Mover = { cellX: 10, cellY: 10, [ability]: true };
      expect(canMove(testMap(2), [], mover, "right").ok).toBe(true);
      expect(canMove(testMap(3), [], mover, "right").ok).toBe(false);
      expect(canMove(testMap(2), [{ cellX: 11, cellY: 10 }], mover, "right").why).toBe("entity");
      expect(canMove(testMap(2), [], { ...mover, cellX: 31 }, "right").why).toBe("bounds");
    }
    expect(canMove(testMap(2), [], { cellX: 10, cellY: 10 }, "right").ok).toBe(false);
  });
  test("Flying crosses marked ledges both ways, without bypassing unrelated barriers", () => {
    const mover = { cellX: 10, cellY: 10, flying: true, ledgeTiles: [55] };
    for (const dir of ["up", "down", "left", "right"] as const) expect(canMove(testMap(55), [], mover, dir).ok).toBe(true);
    expect(canMove(testMap(55), [], { ...mover, flying: false, waterWalking: true }, "up").ok).toBe(false);
    expect(canMove(testMap(), [], mover, "up", { land: [{ tileset: "OVERWORLD", a: 1, b: 1 }] }).ok).toBe(false);
  });
  test("pilot abilities come from species types and exiting on water restores the last land position", () => {
    const g = game("GYARADOS"), ow = g.overworld;
    expect(ow.startPokemonPilot()).toBe(true);
    expect(ow.player.flying).toBe(true); expect(ow.player.waterWalking).toBe(true);
    ow.map = testMap(2); ow.player.cellX = ow.player.cellY = 10;
    ow.stopPokemonPilot();
    expect(ow.map.id).toBe("PALLET_TOWN");
    expect(ow.player.cellX).toBe(5); expect(ow.player.cellY).toBe(6);
    expect(ow.player.flying || ow.player.waterWalking).toBe(false);
  });
  test("exiting mid-step cannot leave a pending move onto water", () => {
    const g = game(); const ow = g.overworld; ow.startPokemonPilot();
    Object.assign(ow.player, { moving: true, targetX: 6, targetY: 6, progress: 5 });
    ow.stopPokemonPilot();
    expect(ow.player.moving).toBe(false); expect(ow.player.targetX).toBeUndefined();
    for (let i = 0; i < 30; i++) ow.player.update();
    expect(ow.player.cellX).toBe(5);
  });
  test("water walkers and flyers spawn only the map's surf species on water", () => {
    const map = testMap(2);
    const d = { ...data, partyIcons: { MON: 1 }, pokemon: { ...data.pokemon, TENTACOOL: { ...data.pokemon.TENTACOOL, partyIcon: "MON" } },
      encounters: { PASSIVE_TEST: { water: { rate: 255, buckets: [256], slots: [{ species: "TENTACOOL", level: 12 }] } } } };
    for (const ability of ["flying", "waterWalking"] as const) {
      const pop = new WildPopulation(seededRng(4)); const p = { cellX: 16, cellY: 16, [ability]: true };
      for (let i = 0; i < 300; i++) pop.update(d, map, p, [p]);
      const active = pop.slots.filter(w => w.active); expect(active.length).toBeGreaterThan(0);
      for (const wild of active) expect([wild.species, wild.level, wild.habitat]).toEqual(["TENTACOOL", 12, "water"]);
    }
    const pop = new WildPopulation(seededRng(4)); const p = { cellX: 16, cellY: 16 };
    for (let i = 0; i < 300; i++) pop.update(d, map, p, [p]);
    expect(pop.slots.some(w => w.active)).toBe(false);
  });
});

describe("party travel and menu", () => {
  test("START -> POKEMON allows selecting the sixth member and making it lead", () => {
    const g = game();
    g.save.party = ["SQUIRTLE", "PIDGEY", "CHARMANDER", "ABRA", "DIGLETT", "GYARADOS"].map(id => newMon(data, id, 20));
    g.openStartMenu(); tap(g, VOX_BTN.a);
    expect(g.top()?.kind).toBe("party-menu");
    for (let i = 0; i < 5; i++) tap(g, VOX_BTN.down);
    tap(g, VOX_BTN.a); tap(g, VOX_BTN.a);
    expect(g.save.party[0].species).toBe("GYARADOS");
    tap(g, VOX_BTN.start); expect(g.top()?.kind).toBe("overworld");
  });
  test("Teleport returns to the healing checkpoint without healing or spending PP", () => {
    const g = game("ABRA"), m = g.save.party[0]; m.moves = [{ id: "TELEPORT", pp: 10 }]; m.hp = 1;
    g.save.lastHeal = { map: "REDS_HOUSE_1F", x: 4, y: 6 };
    g.usePartyTravel(0, "TELEPORT"); idle(g);
    expect(g.overworld.map.id).toBe("REDS_HOUSE_1F"); expect(m.hp).toBe(1); expect(m.moves[0].pp).toBe(10);
  });
  test("Fly lists visited towns only and reaches the selected landing", () => {
    const g = game("PIDGEY"); g.save.party[0].moves = [{ id: "FLY", pp: 15 }];
    g.save.visitedOutdoor = { VIRIDIAN_CITY: { x: 20, y: 20 } };
    g.usePartyTravel(0, "FLY"); idle(g, 300);
    expect(g.uiChoice()?.labels).toEqual(["VIRIDIAN CITY", "CANCEL"]);
    tap(g, VOX_BTN.a); idle(g, 100);
    expect(g.overworld.map.id).toBe("VIRIDIAN_CITY");
  });
  test("Dig and Escape Rope leave a dungeon, and invalid use preserves rope", () => {
    for (const rope of [false, true]) {
      const g = game("DIGLETT"); g.save.party[0].moves = [{ id: "DIG", pp: 10 }];
      g.save.inventory.ESCAPE_ROPE = 2;
      g.overworld.rememberOutdoor("PALLET_TOWN", 5, 6);
      g.overworld.setMap("MT_MOON_1F", 5, 5);
      if (rope) expect(g.escapeDungeon(true)).toBe(true); else g.usePartyTravel(0, "DIG");
      idle(g); expect(g.overworld.map.id).toBe("PALLET_TOWN");
      expect(g.save.inventory.ESCAPE_ROPE).toBe(rope ? 1 : 2);
      expect(g.escapeDungeon(true)).toBe(false);
      expect(g.save.inventory.ESCAPE_ROPE).toBe(rope ? 1 : 2);
    }
  });
});

describe("battle and field items", () => {
  test("Rare Candy increments one level, preserves stat aliases/status, and stops at the cap", () => {
    const mon = newMon(data, "SQUIRTLE", 15), stats = mon.stats; mon.hp = 1; mon.status = "PSN";
    const oldHp = stats.hp, statExp = { ...mon.statExp };
    expect(useRareCandy(data, mon)).toBe(true);
    expect(mon.level).toBe(16); expect(mon.stats).toBe(stats); expect(mon.hp).toBe(1 + stats.hp - oldHp);
    expect(mon.exp).toBe(expForLevel(data.pokemon.SQUIRTLE.growthRate, 16, data.growth_rates));
    expect(mon.statExp).toEqual(statExp); expect(mon.status).toBe("PSN");
    mon.level = 100; expect(useRareCandy(data, mon)).toBe(false);
  });
  test("Fly and Dig charge, evade attacks, then hit with one PP spent", () => {
    for (const id of ["FLY", "DIG"]) {
      const mon = newMon(data, "PIDGEY", 30); mon.moves = [{ id, pp: 10 }];
      const b = new WildBattle(data, { party: [mon], inventory: {}, player: { name: "RED", rival: "BLUE" } }, seededRng(3), "RATTATA", 30);
      b.accuracyRoll = () => true;
      const hp = b.enemy.mon.hp, playerHp = mon.hp;
      b.performMove(b.player, b.enemy, mon.moves[0], false);
      expect(b.enemy.mon.hp).toBe(hp); expect(b.player.invulnerable).toBe(true);
      b.performMove(b.enemy, b.player, { id: "TACKLE", pp: 10 }, false); expect(mon.hp).toBe(playerHp);
      b.performMove(b.player, b.enemy, mon.moves[0], false);
      expect(b.enemy.mon.hp).toBeLessThan(hp); expect(mon.moves[0].pp).toBe(9);
      expect(b.player.invulnerable).toBeUndefined(); expect(b.player.chargingMove).toBeUndefined();
    }
  });
  test("Rare Candy and Escape Rope are usable battle items; rope cannot escape trainers", () => {
    for (const trainer of [false, true]) {
      const mon = newMon(data, "SQUIRTLE", 20);
      const save = { party: [mon], inventory: { RARE_CANDY: 1, ESCAPE_ROPE: 1 }, player: { name: "RED", rival: "BLUE" } };
      const b = new WildBattle(data, save, seededRng(3), "RATTATA", 20, trainer ? { name: "TRAINER" } : undefined);
      b.openItems(); expect(b.itemList).toContain("RARE_CANDY");
      expect(b.itemList.includes("ESCAPE_ROPE")).toBe(!trainer);
      const input = { wasPressed: (button: string) => button === "a", isDown: () => false };
      b.itemIndex = b.itemList.indexOf("RARE_CANDY"); b.update(input); b.update(input);
      expect(mon.level).toBe(21); expect(save.inventory.RARE_CANDY).toBeUndefined();
      expect(b.leveledUp.has(mon)).toBe(true);
      if (!trainer) {
        b.openItems(); b.itemIndex = b.itemList.indexOf("ESCAPE_ROPE"); b.update(input);
        expect(b.result).toBe("run"); expect(save.inventory.ESCAPE_ROPE).toBeUndefined();
      }
    }
  });
});

test("field bag Rare Candy consumes once, offers level moves, and evolves the selected member", () => {
  const g = game(); const mon = newMon(data, "SQUIRTLE", 15);
  g.save.party = [mon]; g.save.inventory = { RARE_CANDY: 1 }; g.save.bagOrder = ["RARE_CANDY"];
  g.openBag(); idle(g, 300); tap(g, VOX_BTN.a); idle(g, 300); tap(g, VOX_BTN.a);
  // Advance the announcement and any learned-move/evolution messages.
  for (let n = 0; n < 30; n++) { idle(g, 40); tap(g, VOX_BTN.a); }
  expect(mon.level).toBe(16); expect(mon.species).toBe("WARTORTLE");
  expect(g.save.inventory.RARE_CANDY).toBeUndefined();
});

test("field bag cancellation and level cap do not consume Rare Candy", () => {
  const g = game(); g.save.party = [newMon(data, "SQUIRTLE", 100)];
  g.save.inventory = { RARE_CANDY: 2 }; g.save.bagOrder = ["RARE_CANDY"];
  g.openBag(); idle(g, 300); tap(g, VOX_BTN.a); idle(g, 300); tap(g, VOX_BTN.b); idle(g, 30);
  expect(g.save.inventory.RARE_CANDY).toBe(2);
  g.openBag(); idle(g, 300); tap(g, VOX_BTN.a); idle(g, 300); tap(g, VOX_BTN.a); idle(g, 30);
  expect(g.save.inventory.RARE_CANDY).toBe(2); expect(g.save.party[0].level).toBe(100);
});

test("field projectiles cross water and still hit water encounters", () => {
  const g = game(), ow = g.overworld, mon = g.save.party[0];
  mon.moves = [{ id: "WATER_GUN", pp: 10 }]; ow.startPokemonPilot();
  ow.map = testMap(2); Object.assign(ow.player, { cellX: 10, cellY: 10, px: 160, py: 160, facing: "right" });
  const target = ow.wild.slots[0], enemy = newMon(data, "TENTACOOL", 20);
  Object.assign(target, { active: true, species: enemy.species, mon: enemy, hp: enemy.hp, maxHp: enemy.stats.hp,
    cellX: 12, cellY: 10, px: 192, py: 160, habitat: "water", surfing: true, timer: 10000 });
  const hp = enemy.hp;
  const controller = ow as unknown as { firePokemonAttack(): void; advancePokemonProjectile(): void };
  controller.firePokemonAttack();
  for (let i = 0; i < 24; i++) controller.advancePokemonProjectile();
  expect(enemy.hp).toBeLessThan(hp); expect(mon.moves[0].pp).toBe(9);
});

test("party switch-position action swaps members and BACK preserves the team", () => {
  const g = game(); g.save.party.push(newMon(data, "PIDGEY", 20));
  g.openParty(); tap(g, VOX_BTN.a); tap(g, VOX_BTN.down); tap(g, VOX_BTN.a);
  tap(g, VOX_BTN.down); tap(g, VOX_BTN.a);
  expect(g.save.party.map(m => m.species)).toEqual(["PIDGEY", "SQUIRTLE"]);
  tap(g, VOX_BTN.a); tap(g, VOX_BTN.b); tap(g, VOX_BTN.b);
  expect(g.top()?.kind).toBe("overworld");
  expect(g.save.party.map(m => m.species)).toEqual(["PIDGEY", "SQUIRTLE"]);
});
