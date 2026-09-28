import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { FIELD_MOVES, fieldCells } from "../voxelmon/game/world/field-moves.ts";
import { FieldBattle } from "../voxelmon/game/world/field-battle.ts";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { fixedRng } from "../voxelmon/game/rng.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { Scene } from "../voxelmon/game/scene.ts";
import { ENT_FLAG, VOX_OP, VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";

const gen = `${import.meta.dir}/../dist/voxelmon/gen`;
const data = existsSync(`${gen}/pokemon.json`) ? await loadRuntimeData(gen) : null;

test("five-square melee includes sides and excludes all three rear cells in every facing", () => {
  for (const [dir, dx, dy] of [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]] as const) {
    const cells = fieldCells(5, 5, dir, "melee");
    expect(cells).toHaveLength(5);
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      expect(cells.some(([cx, cy]) => cx === 5+x && cy === 5+y)).toBe((x !== 0 || y !== 0) && x*dx + y*dy >= 0);
    }
  }
  expect(fieldCells(0, 0, "right", "forward")).toEqual([[1,0],[2,0],[3,0],[4,0]]);
  expect(fieldCells(0, 0, "up", "self")).toContainEqual([-3, 0]);
  expect(fieldCells(0, 0, "up", "self")).not.toContainEqual([3, 3]);
});

