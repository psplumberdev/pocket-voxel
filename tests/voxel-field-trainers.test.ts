import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { trainerPayout } from "../voxelmon/game/rules/economy.ts";
import { DEFAULT_MAPS } from "../voxelmon/cook/core.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const gen = `${import.meta.dir}/../dist/voxelmon/gen`;
const runtime = existsSync(`${gen}/pokemon.json`) ? await loadRuntimeData(gen) : null;
describe.skipIf(!runtime)("existing-world field trainers and collision", () => {
  function game(map = "ROUTE_1") {
    const g = new VoxelmonGame(structuredClone(runtime!), new RecorderHost(), 5);
    g.newGame(); g.chooseStarter("BULBASAUR");
    const ow = g.overworld; ow.setMap(map, 11, 6, "down"); ow.wild.clear();
    const mon = newMon(g.data, "IVYSAUR", 30); mon.moves = [{ id: "TACKLE", pp: 35 }]; g.save.party = [mon];
    ow.startPokemonPilot();
    return { g, ow, mon };
  }
  const party = [{ species: "RATTATA", level: 4 }, { species: "PIDGEY", level: 5 }, { species: "EKANS", level: 6 }];
  function defeat(ow: ReturnType<typeof game>["ow"]) {
    const w = ow.wild.slots.find(w => w.active)!;
    w.mon!.hp = w.hp = 0;
    (ow as any).finishFieldOpponent(w, 0);
  }
  function advance(ow: ReturnType<typeof game>["ow"], n: number) {
    for (let i = 0; i < n; i++) ow.updatePokemonPilot();
  }
  test("controlled Pokémon cannot walk through wilds or start classic contact battles", () => {
    const { g, ow } = game();
    const w = ow.wild.slots[0]!;
    const m = newMon(g.data, "RATTATA", 4);
    Object.assign(w, { active: true, species: "RATTATA", mon: m, hp: m.hp, cellX: 11, cellY: 7,
      px: 176, py: 112, timer: 10000, aggressive: false });
    for (let i = 0; i < 70; i++) {
      g.input.setButtons(VOX_BTN.down); g.input.step();
      ow.updatePokemonPilot();
    }
    expect(ow.player.cellY).toBe(6); expect(ow.player.py).toBe(96);
    expect(w.active).toBe(true); expect(w.mon!.hp).toBe(m.stats.hp);
    expect(ow.encounterCount).toBe(0);
    expect(g.battleView()).toBeNull();
  });
  test("an enemy's destination tile is reserved while it moves", () => {
    const { g, ow } = game();
    ow.wild.update = () => {};
    Object.assign(ow.wild.slots[0]!, { active: true, species: "RATTATA", mon: newMon(g.data, "RATTATA", 4),
      cellX: 12, cellY: 7, px: 192, py: 112, moving: true, targetX: 11, targetY: 7 });
    for (let i = 0; i < 60; i++) { g.input.setButtons(VOX_BTN.down); g.input.step(); ow.updatePokemonPilot(); }
    expect(ow.player.cellY).toBe(6);
  });
  test("trainer sends only one member at a time and pays exactly once after the final defeat", () => {
    const { g, ow, mon } = game();
    let wins = 0; const money = g.save.money!, xp = mon.exp;
    g.pushTrainerBattle("YOUNGSTER", "OPP_YOUNGSTER", party, () => { wins++; g.save.flags.FIELD_TEST_WIN = true; });
    expect(g.battleView()).toBeNull(); expect(ow.fieldTrainerActive).toBe(true);
    for (const member of party) {
      const active = ow.wild.slots.filter(w => w.active);
      expect(active).toHaveLength(1); expect(active[0]!.species).toBe(member.species);
      expect(active[0]!.mon!.level).toBe(member.level);
      expect(active[0]!.mon!.moves.length).toBeGreaterThan(0);
      expect(wins).toBe(0); expect(g.save.money).toBe(money);
      defeat(ow); expect(ow.wild.slots.filter(w => w.active)).toHaveLength(0);
      advance(ow, 122);
    }
    advance(ow, 1600);
    const payout = trainerPayout(g.data.trainers!.OPP_YOUNGSTER, party);
    expect(wins).toBe(1); expect(g.save.money).toBe(money + payout); expect(mon.exp).toBeGreaterThan(xp);
    expect(g.save.flags.FIELD_TEST_WIN).toBe(true); expect(ow.fieldTrainerActive).toBe(false);
    advance(ow, 300); expect(wins).toBe(1); expect(g.save.money).toBe(money + payout);
  });
  test("trainer Pokémon remain on indoor floor and cannot vanish from the actor budget", () => {
    const { g, ow } = game("PEWTER_GYM");
    ow.player.cellX = 4; ow.player.cellY = 10; ow.player.px = 64; ow.player.py = 160;
    g.pushTrainerBattle("BROCK", "OPP_BROCK", [{ species: "ONIX", level: 14 }], () => {});
    const w = ow.wild.slots.find(w => w.active)!;
    expect(w).toBeDefined();
    w.attackCooldown = 10000;
    advance(ow, 100);
    expect(w.active).toBe(true); expect(w.trainerOwned).toBe(true);
    expect(ow.wild.slots.filter(w => w.active)).toHaveLength(1);
  });
  test("aborting a trainer fight grants neither victory nor money", () => {
    const { g, ow } = game(); let wins = 0; const money = g.save.money;
    g.pushTrainerBattle("YOUNGSTER", "OPP_YOUNGSTER", party, () => wins++);
    defeat(ow); ow.stopPokemonPilot();
    expect(wins).toBe(0); expect(g.save.money).toBe(money); expect(ow.fieldTrainerActive).toBe(false);
    expect(ow.wild.slots.some(w => w.active && w.trainerOwned)).toBe(false);
  });
  test("existing map connections work while piloting without adding map content", () => {
    const { g, ow } = game("PALLET_TOWN");
    g.save.flags.EVENT_GOT_STARTER = true;
    ow.player.cellX = 10; ow.player.cellY = 0; ow.player.px = 160; ow.player.py = 0; ow.player.facing = "up";
    const maps = Object.keys(g.data.maps!);
    g.input.setButtons(VOX_BTN.up); g.input.step(); ow.updatePokemonPilot();
    for (let i = 0; i < 90 && ow.map.id === "PALLET_TOWN"; i++) g.tick(0);
    expect(ow.map.id).toBe("ROUTE_1"); expect(ow.pokemonPilot).toBeDefined();
    expect(Object.keys(g.data.maps!)).toEqual(maps);
    expect(new Set(DEFAULT_MAPS).size).toBe(DEFAULT_MAPS.length);
  });
  test("existing Brock dialogue starts a field roster and grants the existing badge/defeat flag", () => {
    const { g, ow } = game("PEWTER_GYM");
    ow.player.cellX = 4; ow.player.cellY = 10; ow.player.px = 64; ow.player.py = 160;
    const brock = ow.npcs.find(n => n.def.name === "PEWTERGYM_BROCK")!;
    ow.talkTo(brock);
    for (let i = 0; i < 1000 && !ow.fieldTrainerActive; i++) g.tick(i % 2 ? 0 : VOX_BTN.a);
    expect(ow.fieldTrainerActive).toBe(true); expect(g.battleView()).toBeNull();
    expect(ow.wild.slots.find(w => w.active)!.species).toBe("GEODUDE");
    defeat(ow); advance(ow, 122);
    expect(ow.wild.slots.find(w => w.active)!.species).toBe("ONIX");
    expect(g.save.flags.EVENT_BEAT_BROCK).not.toBe(true);
    defeat(ow); advance(ow, 1400);
    expect(g.save.flags.EVENT_BEAT_BROCK).toBe(true);
    expect(g.save.inventory.BOULDERBADGE).toBe(1);
  });

  test("reward messages survive attack button-mashing after a kill", () => {
    const { g, ow } = game();
    const w = ow.wild.slots[0]!; const mon = newMon(g.data, "RATTATA", 4);
    Object.assign(w, { active: true, species: "RATTATA", level: 4, mon, hp: 0 });
    (ow as any).finishFieldOpponent(w, 0);
    const text = ow.pokemonAttackMessage;
    expect(text).toMatch(/^\+\d+ EXP RATTATA/);
    for (let i = 0; i < 120; i++) { g.input.setButtons(i % 2 ? 0 : VOX_BTN.a); g.input.step(); ow.updatePokemonPilot(); }
    expect(ow.pokemonAttackMessage).toBe(text);
  });

  test("existing stairs work in field mode and retain the selected Pokémon", () => {
    const { g, ow } = game("REDS_HOUSE_2F");
    ow.player.cellX = 7; ow.player.cellY = 2; ow.player.px = 112; ow.player.py = 32; ow.player.facing = "up";
    g.input.setButtons(VOX_BTN.up);
    for (let i = 0; i < 24; i++) { g.input.step(); ow.updatePokemonPilot(); }
    for (let i = 0; i < 90 && ow.map.id === "REDS_HOUSE_2F"; i++) g.tick(0);
    expect(ow.map.id).toBe("REDS_HOUSE_1F");
    expect(ow.pokemonPilot!.monIndex).toBe(0);
  });

  test("all imported trainer parties on the cooked maps have usable Pokémon and moves", () => {
    const { g } = game(); let trainers = 0;
    for (const mapId of DEFAULT_MAPS) {
      const map = g.data.maps![mapId]; expect(map).toBeDefined();
      for (const obj of map!.objects) {
        if (!obj.trainerClass || !obj.trainerParty) continue;
        const party = g.data.trainers?.[obj.trainerClass]?.parties[obj.trainerParty - 1];
        expect(party?.length).toBeGreaterThan(0);
        for (const member of party!) {
          const mon = newMon(g.data, member.species, member.level);
          expect(mon.hp).toBeGreaterThan(0);
          expect(mon.moves.length).toBeGreaterThan(0);
          for (const move of mon.moves) expect(g.data.moves[move.id]).toBeDefined();
        }
        trainers++;
      }
    }
    expect(trainers).toBeGreaterThan(50);
  });

  for (const mapId of DEFAULT_MAPS.filter(id => runtime?.encounters[id]?.grass?.rate)) {
    test(`${mapId}: natural field encounters spawn with the complete NPC population`, () => {
      const { g, ow } = game(mapId);
      // Use real map collision/habitat and all map actors, including objects
      // outside the camera. Pick a patch with room for the spawn radius.
      let best: [number, number] | undefined;
      let score = 0;
      for (let y = 0; y < ow.map.def.height * 2; y++) {
        for (let x = 0; x < ow.map.def.width * 2; x++) {
          if (!ow.map.isWalkableCell(x, y) || ow.map.warpAtCell(x, y) || ow.npcAtCell(x, y)) continue;
          let count = 0;
          for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < 3) continue;
            if (ow.wild.habitatAt(g.data, ow.map, x + dx, y + dy) === "grass" && !ow.npcAtCell(x + dx, y + dy)) count++;
          }
          if (count > score) { score = count; best = [x, y]; }
        }
      }
      expect(best).toBeDefined();
      ow.player.cellX = best![0]; ow.player.cellY = best![1];
      ow.player.px = best![0] * 16; ow.player.py = best![1] * 16;
      for (let tick = 0; tick < 1800 && !ow.wild.slots.some(w => w.active); tick++) ow.updatePokemonPilot();
      const wild = ow.wild.slots.find(w => w.active);
      expect(wild).toBeDefined();
      expect(g.data.encounters[mapId]!.grass!.slots).toContainEqual({ species: wild!.species, level: wild!.level });
      expect(wild!.mon!.hp).toBeGreaterThan(0);
      expect(wild!.mon!.moves.length).toBeGreaterThan(0);
      for (const move of wild!.mon!.moves) expect(g.data.moves[move.id]).toBeDefined();
      expect(g.battleView()).toBeNull();
    });
  }

  test("trainer approach scripts finish while the player remains in field mode", () => {
    const { g, ow } = game("ROUTE_3");
    const npc = ow.npcs.find(n => n.def.trainerClass)!;
    expect(npc).toBeDefined();
    let arrived = false;
    // Exercise the real script movement completion path used by trainer sight.
    ow.map.isWalkableCell = () => true;
    npc.frozen = true;
    const start = npc.cellY;
    ow.scriptMove(npc, "down", 1, () => {
      arrived = true;
      const party = g.data.trainers![npc.def.trainerClass!]!.parties[npc.def.trainerParty! - 1]!;
      g.pushTrainerBattle("TRAINER", npc.def.trainerClass!, party, () => {});
    });
    advance(ow, 90);
    expect(arrived).toBe(true); expect(npc.cellY).toBe(start + 1);
    expect(ow.fieldTrainerActive).toBe(true);
    expect(ow.wild.slots.filter(w => w.active && w.trainerOwned)).toHaveLength(1);
  });

});
