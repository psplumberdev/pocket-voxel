import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadRuntimeData, REQUIRED_MODULES } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { chapterDoors, doorOpen, SAFFRON_GATES, type ChapterField } from "../voxelmon/shared/chapter.ts";
import { loadGen } from "../voxelmon/cook/data-node.ts";
import { chapterStamp } from "../voxelmon/cook/chapter-stamps.ts";
import { GameMap as CookMap } from "../voxelmon/cook/data.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const gen = `${import.meta.dir}/../dist/voxelmon/gen`;
const available = REQUIRED_MODULES.every(id => existsSync(`${gen}/${id}.json`));
const data = available ? await loadRuntimeData(gen) : null;
function game() {
  const g = new VoxelmonGame(data!, new RecorderHost(), 12); g.newGame(); g.chooseStarter("SQUIRTLE");
  g.showText = (_text, done) => done?.();
  g.pushWarpFade = (_frames, midpoint, done) => { midpoint(); done?.(); };
  return g;
}
function talk(g: VoxelmonGame, name: string) {
  const npc = g.overworld.npcs.find(n => n.def.name === name); expect(npc).toBeDefined(); g.overworld.talkTo(npc!);
}
function face(g: VoxelmonGame, x: number, y: number) {
  const p = g.overworld.player; p.cellX = x; p.cellY = y + 1; p.px = x * 16; p.py = (y + 1) * 16; p.facing = "up";
}
function sign(g: VoxelmonGame, text: string) {
  const sign = g.overworld.map.def.signs.find(s => s.text === text)!; expect(sign).toBeDefined(); face(g, sign.x, sign.y); g.overworld.interact();
}
function winBattles(g: VoxelmonGame) { g.pushTrainerBattle = (_name, _klass, _party, win) => win(); }

 describe.skipIf(!available)("Lavender chapter mechanics", () => {
  test("every Card Key door closes, unlocks without consuming the key, and survives reload", () => {
    const g = game();
    for (const [id, doors] of Object.entries((data!.field as ChapterField).cardKeyDoors!.closedDoors!)) {
      if (!id.startsWith("SILPH_CO_")) continue;
      for (const door of doors) {
        g.overworld.setMap(id, door.bx * 2, door.by * 2 + 2);
        expect(g.overworld.map.blockAt(door.bx, door.by)).toBe(door.block);
        face(g, door.bx * 2, door.by * 2); g.overworld.interact();
        expect(doorOpen(door, g.save.flags)).toBe(false);
        g.save.inventory.CARD_KEY = 1; g.overworld.interact();
        expect(g.overworld.map.blockAt(door.bx, door.by)).toBe(door.open);
        expect(g.overworld.map.removedStamps.has(`${door.bx * 2},${door.by * 2}`)).toBe(true);
        expect(g.save.inventory.CARD_KEY).toBe(1);
        const saved = JSON.parse(JSON.stringify(g.save)); Object.assign(g.save, saved);
        g.overworld.setMap(id, 0, 0);
        expect(g.overworld.map.blockAt(door.bx, door.by)).toBe(door.open);
        delete g.save.inventory.CARD_KEY;
      }
    }
  });

  test("poster requires the guard victory, reveals walkable stairs, and persists", () => {
    const g = game(); g.overworld.setMap("GAME_CORNER", 9, 6); const poster = (data!.field as ChapterField).gameCornerPoster!;
    expect(g.overworld.map.blockAt(poster.x, poster.y)).toBe(poster.closedBlock);
    sign(g, poster.posterText); expect(g.save.flags[poster.event]).toBeFalsy();
    winBattles(g); talk(g, "GAMECORNER_ROCKET"); sign(g, poster.posterText);
    expect(g.save.flags[poster.event]).toBe(true);
    expect(g.overworld.map.blockAt(poster.x, poster.y)).toBe(poster.openBlock);
    g.overworld.setMap("GAME_CORNER", 17, 4);
    expect(g.overworld.npcs.some(n => n.def.name === "GAMECORNER_ROCKET")).toBe(false);
    g.overworld.takeWarp(g.overworld.map.def.warps[2]); expect(g.overworld.map.id).toBe("ROCKET_HIDEOUT_B1F");
  });

  test("Lift Key drops after winning and talking; full bag retains it; Scope appears immediately", () => {
    const g = game(); g.overworld.setMap("ROCKET_HIDEOUT_B4F", 10, 10);
    expect(g.overworld.npcs.some(n => n.def.name === "ROCKETHIDEOUTB4F_LIFT_KEY")).toBe(false);
    g.pushTrainerBattle = () => {}; talk(g, "ROCKETHIDEOUTB4F_ROCKET3");
    expect(g.save.flags.EVENT_ROCKET_DROPPED_LIFT_KEY).toBeFalsy();
    winBattles(g); talk(g, "ROCKETHIDEOUTB4F_ROCKET3"); talk(g, "ROCKETHIDEOUTB4F_ROCKET3");
    g.save.inventory = Object.fromEntries(Array.from({length: 20}, (_, i) => [`FILL_${i}`, 1]));
    talk(g, "ROCKETHIDEOUTB4F_LIFT_KEY"); expect(g.save.inventory.LIFT_KEY).toBeUndefined();
    g.save.inventory = {}; talk(g, "ROCKETHIDEOUTB4F_LIFT_KEY"); expect(g.save.inventory.LIFT_KEY).toBe(1);
    const door = chapterDoors(data!.field as ChapterField, g.overworld.map.id)[0];
    talk(g, "ROCKETHIDEOUTB4F_ROCKET1"); expect(g.overworld.map.blockAt(door.bx, door.by)).toBe(door.block);
    talk(g, "ROCKETHIDEOUTB4F_ROCKET2"); expect(g.overworld.map.blockAt(door.bx, door.by)).toBe(door.open);
    talk(g, "ROCKETHIDEOUTB4F_GIOVANNI"); talk(g, "ROCKETHIDEOUTB4F_SILPH_SCOPE");
    expect(g.save.inventory.SILPH_SCOPE).toBe(1);
  });

  for (const [id, panel, source, target] of [
    ["SILPH_CO_ELEVATOR", "TEXT_SILPHCOELEVATOR_ELEVATOR", "SILPH_CO_5F", "SILPH_CO_11F"],
    ["ROCKET_HIDEOUT_ELEVATOR", "TEXT_ROCKETHIDEOUTELEVATOR", "ROCKET_HIDEOUT_B1F", "ROCKET_HIDEOUT_B4F"],
    ["CELADON_MART_ELEVATOR", "TEXT_CELADONMARTELEVATOR", "CELADON_MART_1F", "CELADON_MART_5F"],
  ]) test(`${id} panel selects a floor, cancellation preserves the origin, both exits agree`, () => {
    const g = game(); g.overworld.setMap(source, 0, 0);
    g.overworld.takeWarp(g.overworld.map.def.warps.find(w => w.destMap === id)!);
    let labels: readonly string[] = []; let select: (n: number) => void = () => {};
    g.showMenuChoice = (_text, list, cb) => { labels = list; select = cb; };
    if (id === "ROCKET_HIDEOUT_ELEVATOR") { sign(g, panel); expect(labels).toEqual([]); g.save.inventory.LIFT_KEY = 1; }
    sign(g, panel); expect(labels.at(-1)).toBe("CANCEL"); select(labels.length - 1);
    expect(g.save.elevatorFloors?.[id]).toBe(source);
    sign(g, panel); select(labels.indexOf(target.split("_").at(-1)!));
    expect(g.overworld.map.id).toBe(id);
    for (const warp of data!.maps![id].warps) {
      g.overworld.setMap(id, 1, 2); g.overworld.takeWarp(warp); expect(g.overworld.map.id).toBe(target);
    }
  });

  test("all Hideout spinner paths land at the extracted endpoints and release controls", () => {
    const g = game();
    for (const id of ["ROCKET_HIDEOUT_B2F", "ROCKET_HIDEOUT_B3F"]) {
      for (const spinner of (data!.field as ChapterField).spinners![id]) {
        g.overworld.setMap(id, spinner.x, spinner.y); g.overworld.npcs = []; g.overworld.entities = [g.overworld.player];
        let x = spinner.x, y = spinner.y;
        for (const move of spinner.moves) { x += move.dir === "right" ? move.count : move.dir === "left" ? -move.count : 0; y += move.dir === "down" ? move.count : move.dir === "up" ? -move.count : 0; }
        g.overworld.onStepComplete();
        for (let i = 0; i < 3000 && (g.overworld.scriptMoves.length || g.overworld.player.moving); i++) g.overworld.update();
        expect([g.overworld.player.cellX, g.overworld.player.cellY]).toEqual([x, y]);
        expect(g.overworld.scriptMoves.length).toBe(0);
      }
    }
  });

  test("Tower purified zone heals once until leaving and suppresses encounters", () => {
    const g = game(); g.overworld.setMap("POKEMON_TOWER_5F", 10, 8); const mon = g.save.party[0];
    mon.hp = 1; g.overworld.onStepComplete(); expect(mon.hp).toBe(mon.stats.hp);
    mon.hp = 2; g.overworld.player.cellY = 9; g.overworld.onStepComplete(); expect(mon.hp).toBe(2);
    g.overworld.player.cellY = 10; g.overworld.onStepComplete(); g.overworld.player.cellY = 9; g.overworld.onStepComplete(); expect(mon.hp).toBe(mon.stats.hp);
    expect(g.overworld.wild.slots.some(w => w.active)).toBe(false);
  });

  for (const [id, gate] of Object.entries(SAFFRON_GATES)) test(`${id} blocks without a drink and shares one drink flag with every guard`, () => {
    const g = game(); const [x, y] = gate.cells[0]; g.overworld.setMap(id, x, y, gate.horizontal ? "left" : "up");
    g.overworld.onStepComplete(); expect(g.overworld.scriptMoves.length).toBeGreaterThan(0);
    g.overworld.scriptMoves.length = 0; g.save.inventory.FRESH_WATER = 2;
    g.overworld.onStepComplete(); expect(g.save.inventory.FRESH_WATER).toBe(1); expect(g.save.flags.EVENT_GAVE_GUARDS_DRINK).toBe(true);
    for (const [other, trigger] of Object.entries(SAFFRON_GATES)) {
      g.overworld.setMap(other, ...trigger.cells[0]); g.overworld.onStepComplete();
      expect(g.save.inventory.FRESH_WATER).toBe(1); expect(g.overworld.scriptMoves.length).toBe(0);
    }
  });

  test("roof vending machines offer the three guard drinks at their ROM prices", () => {
    const g = game(); g.overworld.setMap("CELADON_MART_ROOF", 10, 2); let stock: unknown;
    g.openMart = items => { stock = items; }; sign(g, "TEXT_CELADONMARTROOF_VENDING_MACHINE1");
    expect(stock).toEqual([{item: "FRESH_WATER", price: 200}, {item: "SODA_POP", price: 300}, {item: "LEMONADE", price: 350}]);
  });

  test("closed-door stamp geometry is textured, nonempty, and keyed to the runtime block", () => {
    const raw = loadGen(gen);
    for (const id of ["GAME_CORNER", "SILPH_CO_2F", "SILPH_CO_11F", "ROCKET_HIDEOUT_B4F"]) {
      const def = raw.maps[id]; const map = new CookMap(def, raw.tilesets[def.tileset]);
      for (const door of chapterDoors(data!.field as ChapterField, id)) {
        const stamp = chapterStamp(map, door, {baseX: 0, baseY: 0, pageW: 256, pageH: 256});
        expect([stamp.cx, stamp.cy]).toEqual([door.bx * 2, door.by * 2]); expect(stamp.mesh.indices.length).toBeGreaterThan(0);
        expect(stamp.mesh.verts.every(v => Number.isFinite(v.u) && Number.isFinite(v.v))).toBe(true);
      }
    }
  });

  for (const scope of [false, true]) test(`Tower ghost battle with scope=${scope} cannot be caught; victory alone clears gate`, () => {
    const g = game(); if (scope) g.save.inventory.SILPH_SCOPE = 1;
    g.overworld.setMap("POKEMON_TOWER_6F", 10, 16); g.overworld.onStepComplete();
    const b = g.battleView()!.battle;
    expect(b.enemy.mon.species).toBe("MAROWAK"); expect(b.enemy.mon.level).toBe(30); expect(b.ghost).toBe(!scope); expect(b.noCatch).toBe(true);
    b.throwBall("MASTER_BALL"); expect(b.queue.some(row => row.text?.includes("dodged"))).toBe(true);
    expect(g.save.flags.EVENT_BEAT_GHOST_MAROWAK).toBeFalsy();
    b.finished = "run"; g.tick(0); expect(g.save.flags.EVENT_BEAT_GHOST_MAROWAK).toBeFalsy();
    g.overworld.scriptMoves.length = 0; g.overworld.setMap("POKEMON_TOWER_6F", 10, 16); g.overworld.onStepComplete();
    const win = g.battleView()!.battle; win.finished = "win"; g.tick(0);
    expect(g.save.flags.EVENT_BEAT_GHOST_MAROWAK).toBe(true);
  });

  test("Poke Doll escape clears the ghost gate without a Scope", () => {
    const g = game(); g.save.inventory.POKE_DOLL = 1;
    g.overworld.setMap("POKEMON_TOWER_6F", 10, 16); g.overworld.onStepComplete();
    const b = g.battleView()!.battle; b.queue = []; b.openItems(); b.itemIndex = b.itemList.indexOf("POKE_DOLL");
    g.input.setButtons(VOX_BTN.a); g.input.step(); b.update(g.input);
    expect(b.pokeDollEscape).toBe(true); expect(g.save.inventory.POKE_DOLL).toBeUndefined();
    b.finished = "run"; g.tick(0); expect(g.save.flags.EVENT_BEAT_GHOST_MAROWAK).toBe(true);
  });
  test("actual collision and warp routes reach keys, bosses, gifts and Sabrina in chapter order", () => {
    const g = game();
    // Flood real collision cells, applying spinner destinations and reciprocal
    // elevator exits. Ordinary trainers are considered beatable; NPC occupancy
    // is covered separately by controller tests.
    const reaches = (start: [string, number, number], mapId: string, objectName: string, key = false) => {
      const maps = new Map<string, ReturnType<typeof game>["overworld"]["map"]>();
      const get = (id: string) => {
        let map = maps.get(id); if (map) return map;
        g.overworld.setMap(id, 0, 0); map = g.overworld.map;
        if (key) for (const door of chapterDoors(data!.field as ChapterField, id)) {
          if (id.startsWith("SILPH_CO_")) map.setChapterBlock(door.bx, door.by, door.open, true);
        }
        maps.set(id, map); return map;
      };
      const object = data!.maps![mapId].objects.find(o => o.name === objectName)!;
      expect(object).toBeDefined();
      const queue = [start]; const seen = new Set<string>();
      const add = (id: string, x: number, y: number) => { const k = `${id}/${x}/${y}`; if (!seen.has(k)) { seen.add(k); queue.push([id, x, y]); } };
      for (let i = 0; i < queue.length && i < 30000; i++) {
        const [id, x, y] = queue[i]; const map = get(id);
        if (id === mapId && Math.abs(x - object.x) + Math.abs(y - object.y) === 1) return true;
        const spinner = (data!.field as ChapterField).spinners?.[id]?.find(s => s.x === x && s.y === y);
        if (spinner) {
          let sx = x, sy = y; for (const move of spinner.moves) {
            sx += move.dir === "left" ? -move.count : move.dir === "right" ? move.count : 0;
            sy += move.dir === "up" ? -move.count : move.dir === "down" ? move.count : 0;
          }
          add(id, sx, sy); continue;
        }
        const warp = map.warpAtCell(x, y)?.def;
        if (warp && data!.maps![warp.destMap] && warp.destMap !== "LAST_MAP") {
          if (warp.destMap.endsWith("_ELEVATOR")) {
            const liftAllowed = warp.destMap !== "ROCKET_HIDEOUT_ELEVATOR" || !!g.save.inventory.LIFT_KEY;
            if (liftAllowed) for (const floor of Object.values(data!.maps!)) for (const exit of floor.warps) {
              if (exit.destMap === warp.destMap) add(floor.id, exit.x, exit.y);
            }
          } else {
            const exit = data!.maps![warp.destMap].warps[warp.destWarp - 1];
            if (exit) add(warp.destMap, exit.x, exit.y);
          }
        }
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          if (map.inBounds(x + dx, y + dy) && map.isWalkableCell(x + dx, y + dy)) add(id, x + dx, y + dy);
        }
      }
      return false;
    };
    g.save.flags.EVENT_FOUND_ROCKET_HIDEOUT = true;
    expect(reaches(["ROCKET_HIDEOUT_B1F", 23, 2], "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_ROCKET3")).toBe(true);
    g.save.inventory.LIFT_KEY = 1;
    g.save.flags.EVENT_BEAT_ROCKET_HIDEOUT_4_TRAINER_0 = true;
    g.save.flags.EVENT_BEAT_ROCKET_HIDEOUT_4_TRAINER_1 = true;
    expect(reaches(["ROCKET_HIDEOUT_B1F", 23, 2], "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_GIOVANNI")).toBe(true);
    expect(reaches(["SILPH_CO_1F", 10, 17], "SILPH_CO_5F", "SILPHCO5F_CARD_KEY")).toBe(true);
    expect(reaches(["SILPH_CO_1F", 10, 17], "SILPH_CO_7F", "SILPHCO7F_RIVAL", true)).toBe(true);
    expect(reaches(["SILPH_CO_1F", 10, 17], "SILPH_CO_7F", "SILPHCO7F_SILPH_WORKER_M1", true)).toBe(true);
    expect(reaches(["SILPH_CO_1F", 10, 17], "SILPH_CO_11F", "SILPHCO11F_GIOVANNI", true)).toBe(true);
    expect(reaches(["SAFFRON_GYM", 8, 15], "SAFFRON_GYM", "SAFFRONGYM_SABRINA")).toBe(true);
  });

});