describe.skipIf(!data)("move sheet v4", () => {
  function battle() {
    const mon = newMon(data!, "IVYSAUR", 30);
    const save = { party: [mon], inventory: {}, player: { name: "RED", rival: "BLUE" } };
    const b = new FieldBattle(data!, save, fixedRng(100), "RATTATA", 30);
    for (const actor of [b.player, b.enemy]) { actor.mon.hp = actor.mon.stats.hp = 1000; actor.curTypes = ["NORMAL"]; }
    b.accuracyRoll = () => true;
    return b;
  }
  function use(b: FieldBattle, id: string) { return b.resolveFieldAction(b.player, b.enemy, { id, pp: 20 }); }
  function ticks(b: FieldBattle, n: number, enemy = false) { for (let i = 0; i < n; i++) b.tickStatus(enemy ? b.enemy : b.player); }

  test("every imported Gen I move has the requested delivery rule", () => {
    expect(Object.keys(FIELD_MOVES)).toHaveLength(165);
    for (const move of Object.values(data!.moves).filter(m => m.index >= 1 && m.index <= 165)) expect(FIELD_MOVES[move.id]).toBeDefined();
    expect(FIELD_MOVES.TELEPORT).toMatchObject({ delivery: "ranged", target: "enemy", range: 15 });
    expect(FIELD_MOVES.VINE_WHIP!.delivery).toBe("ranged");
    expect(FIELD_MOVES.PETAL_DANCE!.delivery).toBe("ranged");
    expect(FIELD_MOVES.DOUBLESLAP!.cooldown).toBe(60);
    expect(FIELD_MOVES.TACKLE!.cooldown).toBe(180);
  });

  test("Teleport deals damage without fleeing and never changes normal battle definitions", () => {
    const original = JSON.stringify(data!.moves);
    const b = battle();
    use(b, "TELEPORT");
    expect(b.enemy.mon.hp).toBeLessThan(1000);
    expect(b.result).toBeNull();
    expect(b.data.moves.TELEPORT).toMatchObject({ power: 40, type: "PSYCHIC_TYPE" });
    expect(JSON.stringify(data!.moves)).toBe(original);
    expect(b.data.moves.SAND_ATTACK).toMatchObject({ power: 30, type: "GROUND" });
    expect(b.data.moves.FLASH).toMatchObject({ power: 30, type: "ELECTRIC" });
  });

  test("prototype Counter/Bide/Mirror Move/Substitute all do Tackle damage", () => {
    const baseline = battle(); use(baseline, "TACKLE");
    for (const id of ["COUNTER", "BIDE", "MIRROR_MOVE", "SUBSTITUTE"]) {
      const b = battle(); use(b, id);
      expect(b.enemy.mon.hp).toBe(baseline.enemy.mon.hp);
      expect(b.player.mon.hp).toBe(1000);
      expect(b.player.substituteHP).toBeUndefined();
      expect(b.player.bideTurns).toBeUndefined();
    }
  });

  test("self stat buffs cap at six, refresh, expire, and preserve later debuffs", () => {
    const b = battle();
    for (let n = 0; n < 5; n++) use(b, "SWORDS_DANCE");
    expect(b.player.stages.attack).toBe(6);
    ticks(b, 599);
    use(b, "SWORDS_DANCE");
    ticks(b, 599);
    expect(b.player.stages.attack).toBe(6);
    b.player.stages.attack!--;
    ticks(b, 1);
    expect(b.player.stages.attack).toBe(-1);
  });

  test("healing does not refresh unrelated buffs; screens refresh only on reapplication", () => {
    const b = battle(); use(b, "REFLECT"); use(b, "AGILITY");
    ticks(b, 300); b.player.mon.hp = 500; use(b, "RECOVER"); use(b, "REFLECT");
    ticks(b, 300);
    expect(b.player.stages.speed).toBe(0);
    expect(b.player.reflect).toBe(true);
    ticks(b, 300); expect(b.player.reflect).toBeUndefined();
  });

  test("trap lasts ten seconds and flinch lasts two seconds", () => {
    const b = battle(); use(b, "WRAP");
    expect(b.locked(b.enemy)).toBe(true);
    ticks(b, 599, true); expect(b.locked(b.enemy)).toBe(true);
    ticks(b, 1, true); expect(b.locked(b.enemy)).toBe(false);
    b.rng = fixedRng(0); use(b, "BITE");
    expect(b.locked(b.enemy)).toBe(true);
    ticks(b, 119, true); expect(b.locked(b.enemy)).toBe(true);
    ticks(b, 1, true); expect(b.locked(b.enemy)).toBe(false);
  });

  test("freeze wakes on five-second checks and paralysis reduces movement speed", () => {
    const b = battle(); b.enemy.mon.status = "FRZ"; b.enemy.sleepTurns = 2;
    ticks(b, 300, true); expect(b.locked(b.enemy)).toBe(true);
    ticks(b, 300, true); expect(b.enemy.mon.status).toBeNull();
    b.enemy.mon.status = "PAR"; expect(b.moveTicks(b.enemy, 24)).toBe(96);
    b.enemy.mon.status = null; b.enemy.stages.speed = -2; expect(b.moveTicks(b.enemy, 24)).toBe(48);
  });

  test("Rage stacks to five and expires after ten seconds", () => {
    const b = battle(); b.enemy.mon.hp = b.enemy.mon.stats.hp = 10000;
    const damages: number[] = [];
    for (let i = 0; i < 7; i++) { const hp = b.enemy.mon.hp; use(b, "RAGE"); damages.push(hp - b.enemy.mon.hp); }
    expect(damages[5]).toBeGreaterThan(damages[0]!);
    expect(damages[6]).toBe(damages[5]);
    ticks(b, 600); const hp = b.enemy.mon.hp; use(b, "RAGE"); expect(hp - b.enemy.mon.hp).toBe(damages[0]);
  });

  function game(id: string) {
    const host = new RecorderHost();
    const g = new VoxelmonGame(structuredClone(data!), host, 5);
    g.newGame(); g.chooseStarter("SQUIRTLE");
    const ow = g.overworld; ow.setMap("ROUTE_1", 11, 6, "down"); ow.wild.clear(); ow.wild.update = () => {};
    const mon = newMon(g.data, "IVYSAUR", 30); mon.moves = [{ id, pp: 20 }]; g.save.party = [mon]; ow.startPokemonPilot();
    const b = (ow as any).fieldBattle as FieldBattle; b.accuracyRoll = () => true;
    const fire = () => (ow as any).firePokemonAttack();
    const enemy = (dx: number, dy: number, slot = 0) => {
      const w = ow.wild.slots[slot]!;
      const m = newMon(g.data, "RATTATA", 30); m.hp = m.stats.hp = 1000;
      Object.assign(w, { active: true, rewarded: false, species: "RATTATA", level: 30, icon: "MON", mon: m,
        cellX: ow.player.cellX + dx, cellY: ow.player.cellY + dy,
        px: (ow.player.cellX + dx)*16, py: (ow.player.cellY + dy)*16, timer: 1000, attackCooldown: 10000 });
      return w;
    };
    return { g, ow, mon, fire, enemy, b, host };
  }

  test("Teleport launches visibly for 15 tiles, spends PP once, and does not hit immediately", () => {
    const { ow, fire, mon, enemy } = game("TELEPORT"); const w = enemy(0, 3);
    fire(); expect(ow.pokemonProjectile).toMatchObject({ remaining: 15, stepTicks: 12, move: { id: "TELEPORT" } });
    expect(w.mon!.hp).toBe(1000); expect(mon.moves[0]!.pp).toBe(19);
    for (let i = 0; i < 36; i++) ow.updatePokemonPilot();
    expect(w.mon!.hp).toBeLessThan(1000); expect(ow.pokemonPilot).toBeDefined(); expect(mon.moves[0]!.pp).toBe(19);
  });

  test("front melee damages multiple front/side targets but excludes the rear, one PP", () => {
    const { ow, fire, mon, enemy } = game("TACKLE");
    const front = enemy(0,1), side = enemy(1,0,1), rear = enemy(0,-1,2);
    fire(); expect(front.mon!.hp).toBeLessThan(1000); expect(side.mon!.hp).toBeLessThan(1000); expect(rear.mon!.hp).toBe(1000);
    expect(ow.pokemonMeleeFlashes).toHaveLength(5); expect(mon.moves[0]!.pp).toBe(19);
  });

  test("charge releases once after one second; Skull Bash buffs defense during charge", () => {
    const { ow, fire, mon, enemy, b } = game("SKULL_BASH"); const w = enemy(0,1);
    fire(); expect(b.player.stages.defense).toBe(1); expect(w.mon!.hp).toBe(1000);
    for (let i = 0; i < 59; i++) ow.updatePokemonPilot(); expect(w.mon!.hp).toBe(1000);
    ow.updatePokemonPilot(); expect(w.mon!.hp).toBeLessThan(1000); expect(mon.moves[0]!.pp).toBe(19);
    const hp = w.mon!.hp; for (let i = 0; i < 60; i++) ow.updatePokemonPilot(); expect(w.mon!.hp).toBe(hp);
  });

  test("Whirlwind pushes two tiles without dismissing the enemy", () => {
    const { ow, fire, enemy } = game("WHIRLWIND"); const w = enemy(0,1); const y = w.cellY;
    // Fixture route can contain walls: use a known walkable collision surface.
    ow.map.isWalkableCell = () => true;
    fire(); for (let i = 0; i < 12; i++) ow.updatePokemonPilot();
    expect(w.active).toBe(true); expect(w.cellY).toBe(y + 2); expect(w.mon!.hp).toBe(1000);
  });

  test("four-tile Earthquake strip excludes off-axis and rear targets", () => {
    const { fire, enemy } = game("EARTHQUAKE");
    const a = enemy(0,4), b = enemy(1,2,1), c = enemy(0,-1,2);
    fire(); expect(a.mon!.hp).toBeLessThan(1000); expect(b.mon!.hp).toBe(1000); expect(c.mon!.hp).toBe(1000);
  });

  test("Explosion damages all radius targets before fainting its user", () => {
    const { ow, fire, enemy, mon } = game("EXPLOSION");
    const a = enemy(0,2), b = enemy(0,-2,1), c = enemy(3,3,2);
    fire(); expect(a.mon!.hp).toBeLessThan(1000); expect(b.mon!.hp).toBeLessThan(1000); expect(c.mon!.hp).toBe(1000);
    expect(mon.hp).toBe(0); expect(ow.pokemonPilot).toBeUndefined();
  });
  test("Quick Attack lunges one free tile and hits without crossing a wall", () => {
    const { ow, fire, enemy } = game("QUICK_ATTACK");
    ow.map.isWalkableCell = () => true;
    const y = ow.player.cellY; const w = enemy(0, 2);
    fire(); expect(ow.player.cellY).toBe(y + 1); expect(w.mon!.hp).toBeLessThan(1000);
    ow.pokemonAttackCooldown = 0; ow.map.isWalkableCell = () => false;
    fire(); expect(ow.player.cellY).toBe(y + 1);
  });

  test("multi-hit moves spend one PP and one second cooldown for the whole attack", () => {
    const { ow, fire, enemy, mon } = game("DOUBLE_KICK"); const w = enemy(0, 1);
    fire(); expect(w.mon!.hp).toBeLessThan(1000); expect(mon.moves[0]!.pp).toBe(19);
    expect(ow.pokemonAttackCooldown).toBe(60);
    expect(ow.pokemonAttackMessage).toContain("2 times");
  });

  test("wild enemies use the same Teleport and charge delivery rules", () => {
    for (const id of ["TELEPORT", "SOLARBEAM"]) {
      const { ow, enemy, mon } = game("TACKLE"); const w = enemy(0, 3);
      w.facing = "up"; w.aggro = w.aggressive = true; w.attackCooldown = 0;
      w.mon!.moves = [{ id, pp: 20 }];
      ow.updatePokemonPilot();
      expect(w.mon!.moves[0]!.pp).toBe(19);
      if (id === "SOLARBEAM") {
        expect(ow.pokemonProjectile).toBeUndefined();
        for (let i = 0; i < 60; i++) ow.updatePokemonPilot();
      }
      expect(ow.pokemonProjectile).toMatchObject({ source: w, move: { id }, dy: -1, remaining: id === "TELEPORT" ? 15 : 5 });
      expect(mon.hp).toBeGreaterThan(0);
    }
  });

  test("area shading has space for the full radius as well as actors", () => {
    const { g, ow, fire, host } = game("HAZE"); fire();
    expect(ow.pokemonMeleeFlashes).toHaveLength(29);
    const scene = new Scene(host); scene.emit(g); host.frameDone(0, 0);
    const flashes = host.text().split("\n").filter(line => line.startsWith(`o ${VOX_OP.ent} `) && line.endsWith(` ${ENT_FLAG.melee}`));
    expect(flashes).toHaveLength(29);
  });

  test("turning after launching Roar does not reverse its knockback; walls stop pushback", () => {
    const { ow, fire, enemy } = game("ROAR"); const w = enemy(0, 1); const y = w.cellY;
    ow.map.isWalkableCell = (_x, cy) => cy < y + 2;
    fire(); ow.player.facing = "up";
    for (let i = 0; i < 12; i++) ow.updatePokemonPilot();
    expect(w.cellY).toBe(y + 1);
  });

  test("OHKO, Super Fang, Pay Day and miss recoil use their field rules", () => {
    const b = battle(); use(b, "SUPER_FANG"); expect(b.enemy.mon.hp).toBe(500);
    use(b, "GUILLOTINE"); expect(b.enemy.mon.hp).toBe(0);
    const c = battle(); c.accuracyRoll = () => false; use(c, "JUMP_KICK"); expect(c.player.mon.hp).toBe(999);
    const { g, ow, fire, enemy } = game("PAY_DAY"); enemy(0,1); const money = g.save.money!;
    fire(); for (let i = 0; i < 12; i++) ow.updatePokemonPilot(); expect(g.save.money).toBe(money + 60);
  });

  test("button-mashing cannot bypass melee or Leech Life cooldowns, damage, healing or PP", () => {
    for (const [id, cooldown] of [["TACKLE", 180], ["LEECH_LIFE", 180], ["DOUBLE_KICK", 60]] as const) {
      const { g, ow, enemy, mon } = game(id);
      const w = enemy(0, 1);
      w.mon!.hp = w.mon!.stats.hp = 10000;
      mon.stats.hp = 10000; mon.hp = 1000;
      let attacks = 0;
      for (let tick = 0; tick <= 540; tick++) {
        const hp = w.mon!.hp, ownHp = mon.hp, pp = mon.moves[0]!.pp;
        // Thirty physical press/release cycles per second at 60 logic Hz.
        g.input.setButtons(tick % 2 === 0 ? VOX_BTN.a : 0);
        g.input.step();
        ow.updatePokemonPilot();
        if (tick % cooldown === 0) {
          attacks++;
          expect(mon.moves[0]!.pp).toBe(pp - 1);
          expect(w.mon!.hp).toBeLessThan(hp);
          expect(ow.pokemonAttackCooldown).toBe(cooldown);
          if (id === "LEECH_LIFE") expect(mon.hp).toBeGreaterThan(ownHp);
        } else {
          expect(mon.moves[0]!.pp).toBe(pp);
          expect(w.mon!.hp).toBe(hp);
          expect(mon.hp).toBe(ownHp);
        }
      }
      expect(attacks).toBe(id === "DOUBLE_KICK" ? 10 : 4);
      expect(mon.moves[0]!.pp).toBe(20 - attacks);
    }
  });

  test("holding attack does not auto-repeat and switching moves cannot reset cooldown", () => {
    const { g, ow, enemy, mon } = game("LEECH_LIFE"); enemy(0, 1);
    mon.moves.push({ id: "TACKLE", pp: 20 });
    for (let tick = 0; tick <= 360; tick++) {
      g.input.setButtons(VOX_BTN.a); g.input.step(); ow.updatePokemonPilot();
    }
    expect(mon.moves[0]!.pp).toBe(19);
    g.input.setButtons(0); g.input.step(); ow.updatePokemonPilot();
    g.input.setButtons(VOX_BTN.a); g.input.step(); ow.updatePokemonPilot();
    expect(mon.moves[0]!.pp).toBe(18);
    g.input.setButtons(VOX_BTN.r); g.input.step(); ow.updatePokemonPilot();
    expect(ow.pokemonPilot!.attackIndex).toBe(1);
    g.input.setButtons(VOX_BTN.a); g.input.step(); ow.updatePokemonPilot();
    expect(mon.moves[1]!.pp).toBe(20);
    expect(ow.pokemonAttackCooldown).toBe(178);
  });

});
