import { expect, test } from "bun:test";
import {
  OVERWORLD_ATTACK_COOLDOWN,
  OVERWORLD_ATTACK_SPECIES,
  isOverworldAttackSpecies,
  overworldAttacksFor,
} from "../voxelmon/game/world/overworld-attack.ts";

test("field pilots include Pokédex 001–050 and retain Onix", () => {
  expect(OVERWORLD_ATTACK_SPECIES).toHaveLength(51);
  for (const species of ["BULBASAUR", "RATTATA", "CLEFAIRY", "VENOMOTH", "DIGLETT", "ONIX"]) {
    expect(isOverworldAttackSpecies(species)).toBe(true);
  }
  expect(isOverworldAttackSpecies("MEWTWO")).toBe(false);
});

test("action sheet overrides contact delivery independently of damage category", () => {
  const attacks = overworldAttacksFor("VENUSAUR", [
    { id: "PETAL_DANCE" }, { id: "LEECH_LIFE" }, { id: "TWINEEDLE" },
    { id: "POISON_STING" }, { id: "RAZOR_LEAF" }, { id: "GROWL" },
  ]);
  expect(attacks.map(a => a.kind)).toEqual(["ranged", "melee", "ranged", "ranged", "ranged", "ranged"]);
  expect(attacks.map(a => a.speed)).toEqual([2, 0, 2, 2, 2, 2]);
  expect(OVERWORLD_ATTACK_COOLDOWN).toBe(180);
  expect(overworldAttacksFor("PIKACHU")).toEqual([]);
});

test("field move list preserves only the selected Pokémon's learned slots and order", () => {
  const attacks = overworldAttacksFor("PIKACHU", [
    { id: "THUNDERSHOCK" },
    { id: "GROWL" },
  ], {
    THUNDERSHOCK: { name: "THUNDER SHOCK", power: 40 },
    GROWL: { name: "GROWL", power: 0 },
  });
  expect(attacks.map(attack => attack.id)).toEqual(["THUNDERSHOCK", "GROWL"]);
  expect(attacks.map(attack => attack.name)).toEqual(["THUNDER SHOCK", "GROWL"]);
  expect(attacks[0]?.kind).toBe("ranged");
  expect(attacks[1]?.kind).toBe("ranged");
});

import { fixtureData } from "./fixtures/voxelmon/fixture-data.ts";
import { FieldBattle } from "../voxelmon/game/world/field-battle.ts";
import { WildBattle } from "../voxelmon/game/battle/battle.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { seededRng } from "../voxelmon/game/rng.ts";

test("field moves match battle-screen damage, accuracy, criticals, status and PP", () => {
  const data = fixtureData();
  data.moves.FIELD_GROWL = { ...data.moves.FIX_TACKLE!, id: "FIELD_GROWL", power: 0, effect: "ATTACK_DOWN1_EFFECT" };
  data.moves.FIELD_DOUBLE = { ...data.moves.FIX_TACKLE!, id: "FIELD_DOUBLE", effect: "TWO_TO_FIVE_ATTACKS_EFFECT" };
  for (const id of ["FIX_TACKLE", "FIX_EMBERISH", "FIELD_GROWL", "FIELD_DOUBLE"]) {
    for (let seed = 1; seed <= 32; seed++) {
      const makeSave = () => {
        const mon = newMon(data, "FIXMON_A", 20);
        mon.hp = mon.stats.hp = 500;
        mon.moves = [{ id, pp: 20 }];
        return { party: [mon], inventory: {}, player: { name: "RED", rival: "BLUE" } };
      };
      const normal = new WildBattle(data, makeSave(), seededRng(seed), "FIXMON_A", 20);
      const field = new FieldBattle(data, makeSave(), seededRng(seed), "FIXMON_A", 20);
      for (const battle of [normal, field]) battle.enemy.mon.hp = battle.enemy.mon.stats.hp = 500;
      normal.executeAction(normal.player, normal.enemy, normal.player.curMoves[0]!);
      let frames = 0;
      while (normal.updateQueue({ isDown: () => true, wasPressed: () => true })) {
        if (++frames > 10000) throw new Error("battle queue did not drain");
      }
      field.resolveFieldAction(field.player, field.enemy, field.player.curMoves[0]!);
      expect(field.player.mon).toEqual(normal.player.mon);
      expect(field.enemy.mon).toEqual(normal.enemy.mon);
      expect(field.enemy.stages).toEqual(normal.enemy.stages);
    }
  }
});

test("wild field opponents choose only moves learned at their own level", () => {
  const data = fixtureData();
  const mon = newMon(data, "FIXMON_A", 20);
  const battle = new FieldBattle(data, { party: [mon], inventory: {}, player: { name: "RED", rival: "BLUE" } }, seededRng(7), "FIXMON_A", 7);
  const choices = new Set(Array.from({ length: 100 }, () => battle.enemyAction().id));
  expect([...choices].sort()).toEqual(["FIX_EMBERISH", "FIX_TACKLE"]);
});

test("field poison and burn tick every 300 logic ticks, independent of attacks", () => {
  for (const status of ["PSN", "BRN"]) {
    const data = fixtureData();
    const mon = newMon(data, "FIXMON_A", 20);
    mon.hp = mon.stats.hp = 160; mon.status = status;
    const battle = new FieldBattle(data, { party: [mon], inventory: {}, player: { name: "RED", rival: "BLUE" } }, seededRng(7), "FIXMON_A", 20);
    for (let i = 0; i < 299; i++) battle.tickStatus(battle.player);
    expect(mon.hp).toBe(160);
    battle.residualFor(battle.player, battle.enemy);
    expect(mon.hp).toBe(160);
    battle.tickStatus(battle.player);
    expect(mon.hp).toBe(150);
    for (let i = 0; i < 300; i++) battle.tickStatus(battle.player);
    expect(mon.hp).toBe(140);
  }
});

test("field sleep checks only every five seconds, never from attack attempts", () => {
  const data = fixtureData();
  const mon = newMon(data, "FIXMON_A", 20);
  mon.status = "SLP";
  const battle = new FieldBattle(data, { party: [mon], inventory: {}, player: { name: "RED", rival: "BLUE" } }, seededRng(7), "FIXMON_A", 20);
  battle.player.sleepTurns = 2;
  const pp = mon.moves[0]!.pp;
  for (let i = 0; i < 299; i++) {
    battle.resolveFieldAction(battle.player, battle.enemy, mon.moves[0]!);
    battle.tickStatus(battle.player);
  }
  expect(battle.player.sleepTurns).toBe(2);
  expect(mon.moves[0]!.pp).toBe(pp);
  battle.tickStatus(battle.player);
  expect(battle.player.sleepTurns).toBe(1);
  expect(mon.status).toBe("SLP");
  for (let i = 0; i < 300; i++) battle.tickStatus(battle.player);
  expect(mon.status).toBeNull();
});

test("Leech Seed drains on five-second ticks and heals its original user", () => {
  const data = fixtureData();
  data.moves.FIELD_SEED = { ...data.moves.FIX_TACKLE!, id: "FIELD_SEED", power: 0, accuracy: 100, effect: "LEECH_SEED_EFFECT" };
  const mon = newMon(data, "FIXMON_A", 20);
  mon.hp = 50; mon.stats.hp = 160;
  mon.moves = [{ id: "FIELD_SEED", pp: 20 }];
  const battle = new FieldBattle(data, { party: [mon], inventory: {}, player: { name: "RED", rival: "BLUE" } }, seededRng(7), "FIXMON_A", 20);
  battle.enemy.curTypes = ["NORMAL"];
  battle.enemy.mon.hp = battle.enemy.mon.stats.hp = 160;
  for (let i = 0; i < 10 && !battle.enemy.leechSeeded; i++) battle.resolveFieldAction(battle.player, battle.enemy, mon.moves[0]!);
  expect(battle.enemy.leechSeeded).toBe(true);
  expect(mon.hp).toBe(50);
  for (let i = 0; i < 299; i++) battle.tickStatus(battle.enemy);
  expect(battle.enemy.mon.hp).toBe(160);
  battle.tickStatus(battle.enemy);
  expect(battle.enemy.mon.hp).toBe(150);
  expect(mon.hp).toBe(60);
  mon.hp = 159;
  for (let i = 0; i < 300; i++) battle.tickStatus(battle.enemy);
  expect(mon.hp).toBe(160);
});
