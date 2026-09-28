import { chapterDoors, doorOpen, SAFFRON_GATES, DRINKS, type ChapterField } from "../../shared/chapter.ts";
import * as Bag from "../rules/bag.ts";
import { MAX_MONEY, trainerPayout } from "../rules/economy.ts";
import { FIELD_MOVES, fieldCells } from "./field-moves.ts";
import { FieldBattle } from "./field-battle.ts";
import { makeBattler } from "../battle/battler.ts";
import { newMon, type PartyMon, type MoveSlot } from "../battle/mon.ts";
import type { WildSprite } from "./wild.ts";
import { PROJECTILE_IMPACT_LIMIT, PROJECTILE_IMPACT_TICKS } from "../../shared/projectiles.ts";

interface FieldCharge {
  move: MoveSlot & { struggle?: boolean }; source?: WildSprite; sourceMon?: PartyMon;
  facing: Dir; ticks: number;
}
interface FieldProjectile {
  x: number; y: number; dx: number; dy: number; remaining: number;
  name: string; monIndex: number; frame: number; ticks: number; stepTicks: number;
  move: MoveSlot & { struggle?: boolean }; source?: WildSprite; sourceMon?: PartyMon;
}
import { grantItem, GYM_REWARDS } from "./rewards.ts";
import { PartyFollower } from "./follower.ts";
import { trainerHeader } from "./trainers.ts";
import { physicalExit } from "./warp.ts";
import {
  OVERWORLD_ATTACK_COOLDOWN,
  FIELD_LOGIC_HZ,
  FIELD_WALK_TICKS,
  OVERWORLD_PROJECTILE_SPEED,
  MELEE_FLASH_TICKS,
  overworldAttacksFor,
} from "./overworld-attack.ts";
// The overworld controller SLICE. Ports the world-facing core of gen1recomp
// src/world/OverworldController.lua: map entry and connections, grid
// movement, ledges, warps (arrival / collision / edge), NPC wander,
// scripted movement, sign/talk interaction, and the completed-step
// land-triggers with wild-encounter rolls.
//
// UPDATE ORDER MATTERS and mirrors OverworldController.lua:883 update():
// script runner -> emote hold -> NPC wander -> scripted movement -> input
// (gated on scripted/transitioning) -> player animation -> warp-entry
// staleness -> land-triggers (onStepComplete, suppressed on scripted
// steps). Trainer sight, surf, bikes, boulders, spinners, Safari, poison,
// menus and the hand-ported map scripts are outside this slice.

import type { EncounterDef, MapObject, VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { roll as encounterRoll } from "../rules/encounter.ts";
import { WARP_FADE_OUT } from "../rules/timing.ts";
import { canMove, occupied, target, type Dir, type Mover, type TilePairs } from "./collision.ts";
import { defPassable, GameMap, isOutside } from "./map.ts";
import { NPC } from "./npc.ts";
import { WildPopulation } from "./wild.ts";
import { Player } from "./player.ts";
import { talkScript } from "./mapscripts.ts";
import { ScriptRunner, type ScriptWorld } from "./script.ts";
import {
  destination,
  onArrive,
  onCollision,
  onEdge,
  type LastOutdoor,
  type WarpCarpets,
} from "./warp.ts";
import type { MapWarp } from "../data.ts";
import {
  placeDirectNeighbour,
  type ConnectionDirection,
} from "../../shared/connections.ts";

// OverworldController.lua:37
const COMPASS: Record<Dir, "north" | "south" | "east" | "west"> = {
  up: "north",
  down: "south",
  left: "west",
  right: "east",
};

export interface SaveSlice {
  party?: { hp: number; species?: string; nickname?: string; moves?: { id: string }[]; stats?: { hp: number } }[];
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  bagOrder?: string[];
  money?: number;
  player: { name: string; rival: string };
  lastOutdoor?: LastOutdoor;
  silphElevatorFloor?: string;
  elevatorFloors?: Record<string, string>;
  lastHeal?: { map: string; x: number; y: number };
  visitedOutdoor?: Record<string, { x: number; y: number }>;
}

/** What the overworld needs from the game shell (game.ts implements it). */
export interface OverworldShell {
  data: VoxelmonData;
  save: SaveSlice;
  input: {
    isDown(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select" | "l" | "r"): boolean;
    wasPressed(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select" | "l" | "r"): boolean;
  };
  /** Encounter/battle roll stream (the guest owns the RNG). */
  rng: Rng;
  /** NPC wander stream, separate so ambience can't perturb encounters. */
  npcRng: Rng;
  /** Sound.lua:190 play — the field cues the overworld itself triggers. */
  audio: { playSfx(name: string): void };
  /** Pokemon.lua:90 heal over the party (Commands.lua:587 heal_party). */
  healParty(): void;
  /** Music.lua:383 playOnce — a jingle; Music.lua:407 restoreMap after it. */
  playOnce(song: string): void;
  restoreMapMusic(): void;
  /** Music.lua:339 playMap, called where the reference calls it. */
  startMapMusic(mapId: string): void;
  awardFieldExperience(monIndex: number, species: string, level: number, trainer?: boolean): { gained: number; levels: number[] };
  showText(text: string, onDone?: () => void): void;
  showChoice(text: string, choice: (yes: boolean) => void): void;
  showMenuChoice?(text: string, labels: readonly string[], choice: (index: number) => void): void;
  pushGhostBattle?(onWin: () => void, onEscape: () => void): void;
  /** Bedroom OpenRedsPC hidden event, owned by the game-state stack. */
  openBedroomComputer(): void;
  openStartMenu(): void;
  openDaycare?(): void;
  openBikeShop?(): void;
  openFanClub?(): void;
  onFieldStep?(): void;
  chooseStarter(species: "BULBASAUR" | "CHARMANDER" | "SQUIRTLE"): void;
  buyMagikarp(): "bought" | "money" | "party-full" | "already-bought";
  receiveGiftPokemon?(species: string, level: number, event: string): "granted" | "full" | "already";
  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void;
  pushStubBattle(species: string, level: number, onWin?: () => void): void;
  pushTrainerBattle(
    name: string,
    trainerClass: string,
    party: readonly { species: string; level: number }[],
    onWin: () => void,
  ): void;
  openMart(stock: readonly { item: string; price: number }[]): void;
}

interface ScriptMove {
  entity: Player | NPC;
  dir?: Dir;
  remaining: number;
  onDone?: () => void;
  inPlace?: boolean;
}

export interface EmoteHold {
  entity: Player | NPC;
  kind: number;
  frames: number;
  onDone?: () => void;
}

// OverworldController.lua:164 computeNeighbors — walk the connection graph
// `hops` out, composing the strip offsets, deduped by map id (BFS, so a
// direct connection always wins over a two-hop path). Offsets are world
// pixels; connection offsets are in blocks (32 px). The view-reach widening
// (reachW/reachH) is a renderer concern and stays out of the port.
export function computeNeighbors(
  maps: NonNullable<VoxelmonData["maps"]>,
  rootId: string,
  hops: number,
): { id: string; ox: number; oy: number }[] {
  const out: { id: string; ox: number; oy: number }[] = [];
  const rootDef = maps[rootId];
  if (!rootDef) return out;
  const placed = new Set([rootId]);
  const queue: { def: typeof rootDef; ox: number; oy: number; hops: number }[] = [
    { def: rootDef, ox: 0, oy: 0, hops: 0 },
  ];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi];
    qi += 1;
    for (const [dir, conn] of Object.entries(cur.def.connections ?? {})) {
      const destDef = maps[conn.map];
      if (!destDef || placed.has(conn.map)) continue;
      placed.add(conn.map);
      const direct = placeDirectNeighbour(
        dir as ConnectionDirection,
        conn,
        cur.def,
        destDef,
      );
      const ox = direct.ox + cur.ox;
      const oy = direct.oy + cur.oy;
      if (cur.hops + 1 <= hops) {
        out.push({ id: conn.map, ox, oy });
        if (cur.hops + 1 < hops) {
          queue.push({ def: destDef, ox, oy, hops: cur.hops + 1 });
        }
      }
    }
  }
  return out;
}

/** PSP-1000 memory boundary: these two outdoor maps must never coexist. */
export class Overworld implements ScriptWorld {
  /** The content-boundary test: a map outside the pak's cooked set exists
   * as DATA (warp targets, connection math) but must never be entered —
   * the pak has no geometry for it, so warps bump and connections neither
   * show nor cross. Old gamedata without the list means "everything". */
  isCooked(mapId: string): boolean {
    if (mapId === "UNUSED_MAP_ED" && this.map?.id === "SILPH_CO_ELEVATOR") return true;
    if (mapId === "LAST_MAP") return true; // resolves to a map we came from
    const list = this.shell.data.cookedMaps;
    return !list || list.includes(mapId);
  }

  readonly shell: OverworldShell;
  map!: GameMap;
  player!: Player;
  npcs: NPC[] = [];
  readonly wild = new WildPopulation();
  readonly follower = new PartyFollower();
  entities: Mover[] = [];
  runner: ScriptRunner;
  scriptMoves: ScriptMove[] = [];
  emote?: EmoteHold;
  lastOutdoor?: LastOutdoor;
  standingOnWarp = false;
  warpEntryCell?: { x: number; y: number };
  transitioning = false;
  private doorWarp = false;
  private inPurifiedZone = false;
  /** OverworldController.lua:1221 — 16 ticks between wall-bonk cues. */
  private bumpCooldown = 0;
  /** A play_once jingle is in flight (Music.lua:389 pendingRestore). */
  private oneShotPending = false;
  private oakEventRunning = false;
  /** OverworldController.lua:1455 — the map whose theme the seam step owes. */
  pendingSeamMusic: string | null = null;
  private joyLatch?: { a?: boolean };
  private npcPool = new Map<string, NPC>();
  readonly tilePairs: TilePairs;
  readonly carpets?: WarpCarpets;
  /** Battle-port seam bookkeeping the tests and the sim read. */
  encounterCount = 0;
  lastEncounter?: { species: string; level: number };
  /** Active real-time Pokémon pilot, owned by the overworld so movement and
   * target coordinates remain in the same grid as normal map play. */
  pokemonPilot?: { monIndex: number; attackIndex: number };
  pokemonAttackCooldown = 0;
  private attackMessage = "READY";
  private fieldNotices: { text: string; ticks: number }[] = [];
  get pokemonAttackMessage(): string { return this.fieldNotices[0]?.text ?? this.attackMessage; }
  set pokemonAttackMessage(value: string) { this.attackMessage = value; }
  private fieldTrainer?: { name: string; trainerClass: string; party: readonly { species: string; level: number }[];
    index: number; delay: number; onWin: () => void; boss?: "BROCK" | "MISTY" };
  get fieldTrainerActive(): boolean { return this.fieldTrainer !== undefined; }
  private fieldNotice(text: string): void { this.fieldNotices.push({ text, ticks: 180 }); }
  private solidActors(): Mover[] { return [...this.entities, ...this.wild.slots.filter(w => w.active)]; }

  pokemonProjectiles: FieldProjectile[] = [];
  pokemonImpacts: { x: number; y: number; moveId: string; ticks: number }[] = [];
  pokemonMeleeFlashes: { x: number; y: number; ticks: number }[] = [];
  get pokemonProjectile(): FieldProjectile | undefined { return this.pokemonProjectiles[0]; }
  get pokemonPilotMoves(): readonly MoveSlot[] { return this.fieldBattle?.player.curMoves ?? []; }
  private fieldBattle?: FieldBattle;
  private fieldCharges: FieldCharge[] = [];

  constructor(shell: OverworldShell) {
    this.shell = shell;
    const field = shell.data.field as
      | { tilePairs?: TilePairs; warpCarpets?: WarpCarpets }
      | undefined;
    // Collision.load equivalent (Collision.lua:36)
    this.tilePairs = field?.tilePairs ?? { land: [], water: [] };
    this.carpets = field?.warpCarpets;
    this.runner = new ScriptRunner(this);
  }

  get data(): VoxelmonData {
    return this.shell.data;
  }

  get save(): SaveSlice {
    return this.shell.save;
  }

  private pilotLand?: { map: string; x: number; y: number };

  private refreshPilotMobility(): void {
    const mon = this.shell.save.party?.[this.pokemonPilot?.monIndex ?? -1];
    const types = mon?.species ? this.shell.data.pokemon[mon.species]?.types ?? [] : [];
    this.player.flying = types.includes("FLYING");
    this.player.waterWalking = types.includes("WATER");
    const ledges = this.shell.data.field?.ledges as { tileset?: string; ledgeTile: number }[] | undefined;
    this.player.ledgeTiles = (ledges ?? []).filter(l => (l.tileset ?? "OVERWORLD") === this.map.def.tileset).map(l => l.ledgeTile);
    this.rememberPilotLand();
  }

  private rememberPilotLand(): void {
    const p = this.player, last = this.pilotLand;
    if (last?.map === this.map.id && last.x === p.cellX && last.y === p.cellY) return;
    if (this.map.isWalkableCell(p.cellX, p.cellY) && !this.map.isWaterCell(p.cellX, p.cellY)) {
      this.pilotLand = { map: this.map.id, x: p.cellX, y: p.cellY };
    }
  }

  canUsePokemonPilot(monIndex = 0): boolean {
    const mon = this.shell.save.party?.[monIndex];
    return !!mon && mon.hp > 0 && typeof mon.species === "string" && !!this.shell.data.pokemon[mon.species]?.partyIcon;
  }

  startPokemonPilot(monIndex = 0): boolean {
    if (!this.canUsePokemonPilot(monIndex)) return false;
    const mon = this.shell.save.party![monIndex] as PartyMon;
    this.fieldBattle = new FieldBattle(this.shell.data, {
      party: [mon], inventory: this.shell.save.inventory, player: this.shell.save.player,
    }, this.shell.rng, mon.species, mon.level);

    this.pokemonPilot = { monIndex, attackIndex: 0 };
    this.refreshPilotMobility();
    this.player.stepFrames = FIELD_WALK_TICKS;
    for (const wild of this.wild.slots) {
      if (wild.moving) wild.progress *= FIELD_WALK_TICKS / wild.moveStepTicks;
      wild.moveStepTicks = FIELD_WALK_TICKS;
    }
    this.pokemonAttackCooldown = 0;
    this.pokemonAttackMessage = `${this.shell.save.party![monIndex]!.species} READY`;
    return true;
  }

  stopPokemonPilot(): void {
    const p = this.player;
    if (this.pokemonPilot) {
      p.moving = false; p.targetX = p.targetY = undefined; p.progress = 0;
      p.px = p.cellX * 16; p.py = p.cellY * 16;
    }
    if (this.pokemonPilot && !(this.map.isWalkableCell(p.cellX, p.cellY) && !this.map.isWaterCell(p.cellX, p.cellY)) &&
        !(p.surfing && this.map.isWaterCell(p.cellX, p.cellY)) && this.pilotLand) {
      const land = this.pilotLand;
      const changedMap = land.map !== this.map.id;
      this.setMap(land.map, land.x, land.y, p.facing);
      if (changedMap) this.shell.startMapMusic(land.map);
    }
    p.flying = p.waterWalking = false;
    p.ledgeTiles = [];
    this.pilotLand = undefined;
    this.pokemonPilot = undefined;
    this.cancelFieldTrainer();
    this.fieldCharges.length = 0;
    this.pokemonProjectiles.length = 0;
    this.pokemonImpacts.length = 0;
    this.pokemonMeleeFlashes.length = 0;
    this.pokemonAttackMessage = "READY";
  }

  cyclePokemonAttack(delta = 1): void {
    const pilot = this.pokemonPilot;
    if (!pilot) return;
    const mon = this.fieldBattle!.player.mon;
    const attacks = overworldAttacksFor(mon.species, this.fieldBattle!.player.curMoves, this.shell.data.moves);
    if (attacks.length === 0) return;
    pilot.attackIndex = (pilot.attackIndex + delta + attacks.length) % attacks.length;
    this.pokemonAttackMessage = attacks[pilot.attackIndex]!.name;
  }

  /** One tick of the Pokémon-controlled field mode. */
  updatePokemonPilot(): void {
    const pilot = this.pokemonPilot;
    if (!pilot) return;
    if (this.fieldNotices[0] && --this.fieldNotices[0].ticks <= 0) this.fieldNotices.shift();
    this.runner.update();
    if (this.emote) {
      if (--this.emote.frames <= 0) { const done = this.emote.onDone; this.emote = undefined; done?.(); }
      this.player.update(); return;
    }
    for (const npc of this.npcs) npc.update(this.map, this.solidActors(), this.shell.npcRng, this.tilePairs);
    this.updateScriptMoves();
    if (this.runner.isRunning() || this.scriptMoves.length || this.emote || this.transitioning) { this.player.update(); return; }
    this.advanceFieldTrainer();
    this.pokemonMeleeFlashes = this.pokemonMeleeFlashes.filter(flash => --flash.ticks > 0);
    this.pokemonImpacts = this.pokemonImpacts.filter(impact => --impact.ticks > 0);
    if (this.pokemonAttackCooldown > 0) this.pokemonAttackCooldown--;
    this.tickFieldStatuses();
    if (!this.pokemonPilot) return;
    this.advanceFieldCharges();
    if (!this.pokemonPilot) return;
    this.advancePokemonProjectile();
    if (!this.pokemonPilot) return;
    this.rememberPilotLand();
    const input = this.shell.input;
    if (input.wasPressed("b") || input.wasPressed("start")) { this.stopPokemonPilot(); return; }
    if (input.wasPressed("l")) this.cyclePokemonAttack(-1);
    if (input.wasPressed("r")) this.cyclePokemonAttack(1);
    this.player.stepFrames = this.fieldBattle!.moveTicks(this.fieldBattle!.player, FIELD_WALK_TICKS);
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      if (this.fieldBattle!.locked(this.fieldBattle!.player) || this.fieldCharges.some(c => !c.source)) break;
      if (!input.isDown(dir)) continue;
      if (this.player.moving) break;
      if (!this.player.flying && this.checkLedgeHop(dir)) return;
      if (!this.fieldTrainer && this.checkEdgeExit(dir)) return;
      const [x, y] = target(this.player.cellX, this.player.cellY, dir);
      const warp = this.map.warpAtCell(x, y);
      if (warp && this.map.isWarpTileCell(x, y) && (!this.isCooked(warp.def.destMap) || this.fieldTrainer)) break;
      const result = this.player.tryMove(dir, this.map, this.solidActors(), this.tilePairs);
      if (result === "blocked" && !this.fieldTrainer && this.canCollisionWarp()) {
        const exit = onCollision(this.map, this.carpets, this.player.cellX, this.player.cellY, dir);
        if (exit) { this.takeWarp(exit.def); return; }
      }
      if (result !== "blocked") break;
    }
    const stepped = !this.fieldBattle!.locked(this.fieldBattle!.player) && !this.fieldCharges.some(c => !c.source) && this.player.update();
    if (stepped && this.pendingSeamMusic) { this.pendingSeamMusic = null; this.shell.startMapMusic(this.map.id); }
    if (stepped && !this.fieldTrainer) { this.onStepComplete(); return; }
    this.follower.update(this.player, this.shell.save.party?.[pilot.monIndex]);
    if (input.wasPressed("a")) {
      const [x, y] = this.player.facingCell();
      const npc = this.npcAtCell(x, y);
      if (npc && !this.fieldTrainer && !this.player.moving) { this.talkTo(npc); return; }
      if (!this.fieldTrainer && !this.player.moving) {
        if (this.tryChapterDoor(x, y)) return;
        const sign = this.map.signAtCell(x, y);
        if (sign && this.tryChapterSign(sign.text)) return;
      }
      this.firePokemonAttack();
    }
    if (!this.pokemonPilot) return;
    // Aggression is rolled once at spawn. Passive creatures only retaliate.
    for (const wild of this.wild.slots) {
      if (!wild.active) continue;
      const wasAggro = wild.aggro;
      wild.aggro = wild.trainerOwned || wild.provoked || (wild.aggressive &&
        Math.abs(wild.cellX - this.player.cellX) + Math.abs(wild.cellY - this.player.cellY) <= 5);
      if (wild.aggro && !wasAggro) { wild.timer = 0; wild.attackCooldown = OVERWORLD_ATTACK_COOLDOWN; }
    }
    if (!this.inPurifiedZone) this.wild.update(this.shell.data, this.map, this.player, this.entities, this.tilePairs,
      (this.shell.data.followerSprites ? 1 : 0) + 5,
      wild => wild.aggro && wild.attackCooldown <= 0 &&
        (wild.mon?.moves ?? []).some(move => move.pp > 0 && this.fieldInRange(wild, move.id)),
      wild => this.fieldBattle!.locked(this.fieldActor(wild)) || this.fieldCharges.some(c => c.source === wild),
      wild => this.fieldBattle!.moveTicks(this.fieldActor(wild), FIELD_WALK_TICKS));
    for (const wild of this.wild.slots) {
      if (!wild.active || !wild.aggro || wild.moving || wild.attackCooldown > 0 || this.fieldCharges.some(c => c.source === wild)) continue;
      const battle = this.prepareFieldBattle(wild);
      if (battle.locked(battle.enemy)) continue;
      const usable = battle.enemy.curMoves.filter((move, i) => move.pp > 0 && battle.enemy.disabledSlot !== i + 1);
      const possible = usable.length ? usable : [{ id: "STRUGGLE", pp: 1, struggle: true }];
      let moves = possible.filter(move => this.fieldInRange(wild, move.id));
      if (wild.bossPattern?.length) {
        const wanted = wild.bossPattern[wild.bossPatternIndex % wild.bossPattern.length];
        const scripted = moves.find(move => move.id === wanted);
        moves = scripted ? [scripted] : [];
      }
      if (!moves.length) continue;
      const selected = moves[this.shell.rng.int(moves.length)]!;
      if (wild.bossPattern?.length) wild.bossPatternIndex++;
      this.beginFieldMove(selected, wild);
      if (!this.pokemonPilot) break;
    }
  }

  private firePokemonAttack(): void {
    const pilot = this.pokemonPilot;
    if (!pilot || this.pokemonAttackCooldown > 0) {
      if (pilot) this.pokemonAttackMessage = `COOLDOWN ${Math.ceil(this.pokemonAttackCooldown / FIELD_LOGIC_HZ)}s`;
      return;
    }
    const battle = this.fieldBattle!;
    if (battle.locked(battle.player) || this.fieldCharges.some(c => !c.source)) {
      this.pokemonAttackMessage = "CANNOT ACT"; return;
    }
    const moves = battle.player.curMoves;
    if (!moves.length || moves.every(move => move.pp <= 0)) {
      this.beginFieldMove({ id: "STRUGGLE", pp: 1, struggle: true }); return;
    }
    const move = moves[pilot.attackIndex % moves.length]!;
    this.beginFieldMove(move);
  }

  private fieldActor(wild?: WildSprite) {
    return wild ? this.prepareFieldBattle(wild).enemy : this.fieldBattle!.player;
  }

  private fieldInRange(wild: WildSprite, id: string): boolean {
    const rule = FIELD_MOVES[id];
    const x = Math.round(this.player.px / 16), y = Math.round(this.player.py / 16);
    if (rule?.target === "self") return true;
    const attack = overworldAttacksFor(wild.species, [{ id }], this.shell.data.moves)[0]!;
    if (rule?.area || attack.kind === "melee") {
      return fieldCells(wild.cellX, wild.cellY, wild.facing, rule?.area ?? "melee").some(([cx, cy]) => cx === x && cy === y);
    }
    const dx = x - wild.cellX, dy = y - wild.cellY;
    return (dx === 0 || dy === 0) && Math.abs(dx) + Math.abs(dy) > 0 && Math.abs(dx) + Math.abs(dy) <= (rule?.range ?? 5);
  }

  private beginFieldMove(move: MoveSlot & { struggle?: boolean }, source?: WildSprite): void {
    const pilot = this.pokemonPilot;
    if (!pilot) return;
    const actor = this.fieldActor(source);
    if (this.fieldBattle!.locked(actor)) return;
    if (actor.disabledSlot && actor.curMoves[actor.disabledSlot - 1]?.id === move.id) {
      this.pokemonAttackMessage = "MOVE DISABLED"; return;
    }
    if (!move.struggle && move.pp <= 0) { this.pokemonAttackMessage = "NO PP LEFT"; return; }
    const original = move.id;
    let id = original;
    if (id === "METRONOME") {
      const choices = Object.keys(FIELD_MOVES).filter(key => key !== "METRONOME" && key !== "STRUGGLE" && this.shell.data.moves[key]);
      id = choices[this.shell.rng.int(choices.length)] ?? "TACKLE";
    }
    const rule = FIELD_MOVES[id];
    const cooldown = FIELD_MOVES[original]?.cooldown ?? OVERWORLD_ATTACK_COOLDOWN;
    if (source) source.attackCooldown = cooldown;
    else this.pokemonAttackCooldown = cooldown;
    if (!move.struggle) move.pp--;
    const actorPosition = source ?? this.player;
    const action = { move: { id, pp: 1, struggle: move.struggle }, source, sourceMon: source?.mon,
      facing: actorPosition.facing, ticks: rule?.charge ?? 0 };
    this.pokemonAttackMessage = `${this.shell.data.moves[id]?.name ?? id}${action.ticks ? " CHARGING" : "!"}`;
    if (action.ticks) {
      this.fieldBattle!.applyChargeBuff(actor, id);
      this.fieldCharges.push(action);
      this.pokemonMeleeFlashes.push({ x: Math.round(actorPosition.px / 16), y: Math.round(actorPosition.py / 16), ticks: action.ticks });
    } else this.deliverFieldMove(action);
  }

  private advanceFieldCharges(): void {
    for (const charge of [...this.fieldCharges]) {
      if (charge.source && (!charge.source.active || charge.source.mon !== charge.sourceMon)) {
        this.fieldCharges.splice(this.fieldCharges.indexOf(charge), 1); continue;
      }
      if (this.fieldBattle!.locked(this.fieldActor(charge.source))) continue;
      if (--charge.ticks > 0) continue;
      this.fieldCharges.splice(this.fieldCharges.indexOf(charge), 1);
      this.deliverFieldMove(charge);
      if (!this.pokemonPilot) break;
    }
  }

  private displaceFieldActor(source: WildSprite | undefined, facing: Dir, tiles: number): void {
    const actor = source ?? this.player;
    // Finish no partial steps during a controlled dash/knockback.
    actor.cellX = Math.round(actor.px / 16); actor.cellY = Math.round(actor.py / 16);
    actor.moving = false; actor.targetX = actor.targetY = undefined;
    for (let n = 0; n < tiles; n++) {
      const [x, y] = target(actor.cellX, actor.cellY, facing);
      if (!this.map.inBounds(x, y) || !canMove(this.map, this.entities, actor, facing, this.tilePairs).ok ||
          this.wild.slots.some(w => w !== source && w.active && w.cellX === x && w.cellY === y)) break;
      actor.cellX = x; actor.cellY = y;
    }
    actor.px = actor.cellX * 16; actor.py = actor.cellY * 16;
  }

  private deliverFieldMove(action: FieldCharge): void {
    const pilot = this.pokemonPilot;
    if (!pilot) return;
    const { move, source, facing } = action;
    const actor = source ?? this.player;
    const rule = FIELD_MOVES[move.id];
    const attack = overworldAttacksFor("", [move], this.shell.data.moves)[0]!;
    if (rule?.dash) this.displaceFieldActor(source, facing, 1);
    const x = Math.round(actor.px / 16), y = Math.round(actor.py / 16);
    if (attack.target === "self") {
      this.resolveFieldHit(source, { ...move }, !source, pilot.monIndex); return;
    }
    if (!rule?.area && attack.kind === "ranged") {
      const [nx, ny] = target(x, y, facing);
      this.pokemonProjectiles.push({ x, y, dx: nx - x, dy: ny - y, remaining: rule?.range ?? 5,
        move: { ...move }, name: attack.name, source, sourceMon: source?.mon, monIndex: pilot.monIndex,
        frame: 0, ticks: 0, stepTicks: FIELD_WALK_TICKS / OVERWORLD_PROJECTILE_SPEED });
      return;
    }
    const cells = fieldCells(x, y, facing, rule?.area ?? "melee").filter(([cx, cy]) => this.map.inBounds(cx, cy));
    for (const [cx, cy] of cells) this.flashMelee(cx, cy);
    const contains = (px: number, py: number) => cells.some(([cx, cy]) => cx === Math.round(px / 16) && cy === Math.round(py / 16));
    const hits = source ? (contains(this.player.px, this.player.py) ? [source] : [])
      : this.wild.slots.filter(w => w.active && contains(w.px, w.py));
    // Haze also resets its user when no opponent is inside the radius.
    if (move.id === "HAZE" && !hits.length) {
      const battler = this.fieldActor(source);
      this.pokemonAttackMessage = this.fieldBattle!.resolveFieldAction(battler, battler, { ...move }).join(" ");
    }
    for (const wild of hits) {
      this.resolveFieldHit(wild, { ...move }, !source, pilot.monIndex);
      if (!this.pokemonPilot) break;
    }
    if (move.id === "SELFDESTRUCT" || move.id === "EXPLOSION") {
      const battler = this.fieldActor(source);
      battler.mon.hp = 0;
      if (source) this.finishFieldOpponent(source, pilot.monIndex);
      else { this.stopPokemonPilot(); this.pokemonAttackMessage = `${battler.name} FAINTED`; }
    }
    if (!hits.length && move.id !== "HAZE") this.pokemonAttackMessage = `${attack.name} MISS`;
  }

  private flashMelee(x: number, y: number): void {
    if (!this.map.inBounds(x, y)) return;
    const existing = this.pokemonMeleeFlashes.find(flash => flash.x === x && flash.y === y);
    if (existing) existing.ticks = Math.max(existing.ticks, MELEE_FLASH_TICKS);
    else this.pokemonMeleeFlashes.push({ x, y, ticks: MELEE_FLASH_TICKS });
  }

  private advancePokemonProjectile(): void {
    for (const shot of [...this.pokemonProjectiles]) {
      if (shot.source && (!shot.source.active || shot.source.mon !== shot.sourceMon)) { this.removeFieldShot(shot); continue; }
      shot.frame++;
      if (++shot.ticks < shot.stepTicks) continue;
      shot.ticks = 0;
      shot.x += shot.dx; shot.y += shot.dy; shot.remaining--;
      if (!this.map.inBounds(shot.x, shot.y) || (!this.map.isWalkableCell(shot.x, shot.y) && !this.map.isWaterCell(shot.x, shot.y))) {
        this.addProjectileImpact(shot);
        this.removeFieldShot(shot);
        this.pokemonAttackMessage = `${shot.name} BLOCKED`;
        continue;
      }
      const wild = shot.source
        ? (Math.round(this.player.px / 16) === shot.x && Math.round(this.player.py / 16) === shot.y ? shot.source : undefined)
        : this.wild.slots.find(w => w.active && Math.round(w.px / 16) === shot.x && Math.round(w.py / 16) === shot.y);
      if (wild) {
        this.addProjectileImpact(shot);
        this.resolveFieldHit(wild, shot.move, !shot.source, shot.monIndex,
          shot.dx < 0 ? "left" : shot.dx > 0 ? "right" : shot.dy < 0 ? "up" : "down");
        this.removeFieldShot(shot);
        if (!this.pokemonPilot) break;
      } else if (shot.remaining <= 0) {
        this.removeFieldShot(shot);
        this.pokemonAttackMessage = `${shot.name} MISS`;
      }
    }
  }

  private removeFieldShot(shot: FieldProjectile): void {
    const index = this.pokemonProjectiles.indexOf(shot);
    if (index >= 0) this.pokemonProjectiles.splice(index, 1);
  }

  private addProjectileImpact(shot: FieldProjectile): void {
    if (!this.map.inBounds(shot.x, shot.y)) return;
    if (this.pokemonImpacts.length >= PROJECTILE_IMPACT_LIMIT) this.pokemonImpacts.shift();
    this.pokemonImpacts.push({ x: shot.x, y: shot.y, moveId: shot.move.id, ticks: PROJECTILE_IMPACT_TICKS });
  }

  startFieldTrainer(name: string, trainerClass: string, party: readonly { species: string; level: number }[], onWin: () => void): boolean {
    if (!this.pokemonPilot || this.fieldTrainer || !party.length) return false;
    if (party.some(mon => !this.shell.data.pokemon[mon.species])) return false;
    this.wild.clear();
    this.wild.trainerBattle = true;
    this.pokemonProjectiles.length = 0;
    this.pokemonImpacts.length = 0;
    this.fieldCharges.length = 0;
    const boss = name === "BROCK" ? "BROCK" : name === "MISTY" ? "MISTY" : undefined;
    this.fieldTrainer = { name, trainerClass, party, index: 0, delay: 0, onWin, boss };
    this.advanceFieldTrainer();
    return true;
  }

  private cancelFieldTrainer(): void {
    if (!this.fieldTrainer) return;
    this.fieldTrainer = undefined;
    this.wild.clear();
    for (const npc of this.npcs) npc.frozen = false;
  }

  private advanceFieldTrainer(): void {
    const trainer = this.fieldTrainer;
    if (!trainer || this.wild.slots.some(w => w.active && w.trainerOwned)) return;
    if (trainer.delay > 0) { trainer.delay--; return; }
    if (trainer.index >= trainer.party.length) {
      if (this.fieldNotices.length) return; // let the final XP notice finish first
      this.fieldTrainer = undefined;
      this.wild.trainerBattle = false;
      const prize = trainerPayout(this.shell.data.trainers?.[trainer.trainerClass], trainer.party);
      this.shell.save.money = Math.min(MAX_MONEY, (this.shell.save.money ?? 0) + prize);
      this.fieldNotice(`+${prize} MONEY ${trainer.name}`);
      trainer.onWin();
      return;
    }
    const occupiedCells = this.solidActors();
    let cell: [number, number] | undefined;
    // Leaders enter from deliberate arena positions. Brock's Onix starts on
    // the central rock platform; Misty's Starmie starts in the pool.
    if (trainer.boss === "BROCK" && trainer.party[trainer.index]?.species === "ONIX") {
      cell = this.arenaCell(6, 6, false);
    } else if (trainer.boss === "MISTY" && trainer.party[trainer.index]?.species === "STARMIE") {
      cell = this.arenaCell(6, 6, true);
    }
    for (let radius = 2; radius <= 6 && !cell; radius++) {
      for (let dy = -radius; dy <= radius && !cell; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) !== radius) continue;
        const x = this.player.cellX + dx, y = this.player.cellY + dy;
        if (this.map.inBounds(x, y) && this.map.isWalkableCell(x, y) && !this.map.warpAtCell(x, y) &&
            !occupied(occupiedCells, x, y)) { cell = [x, y]; break; }
      }
    }
    if (!cell) { trainer.delay = 30; this.pokemonAttackMessage = "MAKE ROOM FOR TRAINER POKEMON"; return; }
    const member = trainer.party[trainer.index]!;
    const wild = this.wild.slots[0]!;
    const mon = newMon(this.shell.data, member.species, member.level, this.shell.rng);
    const bossPattern = trainer.boss === "BROCK" && member.species === "ONIX"
      ? ["ROCK_THROW", "ROCK_THROW", "WRAP", "ROCK_THROW"]
      : trainer.boss === "MISTY" && member.species === "STARMIE"
        ? ["SWIFT", "CONFUSION", "TACKLE"] : undefined;
    Object.assign(wild, { trainerOwned: true, active: true, species: member.species, level: member.level,
      icon: this.shell.data.pokemon[member.species]!.partyIcon ?? "MON", mon,
      battler: makeBattler(this.shell.data, mon, false), hp: mon.hp, maxHp: mon.stats.hp,
      cellX: cell[0], cellY: cell[1], px: cell[0] * 16, py: cell[1] * 16,
      targetX: undefined, targetY: undefined, moving: false, progress: 0, timer: 0,
      aggressive: true, provoked: true, aggro: true, rewarded: false,
      surfing: trainer.boss === "MISTY" && member.species === "STARMIE",
      habitat: trainer.boss === "MISTY" && member.species === "STARMIE" ? "water" : "grass",
      bossPattern, bossPatternIndex: 0, bossPatternTimer: 0,
      attackCooldown: OVERWORLD_ATTACK_COOLDOWN, moveStepTicks: FIELD_WALK_TICKS });
    if (trainer.boss === "BROCK" && member.species === "ONIX") {
      const moves = ["ROCK_THROW", "WRAP", "TACKLE"].map(id => ({ id, pp: 99 }));
      mon.moves = moves;
      wild.battler!.curMoves = mon.moves;
    }
    if (trainer.boss === "MISTY" && member.species === "STARMIE") {
      const moves = ["SWIFT", "CONFUSION", "TACKLE"].map(id => ({ id, pp: 99 }));
      mon.moves = moves;
      wild.battler!.curMoves = mon.moves;
    }
    this.fieldNotice(`${member.species} ${trainer.index + 1}/${trainer.party.length} SENT OUT`);
  }

  private arenaCell(cx: number, cy: number, water: boolean): [number, number] | undefined {
    const candidates: [number, number][] = [[cx, cy], [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
    return candidates.find(([x, y]) => this.map.inBounds(x, y) &&
      (water ? this.map.isWaterCell(x, y) : this.map.isWalkableCell(x, y)) &&
      !occupied(this.solidActors(), x, y));
  }

  private finishFieldOpponent(wild: WildSprite, monIndex: number): void {
    if (wild.rewarded) return;
    wild.rewarded = true; wild.active = false; wild.aggro = false; wild.moving = false;
    const reward = this.shell.awardFieldExperience(monIndex, wild.species, wild.level, wild.trainerOwned);
    this.fieldNotice(`+${reward.gained} EXP ${wild.species}${reward.levels.length ? ` LV${reward.levels.at(-1)}` : ""}`);
    if (wild.trainerOwned && this.fieldTrainer) {
      this.fieldTrainer.index++;
      this.fieldTrainer.delay = 120;
    }
  }

  private tickFieldStatuses(): void {
    const battle = this.fieldBattle!, pilot = this.pokemonPilot!;
    const messages = battle.tickStatus(battle.player);
    for (const wild of this.wild.slots) {
      if (!wild.active) continue;
      this.prepareFieldBattle(wild);
      messages.push(...battle.tickStatus(wild.battler!));
      wild.hp = wild.mon!.hp;
      if (wild.hp <= 0 && !wild.rewarded) this.finishFieldOpponent(wild, pilot.monIndex);
    }
    battle.retainActors([battle.player, ...this.wild.slots.filter(w => w.active && w.battler).map(w => w.battler!)]);
    if (messages.length) this.pokemonAttackMessage = messages.join(" ");
    if (battle.player.mon.hp <= 0) {
      this.stopPokemonPilot();
      this.pokemonAttackMessage = `${battle.player.mon.species} FAINTED`;
    }
  }

  private prepareFieldBattle(wild: WildSprite): FieldBattle {
    const battle = this.fieldBattle!;
    if (!battle.player.transformedSpecies) battle.player.curStats = battle.player.mon.stats;
    wild.mon ??= newMon(this.shell.data, wild.species, wild.level, this.shell.rng);
    wild.battler ??= makeBattler(this.shell.data, wild.mon, false);
    battle.enemy = wild.battler;
    return battle;
  }

  private resolveFieldHit(wild: WildSprite | undefined, move: MoveSlot & { struggle?: boolean }, fromPlayer: boolean, monIndex: number, knockbackDirection?: Dir): void {
    if (wild && (!wild.active || wild.rewarded)) return;
    const battle = wild ? this.prepareFieldBattle(wild) : this.fieldBattle!;
    if (!wild) battle.enemy = battle.idleTarget;
    if (wild && fromPlayer) wild.provoked = true;
    const target = fromPlayer ? battle.enemy : battle.player;
    const hpBefore = target.mon.hp;
    const messages = battle.resolveFieldAction(
      fromPlayer ? battle.player : battle.enemy,
      fromPlayer ? battle.enemy : battle.player, move);
    if (move.id === "PAY_DAY" && target.mon.hp < hpBefore) {
      const user = fromPlayer ? battle.player : battle.enemy;
      this.shell.save.money = Math.min(999999, (this.shell.save.money ?? 0) + 2 * user.mon.level);
    }
    if (battle.lastPush && wild) {
      const attacker = fromPlayer ? this.player : wild;
      this.displaceFieldActor(fromPlayer ? wild : undefined, knockbackDirection ?? attacker.facing, FIELD_MOVES[move.id]?.push ?? 2);
    }
    if (wild) {
      wild.hp = battle.enemy.mon.hp;
      wild.maxHp = battle.enemy.mon.stats.hp;
      wild.aggro = true;
      wild.timer = 0;
    }
    const outcome = messages.filter(message => !message.includes(" used ")).join(" ");
    this.pokemonAttackMessage = outcome || `${this.shell.data.moves[move.id]?.name ?? move.id} ${Math.max(0, hpBefore - target.mon.hp)} DMG`;
    if (wild && wild.hp === 0 && !wild.rewarded) this.finishFieldOpponent(wild, monIndex);
    if (battle.result === "run") {
      if (fromPlayer) this.stopPokemonPilot();
      else if (wild) { wild.active = false; wild.aggro = false; }
      battle.result = null;
    }
    if (battle.player.mon.hp <= 0) {
      this.stopPokemonPilot();
      this.pokemonAttackMessage = `${battle.player.mon.species} FAINTED`;
    }
  }

  // OverworldController.lua:209 enter
  enter(mapId: string, x: number, y: number, facing?: Dir): void {
    // survives save/load: a loaded game may start inside a building whose
    // exit mat is a LAST_MAP warp
    this.lastOutdoor = this.shell.save.lastOutdoor;
    this.setMap(mapId, x, y, facing, { via: "boot" });
    // boot/load: derive the flag from the tile the save left us standing on
    // (MapEntryAfterBattle's IsPlayerStandingOnWarp — issue #378)
    this.refreshStandingOnWarp();
  }

  // OverworldController.lua:283 setMap — the single choke point for every
  // map-id change, warps and seamless connection crossings alike.
  setMap(
    mapId: string,
    x: number,
    y: number,
    facing?: Dir,
    opts?: { via?: string; seamless?: boolean },
  ): void {
    const def = this.shell.data.maps?.[mapId];
    if (!def) throw new Error(`unknown map ${mapId}`);
    // crossConnection re-arms this right after; clearing here is what keeps a
    // warp or a reload from leaving a stale deferred PlayMapMusic pending
    // (OverworldController.lua:437-439).
    this.pendingSeamMusic = null;
    const tileset = this.shell.data.tilesets?.[def.tileset];
    if (!tileset) throw new Error(`unknown tileset ${def.tileset} for ${mapId}`);
    this.map = new GameMap(def, tileset);
    this.refreshChapterDoors();
    this.inPurifiedZone = false;
    this.cancelFieldTrainer();
    this.wild.clear();
    this.fieldCharges.length = 0;
    this.pokemonProjectiles.length = 0;
    this.pokemonImpacts.length = 0;
    this.pokemonMeleeFlashes.length = 0;
    // NPC instances persist across connection crossings in the pool (keyed
    // by NPC.id) so nothing snaps back to its spawn point at a seam; warps
    // rebuild from scratch, like the original's per-entry sprite init
    // (OverworldController.lua:376-385).
    if (!(opts?.seamless && this.npcPool.size > 0)) {
      this.npcPool = new Map();
    }
    // Repair saves stranded on the front doorstep behind the old guard.
    if (mapId === "CERULEAN_CITY" && x === 27 && y === 11) {
      this.shell.save.flags.EVENT_CERULEAN_HOUSE_OPEN = true;
    }
    this.npcs = [];
    for (const obj of def.objects ?? []) {
      if (this.objectVisible(obj)) {
        const npc = this.pooledNPC(mapId, obj);
        npc.frozen = false;
        this.npcs.push(npc);
      }
    }
    if (this.player) {
      this.player.cellX = x;
      this.player.cellY = y;
      this.player.px = x * 16;
      this.player.py = y * 16;
      this.player.facing = facing ?? this.player.facing;
      this.player.moving = false;
      this.player.targetX = undefined;
      this.player.targetY = undefined;
    } else {
      this.player = new Player(x, y, facing);
    }
    if (isOutside(def) && this.map.isWalkableCell(x, y) && !this.map.isWaterCell(x, y)) {
      (this.shell.save.visitedOutdoor ??= {})[mapId] = { x, y };
    }
    if (this.pokemonPilot) this.refreshPilotMobility();
    this.entities = [this.player, ...this.npcs];
    this.follower.reset(this.player);
  }

  // OverworldController.lua:110 objectVisible — the spawn filter. The slice
  // carries only the `hidden` gate (toggles/items-taken/defeated need save
  // machinery outside this slice).
  private objectVisible(obj: MapObject): boolean {
    const chosen = this.shell.save.flags;
    if (obj.name === "OAKSLAB_BULBASAUR_POKE_BALL" && (chosen.EVENT_CHOSE_BULBASAUR || chosen.EVENT_RIVAL_CHOSE_BULBASAUR)) return false;
    if (obj.name === "OAKSLAB_CHARMANDER_POKE_BALL" && (chosen.EVENT_CHOSE_CHARMANDER || chosen.EVENT_RIVAL_CHOSE_CHARMANDER)) return false;
    if (obj.name === "OAKSLAB_SQUIRTLE_POKE_BALL" && (chosen.EVENT_CHOSE_SQUIRTLE || chosen.EVENT_RIVAL_CHOSE_SQUIRTLE)) return false;
    if (chosen[`EVENT_TAKEN_${obj.name}`] || (!obj.trainerClass && chosen[`EVENT_BEAT_${obj.name}`])) return false;
    if ((obj.name === "MTMOONB2F_DOME_FOSSIL" || obj.name === "MTMOONB2F_HELIX_FOSSIL") && chosen.EVENT_MT_MOON_FOSSIL_TAKEN) return false;
    const houseOpen = !!(chosen.EVENT_CERULEAN_HOUSE_OPEN || chosen.EVENT_MET_BILL || chosen.EVENT_GOT_SS_TICKET ||
      this.shell.save.inventory.SS_TICKET || chosen.EVENT_BEAT_CERULEAN_ROCKET_THIEF ||
      chosen.EVENT_GOT_TM28 || chosen.EVENT_BEAT_CERULEANCITY_ROCKET);
    if (obj.name === "CERULEANCITY_GUARD1") return houseOpen;
    if (obj.name === "CERULEANCITY_GUARD2") return !houseOpen;
    if (obj.name === "CERULEANCITY_ROCKET" && chosen.EVENT_GOT_TM28) return false;
    if (obj.name === "SSANNE2F_RIVAL") return !chosen.EVENT_BEAT_SS_ANNE_RIVAL;
    if (obj.name === "POKEMONTOWER2F_RIVAL") return !chosen.EVENT_BEAT_POKEMON_TOWER_RIVAL;
    if (obj.name === "SILPHCO7F_RIVAL") return !chosen.EVENT_BEAT_SILPH_CO_RIVAL;
    if (obj.name === "FIGHTINGDOJO_HITMONLEE_POKE_BALL") return !chosen.EVENT_GOT_HITMONLEE;
    if (obj.name === "FIGHTINGDOJO_HITMONCHAN_POKE_BALL") return !chosen.EVENT_GOT_HITMONCHAN;
    if (obj.name?.startsWith("SAFFRONCITY_ROCKET")) {
      if (chosen.EVENT_BEAT_SILPH_CO_GIOVANNI) return false;
      if (obj.name === "SAFFRONCITY_ROCKET8" && chosen.EVENT_RESCUED_MR_FUJI) return false;
      if (obj.name === "SAFFRONCITY_ROCKET9") return !!chosen.EVENT_RESCUED_MR_FUJI;
    }
    if (obj.name?.startsWith("SAFFRONCITY_") && obj.hidden && !obj.name.includes("ROCKET") && chosen.EVENT_BEAT_SILPH_CO_GIOVANNI) return true;
    if (this.map.id.startsWith("SILPH_CO_") && chosen.EVENT_BEAT_SILPH_CO_GIOVANNI &&
        (obj.trainerClass === "OPP_ROCKET" || obj.trainerClass === "OPP_SCIENTIST" || obj.trainerClass === "OPP_GIOVANNI")) return false;
    if (obj.name === "MRFUJISHOUSE_MR_FUJI") return !!chosen.EVENT_RESCUED_MR_FUJI;
    if (obj.name === "GAMECORNER_ROCKET") return !chosen.EVENT_BEAT_GAMECORNER_ROCKET;
    if (obj.name === "ROCKETHIDEOUTB4F_GIOVANNI" && chosen.EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI) return false;
    if (this.map.id === "POKEMON_TOWER_7F" && obj.trainerClass === "OPP_ROCKET" &&
        (chosen[`EVENT_BEAT_${obj.name}`] || chosen[trainerHeader(this.shell.data, this.map.def, obj.index)?.event ?? ""])) return false;
    if (obj.name === "ROCKETHIDEOUTB4F_LIFT_KEY") return !!chosen.EVENT_ROCKET_DROPPED_LIFT_KEY;
    if (obj.name === "POKEMONTOWER7F_MR_FUJI") return !chosen.EVENT_RESCUED_MR_FUJI;
    if (obj.name === "ROCKETHIDEOUTB4F_SILPH_SCOPE") return !!chosen.EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI;
    if (obj.name === "ROUTE12_SNORLAX") return !chosen.EVENT_BEAT_ROUTE12_SNORLAX;
    if (obj.name === "ROUTE16_SNORLAX") return !chosen.EVENT_BEAT_ROUTE16_SNORLAX;
    return !(obj as MapObject & { hidden?: boolean }).hidden;
  }

  // OverworldController.lua:131 pooledNPC
  private pooledNPC(mapId: string, obj: MapObject): NPC {
    const key = `${mapId}_obj_${obj.index}`;
    let npc = this.npcPool.get(key);
    if (!npc) {
      npc = new NPC(mapId, obj, this.shell.npcRng);
      this.npcPool.set(key, npc);
    }
    return npc;
  }

  // OverworldController.lua:883 update
  update(): void {
    if (this.bumpCooldown > 0) this.bumpCooldown -= 1;
    this.runner.update();
    // the emotion-bubble pause holds the world for a beat
    // (OverworldController.lua:1018); only the player animates through it
    if (this.emote) {
      this.emote.frames -= 1;
      if (this.emote.frames <= 0) {
        const done = this.emote.onDone;
        this.emote = undefined;
        done?.();
      }
      this.player.update();
      return;
    }
    for (const npc of this.npcs) {
      npc.update(this.map, this.solidActors(), this.shell.npcRng, this.tilePairs);
    }
    this.updateScriptMoves();
    // emote is included: a hold queued from a scriptMove onDone is assigned
    // mid-frame, after the early emote return above already missed it
    // (OverworldController.lua:1045-1052)
    const scripted =
      this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote !== undefined;
    if (!scripted && !this.transitioning) {
      if (!this.inPurifiedZone && this.shell.save.party?.some(mon => mon.hp > 0)) {
        this.wild.update(this.shell.data, this.map, this.player, this.entities, this.tilePairs, this.shell.data.followerSprites ? 1 : 0);
      }
      this.handleInput();
    }
    const stepped = this.player.update();
    this.follower.update(this.player, this.shell.save.party?.[0]);
    // the warp-arrival cell goes stale the instant the player's real cell
    // leaves it, scripted walk-outs included (OverworldController.lua:1071)
    const entry = this.warpEntryCell;
    if (entry && (this.player.cellX !== entry.x || this.player.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
    }
    // OverworldController.lua:1075 — the seam step landed, so the deferred
    // PlayMapMusic runs now (and only if we are still on the map it was
    // armed for; a warp taken mid-step drops it).
    if (stepped && this.pendingSeamMusic) {
      const pending = this.pendingSeamMusic;
      this.pendingSeamMusic = null;
      if (pending === this.map.id) this.shell.startMapMusic(pending);
    }
    if (stepped && !scripted) {
      this.onStepComplete();
    }
  }

  // OverworldController.lua:1113 dirHeld (hJoyHeld & PAD_CTRL_PAD)
  dirHeld(): boolean {
    const input = this.shell.input;
    return (
      input.isDown("up") || input.isDown("down") || input.isDown("left") || input.isDown("right")
    );
  }

  // OverworldController.lua:1131 — BIT_STANDING_ON_WARP: the warp under the
  // player's feet may only fire from a collision (blocked step / map edge)
  // while this flag is set.
  canCollisionWarp(): boolean {
    return this.standingOnWarp;
  }

  // OverworldController.lua:1138 refreshStandingOnWarp — a door tile keeps
  // the flag, a stair/ladder warp tile clears it (issues #230/#378).
  refreshStandingOnWarp(): void {
    const p = this.player;
    this.standingOnWarp = false;
    if (
      this.map.warpAtCell(p.cellX, p.cellY) &&
      !(this.map.isWarpTileCell(p.cellX, p.cellY) && !this.map.isDoorTileCell(p.cellX, p.cellY))
    ) {
      this.standingOnWarp = true;
    }
  }

  // OverworldController.lua:1148 handleInput — gated on the walk counter:
  // A and direction initiation are only acted on standing on a tile (#286).
  handleInput(): void {
    const input = this.shell.input;
    if (this.player.moving) {
      // OverworldController.lua:1177: a button pressed mid-step and STILL
      // HELD when the step lands reads as a fresh press at the next poll
      // (hJoyLast frozen for the animation, #525); one released before then
      // is genuinely lost.
      if (input.wasPressed("a")) {
        this.joyLatch = { ...this.joyLatch, a: true };
      }
      return;
    }
    const latch = this.joyLatch;
    this.joyLatch = undefined;
    if (input.wasPressed("a") || (latch?.a === true && input.isDown("a"))) {
      this.interact();
      return;
    }
    // START menu: outside the slice (the early return still skips the
    // turn re-arm below, like the original's jump to .displayDialogue)
    if (input.wasPressed("start")) {
      this.shell.openStartMenu();
      return;
    }
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      if (!input.isDown(dir)) continue;
      if (!this.player.moving && this.player.facing === dir) {
        if (this.checkEdgeExit(dir)) return;
        if (this.checkLedgeHop(dir)) return;
        // boulder pushes: outside the slice
      }
      // Content boundary, standing case: a warp TILE whose destination map
      // is not in the cooked set must not even be stepped on (the real game
      // warps the instant you land — with the warp locked, landing would
      // leave the player standing inside the doorway's geometry, e.g. the
      // Diglett's Cave mouth on Route 2). Bump instead.
      {
        const [tx, ty] = target(this.player.cellX, this.player.cellY, dir);
        const w = this.map.warpAtCell(tx, ty);
        if (w && this.map.isWarpTileCell(tx, ty) && !this.isCooked(w.def.destMap)) {
          this.player.facing = dir;
          this.player.bumpFrames = this.player.stepFrames;
          // ENDS the poll, like every other outcome here (:1224 returns the
          // tryMove result): a poll handles ONE held direction, so a held
          // diagonal must not walk on the other axis, and falling through to
          // the turn re-arm below would hand back a turn window the original
          // never grants while a direction is down.
          return;
        }
      }
      const result = this.player.tryMove(dir, this.map, this.solidActors(), this.tilePairs);
      // Walking into a visible wild starts a classic encounter. Field mode
      // has its own movement loop and keeps opponents solid for combat.
      if (result === "blocked" && this.player.lastBlockReason === "entity" && this.touchWild(dir)) return;
      // a collision while standing on a warp square fires the warp when
      // the extra check passes (CheckWarpsCollision), only while
      // BIT_STANDING_ON_WARP is set (issue #230)
      if (result === "blocked" && this.canCollisionWarp()) {
        const w = onCollision(this.map, this.carpets, this.player.cellX, this.player.cellY, dir);
        if (w) {
          this.takeWarp(w.def);
          return;
        }
      }
      // OverworldController.lua:1218-1223: the bonk. Bumping another entity
      // is silent, and the 16-frame cooldown is what keeps a held direction
      // into a wall from machine-gunning the cue.
      if (
        result === "blocked" &&
        this.player.lastBlockReason !== "entity" &&
        this.bumpCooldown <= 0
      ) {
        this.shell.audio.playSfx("Collision");
        this.bumpCooldown = 16;
      }
      return;
    }
    // OverworldController.lua:1233: a poll that found no direction held is
    // what re-arms the next turn in place (#415); the early returns above
    // skip it exactly as the original's jumps do.
    this.player.turnArmed = true;
  }

  // OverworldController.lua:1322 checkLedgeHop — standing tile + ledge tile
  // in front + matching input direction -> jump two cells.
  checkLedgeHop(dir: Dir): boolean {
    const p = this.player;
    const tileset = this.map.def.tileset;
    const standing = this.map.cellTile(p.cellX, p.cellY);
    const [fx, fy] = target(p.cellX, p.cellY, dir);
    if (!this.map.inBounds(fx, fy)) return false;
    const front = this.map.cellTile(fx, fy);
    const ledges = (this.shell.data.field as { ledges?: Array<Record<string, unknown>> })
      ?.ledges;
    for (const ledge of ledges ?? []) {
      if (
        ((ledge.tileset as string | undefined) ?? "OVERWORLD") === tileset &&
        ledge.facing === dir &&
        ledge.input === dir &&
        ledge.standingTile === standing &&
        ledge.ledgeTile === front
      ) {
        const [lx, ly] = target(fx, fy, dir);
        if (!this.map.inBounds(lx, ly)) {
          // OverworldController.lua:1337: the landing is on the CONNECTED
          // map (issue #223) — validate the seam cell like crossConnection,
          // hop the first cell, hand the second to checkEdgeExit.
          const landing = this.connectionLanding(dir);
          if (!landing) return false;
          const { dest, ts, x, y } = landing;
          if (!defPassable(dest, ts, x, y, (p.surfing || p.waterWalking || p.flying))) return false;
          this.shell.audio.playSfx("Ledge"); // OverworldController.lua:1352
          p.hopFrames = 32;
          p.hopTotal = 32;
          this.scriptMove(p, dir, 1, () => this.checkEdgeExit(dir));
          return true;
        }
        if (!occupied(this.entities, lx, ly, p) && this.map.isWalkableCell(lx, ly)) {
          this.shell.audio.playSfx("Ledge"); // OverworldController.lua:1359
          p.hopFrames = 32; // jump arc (cosmetic; entities can't collide mid-hop
          p.hopTotal = 32; // because the hop is a scripted move that owns input)
          this.scriptMove(p, dir, 2);
          return true;
        }
      }
    }
    return false;
  }

  // OverworldController.lua:1370 checkEdgeExit — walking off the map edge:
  // connection crossing or edge warp (exit mats).
  checkEdgeExit(dir: Dir): boolean {
    const p = this.player;
    const [tx, ty] = target(p.cellX, p.cellY, dir);
    if (this.map.inBounds(tx, ty)) return false;
    const w = onEdge(this.map, p.cellX, p.cellY, dir);
    if (w) {
      // only with BIT_STANDING_ON_WARP set: pushing into the edge beside a
      // staircase bonks instead of bouncing floors (issue #230), while the
      // door mat you warped in on keeps it and exits (issue #378)
      if (!this.canCollisionWarp()) return false;
      this.takeWarp(w.def);
      return true;
    }
    const conn = this.map.connection(COMPASS[dir]);
    if (conn) {
      return this.crossConnection(dir, conn);
    }
    return false;
  }

  // OverworldController.lua:1396 connectionLanding — landing cell on the
  // connected map for a step off this map's edge (destX = curX - offset*2).
  connectionLanding(dir: Dir) {
    const conn = this.map.connection(COMPASS[dir]);
    if (!conn) return null;
    const dest = this.shell.data.maps?.[conn.map];
    if (!dest) return null;
    const ts = this.shell.data.tilesets?.[dest.tileset];
    if (!ts) return null;
    const p = this.player;
    const destW = dest.width * 2;
    const destH = dest.height * 2;
    let x: number;
    let y: number;
    if (dir === "up") {
      x = p.cellX - conn.offset * 2;
      y = destH - 1;
    } else if (dir === "down") {
      x = p.cellX - conn.offset * 2;
      y = 0;
    } else if (dir === "left") {
      x = destW - 1;
      y = p.cellY - conn.offset * 2;
    } else {
      x = 0;
      y = p.cellY - conn.offset * 2;
    }
    x = Math.max(0, Math.min(destW - 1, x));
    y = Math.max(0, Math.min(destH - 1, y));
    return { dest, ts, x, y, conn };
  }

  // OverworldController.lua:1425 crossConnection — the map data swaps while
  // the player is placed one cell before the entry point (their old world
  // position, which the neighbor strips render identically) and walks the
  // seam step. pokered's collision check reads the NEIGHBOR strip's tiles,
  // so stepping onto a solid tile of the connected map bumps like a wall.
  crossConnection(dir: Dir, _conn: { map: string; offset: number }): boolean {
    if (!this.isCooked(_conn.map)) return false; // content boundary: a wall
    // PewterCityScript: the east road does not open until Brock is beaten.
    // The original youngster escorts Red back to the Gym; at the hard-load
    // seam we keep the same progression invariant without staging him across
    // a map boundary.
    if (
      this.map.id === "PEWTER_CITY" &&
      dir === "right" &&
      _conn.map === "ROUTE_3" &&
      !this.shell.save.flags.EVENT_BEAT_BROCK
    ) {
      this.shell.showText("You have to beat\nBROCK before going\non to ROUTE 3!");
      return true;
    }
    const landing = this.connectionLanding(dir);
    if (!landing) return false;
    const { dest, ts, x, y } = landing;
    const p = this.player;
    if (!defPassable(dest, ts, x, y, p.surfing || p.waterWalking || p.flying)) {
      return false;
    }
    // Every connection is a hard PSP-1000 scene boundary. Hold the old scene
    // through the standard load fade, replace it at the midpoint, and enter
    // directly on the validated destination cell. No neighbour geometry or
    // atlas pages remain resident while the destination streams.
    if (dest.id !== this.map.id) {
      this.transitioning = true;
      this.shell.pushWarpFade(
        WARP_FADE_OUT,
        () => {
          this.setMap(dest.id, x, y, dir);
          // The boundary traversal is still one logical walking cell even
          // though no interpolated seam step survives the load screen.
          this.player.landedCount += 1;
          this.refreshStandingOnWarp();
          this.shell.startMapMusic(dest.id);
          // Preserve the seamless path's landing semantics (including its
          // encounter RNG draw) after the destination has been installed.
          this.onStepComplete();
        },
        () => {
          this.transitioning = false;
        },
      );
      return true;
    }
    this.setMap(dest.id, x, y, p.facing, { seamless: true });
    // place the player one cell before the seam and start the step into the
    // new map RIGHT NOW so there is no one-frame stall at the boundary
    const d: Record<Dir, [number, number]> = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
    };
    p.cellX = x - d[dir][0];
    p.cellY = y - d[dir][1];
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    p.facing = dir;
    p.targetX = x;
    p.targetY = y;
    p.moving = true;
    p.progress = 0;
    // fresh walk-cycle clock so the seam step always shows leg frames
    p.animClock = 0;
    p.stepFramesCur = p.stepFrames;
    // OverworldController.lua:1455 — the new map's theme is DEFERRED to the
    // frame the seam step lands (issue #93). Starting it here would swap the
    // song while the player is still visibly on the old map's last cell.
    this.pendingSeamMusic = dest.id;
    // FixedStep:discardCatchup (OverworldController.lua:1477) is a no-op
    // here: the voxel host runs exactly one tick per frame, so there is no
    // catch-up accumulator to discard.
    return true;
  }

  // OverworldController.lua:1729 interact — the A press: NPC (with the
  // counter-tile reach-across), sign, then the bedroom OpenRedsPC event.
  // Card-key doors and the other hidden-object families remain outside the
  // slice; the PC stays data-driven through field.hiddenExtras.pcTiles.
  interact(): void {
    if (this.touchWild(this.player.facing)) return;
    const p = this.player;
    const [fx, fy] = p.facingCell();
    let npc = this.npcAtCell(fx, fy);
    if (!npc && this.map.isCounterCell(fx, fy)) {
      // talk across counters (mart clerks, nurses)
      const [fx2, fy2] = target(fx, fy, p.facing);
      npc = this.npcAtCell(fx2, fy2);
    }
    if (npc) {
      if (!npc.moving) {
        this.talkTo(npc);
      }
      return;
    }
    if (this.tryChapterDoor(fx, fy)) return;
    if (this.tryCut(fx, fy)) return;
    const sign = this.map.signAtCell(fx, fy);
    if (sign) {
      if (this.tryChapterSign(sign.text)) return;
      this.showMapText(sign.text);
      return;
    }
    if (this.isBedroomComputer(fx, fy)) {
      this.shell.openBedroomComputer();
    }
  }

  private refreshChapterDoors(): void {
    for (const door of chapterDoors(this.shell.data.field as ChapterField, this.map.id)) {
      const open = doorOpen(door, this.shell.save.flags);
      this.map.setChapterBlock(door.bx, door.by, open ? door.open : door.block, open);
    }
  }

  private refreshChapterObjects(): void {
    this.npcs = this.npcs.filter(npc => this.objectVisible(npc.def));
    for (const def of this.map.def.objects) {
      if (this.objectVisible(def) && !this.npcs.some(npc => npc.def.index === def.index)) this.npcs.push(this.pooledNPC(this.map.id, def));
    }
    this.entities = [this.player, ...this.npcs];
  }

  private tryChapterDoor(x: number, y: number): boolean {
    if (!this.map.id.startsWith("SILPH_CO_")) return false;
    const door = chapterDoors(this.shell.data.field as ChapterField, this.map.id)
      .find(door => door.bx === Math.floor(x / 2) && door.by === Math.floor(y / 2));
    if (!door?.event || doorOpen(door, this.shell.save.flags)) return false;
    if (!this.shell.save.inventory.CARD_KEY) {
      this.shell.showText("This door needs\na CARD KEY!"); return true;
    }
    this.shell.save.flags[door.event] = true;
    this.refreshChapterDoors();
    this.shell.audio.playSfx("Go_Inside");
    this.shell.showText("The CARD KEY\nopened the door!");
    return true;
  }

  private giveGuardDrink(): boolean {
    const save = this.shell.save;
    if (save.flags.EVENT_GAVE_GUARDS_DRINK) { this.shell.showText("You can go through!"); return true; }
    const drink = DRINKS.find(item => (save.inventory[item] ?? 0) > 0);
    if (!drink) { this.shell.showText("I'm thirsty!\nThe road is closed."); return false; }
    Bag.remove(save, drink, 1);
    save.flags.EVENT_GAVE_GUARDS_DRINK = true;
    this.shell.showText("Thanks for the drink!\nI'll share with the guards.\fYou can go through!");
    return true;
  }

  private tryChapterSign(text: string): boolean {
    const poster = (this.shell.data.field as ChapterField).gameCornerPoster;
    if (poster && this.map.id === poster.map && text === poster.posterText) {
      if (this.npcs.some(npc => npc.def.name === "GAMECORNER_ROCKET")) {
        this.shell.showText("The ROCKET is guarding\nthe poster."); return true;
      }
      this.shell.showText("A switch behind\nthe poster!", () => {
        this.shell.save.flags[poster.event] = true;
        this.refreshChapterDoors(); this.shell.audio.playSfx("Go_Inside");
      });
      return true;
    }
    if (this.map.id === "CELADON_MART_ROOF" && text.includes("VENDING_MACHINE")) {
      this.shell.openMart(DRINKS.map((item, index) => ({ item, price: [200, 300, 350][index] })));
      return true;
    }
    if (!this.map.id.endsWith("_ELEVATOR")) return false;
    if (this.map.id === "ROCKET_HIDEOUT_ELEVATOR" && !this.shell.save.inventory.LIFT_KEY) {
      this.shell.showText("The lift needs\na LIFT KEY!"); return true;
    }
    const elevator = this.map.id;
    const floors = Object.values(this.shell.data.maps ?? {}).filter(map => this.isCooked(map.id) && map.warps.some(warp => warp.destMap === elevator))
      .sort((a, b) => Number(a.id.match(/(\d+)F$/)?.[1]) - Number(b.id.match(/(\d+)F$/)?.[1]));
    this.shell.showMenuChoice?.("Which floor?", [...floors.map(map => map.id.split("_").at(-1)!), "CANCEL"], index => {
      const floor = floors[index];
      if (!floor) return;
      (this.shell.save.elevatorFloors ??= {})[elevator] = floor.id;
      this.shell.audio.playSfx("Go_Inside");
      this.shell.showText(`Arrived at ${floor.id.split("_").at(-1)}.`);
    });
    return true;
  }

  private startTowerGhost(): void {
    if (!this.shell.pushGhostBattle) return;
    this.shell.showText("Be gone...\nIntruders!", () => this.shell.pushGhostBattle!(() => {
      this.shell.save.flags.EVENT_BEAT_GHOST_MAROWAK = true;
      this.shell.showText("The restless soul\nwas calmed.");
    }, () => this.scriptMove(this.player, "right", 1)));
  }

  private tryChapterStep(): boolean {
    const { cellX: x, cellY: y } = this.player;
    const gate = SAFFRON_GATES[this.map.id];
    if (gate && !this.shell.save.flags.EVENT_GAVE_GUARDS_DRINK && gate.cells.some(cell => cell[0] === x && cell[1] === y)) {
      const drink = DRINKS.find(item => (this.shell.save.inventory[item] ?? 0) > 0);
      if (drink) this.giveGuardDrink();
      else {
        const back = gate.horizontal ? (this.player.facing === "left" ? "right" : "left") : (this.player.facing === "up" ? "down" : "up");
        this.shell.showText("I'm thirsty!\nThe road is closed.", () => this.scriptMove(this.player, back, 1));
      }
      return true;
    }
    const purified = this.map.id === "POKEMON_TOWER_5F" && (x === 10 || x === 11) && (y === 8 || y === 9);
    if (purified) {
      this.wild.clear();
      if (!this.inPurifiedZone) { this.inPurifiedZone = true; this.shell.healParty(); this.shell.showText("You entered a\npurified zone.\fYour POKéMON are healed!"); }
      return true;
    }
    this.inPurifiedZone = false;
    if (this.map.id === "POKEMON_TOWER_6F" && x === 10 && y === 16 && !this.shell.save.flags.EVENT_BEAT_GHOST_MAROWAK) {
      this.startTowerGhost(); return true;
    }
    const spinner = (this.shell.data.field as ChapterField).spinners?.[this.map.id]?.find(spinner => spinner.x === x && spinner.y === y);
    if (spinner) {
      this.shell.audio.playSfx("Arrow_Tiles");
      const map = this.map;
      const slide = (index: number): void => {
        if (this.map !== map) return;
        const move = spinner.moves[index];
        if (!move) { this.onStepComplete(); return; }
        this.scriptMove(this.player, move.dir, move.count, () => slide(index + 1));
      };
      slide(0); return true;
    }
    return false;
  }

  private tryCut(x: number, y: number): boolean {
    if (!this.map.inBounds(x, y)) return false;
    const tile = this.map.cellTile(x, y);
    if (!((this.map.def.tileset === "OVERWORLD" && tile === 0x3d) ||
          (this.map.def.tileset === "GYM" && tile === 0x50))) return false;
    const field = this.shell.data.field as { cutTreeSwaps?: { before: number; after: number }[] } | undefined;
    const bx = Math.floor(x / 2), by = Math.floor(y / 2);
    const swap = field?.cutTreeSwaps?.find(s => s.before === this.map.blockAt(bx, by));
    if (!swap) return false;
    const mon = this.shell.save.party?.find(mon => mon.moves?.some(move => move.id === "CUT"));
    if (!this.shell.save.inventory.CASCADEBADGE || !mon) {
      this.shell.showText("A small tree!\fTeach HM01 CUT to a\nPOKéMON and earn the\nCASCADEBADGE to cut it.");
      return true;
    }
    const map = this.map;
    this.shell.showText(`${mon.nickname || mon.species || "POKéMON"} used CUT!`, () => {
      if (this.map !== map) return;
      map.cutBlock(bx, by, swap.after);
      this.shell.audio.playSfx("Cut");
    });
    return true;
  }

  private isBedroomComputer(fx: number, fy: number): boolean {
    if (this.map.id !== "REDS_HOUSE_2F") return false;
    const field = this.shell.data.field as
      | {
          hiddenExtras?: {
            pcTiles?: Record<string, { x: number; y: number; facing?: Dir }[]>;
          };
        }
      | undefined;
    const tiles = field?.hiddenExtras?.pcTiles?.[this.map.id] ?? [];
    return tiles.some(
      (tile) =>
        tile.x === fx && tile.y === fy && (!tile.facing || tile.facing === this.player.facing),
    );
  }

  // OverworldController.lua:2520 talkTo — freeze, then dispatch the object's
  // TEXT_* constant. Item balls, static encounters, trainer engagement and
  // TX_SCRIPT marts/nurses are the battle/menu ports' seams.
  talkTo(npc: NPC): void {
    if (this.tryChooseStarter(npc)) return;
    if (this.tryPokemonTowerRivalEvent(npc)) return;
    if (this.tryChapterInteraction(npc)) return;
    npc.frozen = true;
    const unfreeze = () => {
      npc.frozen = false;
    };
    this.showMapText(npc.def.text, npc, unfreeze);
  }

  /** Pallet-to-Brock chapter interactions whose original pointers are
   * TX_SCRIPT rather than plain text: centers, marts, item balls and the
   * first trainer roster. */
  private tryChapterInteraction(npc: NPC): boolean {
    const name = npc.def.name ?? "";
    const flags = this.shell.save.flags;
    if (SAFFRON_GATES[this.map.id] && name.endsWith("_GUARD")) { this.giveGuardDrink(); return true; }
    if (name === "SILPHCO9F_NURSE") { this.shell.healParty(); this.shell.showText("Your POKéMON are healed!"); return true; }
    if (name === "SILPHCO7F_RIVAL") {
      if (flags.EVENT_BEAT_SILPH_CO_RIVAL) return true;
      const starter = this.rivalStarter();
      const index = starter === "SQUIRTLE" ? 6 : starter === "BULBASAUR" ? 7 : 8;
      const party = this.shell.data.trainers?.OPP_RIVAL2?.parties[index];
      if (!party) return false;
      this.shell.showText(`${this.shell.save.player.rival}: Let's see how\nstrong you are!`, () => {
        this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL2", party, () => {
          flags.EVENT_BEAT_SILPH_CO_RIVAL = true;
          this.npcs = this.npcs.filter(candidate => candidate !== npc);
          this.entities = [this.player, ...this.npcs];
        });
      });
      return true;
    }
    if (name === "SILPHCO7F_SILPH_WORKER_M1" || name === "FIGHTINGDOJO_HITMONLEE_POKE_BALL" || name === "FIGHTINGDOJO_HITMONCHAN_POKE_BALL") {
      const lapras = name === "SILPHCO7F_SILPH_WORKER_M1";
      const event = lapras ? "EVENT_GOT_LAPRAS" : "EVENT_GOT_DOJO_POKEMON";
      const species = lapras ? "LAPRAS" : name.includes("HITMONLEE") ? "HITMONLEE" : "HITMONCHAN";
      if (!(lapras ? flags.EVENT_BEAT_SILPH_CO_RIVAL : flags.EVENT_BEAT_KARATE_MASTER || flags.EVENT_BEAT_FIGHTINGDOJO_KARATE_MASTER)) {
        this.shell.showText(lapras ? "Please defeat your rival\nfirst!" : "Defeat the KARATE MASTER\nfirst!");
        return true;
      }
      if (flags[event] || (!lapras && (flags.EVENT_GOT_HITMONLEE || flags.EVENT_GOT_HITMONCHAN))) { this.shell.showText("Take good care of your\nPOKéMON!"); return true; }
      this.shell.showChoice(`Would you like\n${species}?`, yes => {
        if (!yes) return;
        const result = this.shell.receiveGiftPokemon?.(species, lapras ? 15 : 30, event);
        if (result === "full") { this.shell.showText("Your party is full.\nMake room and come back!"); return; }
        if (result !== "granted") return;
        if (!lapras) {
          flags[`EVENT_GOT_${species}`] = true;
          flags.EVENT_DEFEATED_FIGHTING_DOJO = true;
        }
        this.npcs = this.npcs.filter(candidate => this.objectVisible(candidate.def));
        this.entities = [this.player, ...this.npcs];
        this.shell.showText(`You received\n${species}!`);
      });
      return true;
    }
    if (name === "SILPHCO11F_SILPH_PRESIDENT") {
      if (!flags.EVENT_BEAT_SILPH_CO_GIOVANNI) { this.shell.showText("Please help us defeat\nTEAM ROCKET!"); return true; }
      const result = grantItem(this.shell.save, this.shell.data, "EVENT_GOT_MASTER_BALL", "MASTER_BALL");
      this.shell.showText(result === "full" ? "Make room in your BAG\nfor the MASTER BALL!" : result === "already" ? "Thank you for saving\nSILPH CO.!" : "You received the\nMASTER BALL!");
      return true;
    }
    if (name === "POKEMONTOWER7F_MR_FUJI") {
      const rockets = this.map.def.objects.filter(object => object.trainerClass === "OPP_ROCKET");
      if (rockets.some(object => !flags[trainerHeader(this.shell.data, this.map.def, object.index)?.event ?? `EVENT_BEAT_${object.name}`] && !flags[`EVENT_BEAT_${object.name}`])) {
        this.shell.showText("Please defeat the\nTEAM ROCKET trainers!");
        return true;
      }
      const reward = grantItem(this.shell.save, this.shell.data, "EVENT_GOT_POKE_FLUTE", "POKE_FLUTE");
      if (reward === "full") { this.shell.showText("Make room in your BAG\nfor the POKé FLUTE!"); return true; }
      this.shell.save.flags.EVENT_RESCUED_MR_FUJI = true;
      this.npcs = this.npcs.filter(candidate => candidate !== npc);
      this.entities = [this.player, ...this.npcs];
      this.shell.showText("MR. FUJI: You came to\nrescue me!\fYou received the\nPOKé FLUTE!");
      return true;
    }
    if (name === "MRFUJISHOUSE_MR_FUJI") {
      this.shell.showText("MR. FUJI: The POKé FLUTE\ncan wake sleeping POKéMON.");
      return true;
    }
    if (name === "ROUTE12_SNORLAX" || name === "ROUTE16_SNORLAX") {
      const flag = name === "ROUTE12_SNORLAX" ? "EVENT_BEAT_ROUTE12_SNORLAX" : "EVENT_BEAT_ROUTE16_SNORLAX";
      if (!this.shell.save.inventory.POKE_FLUTE) {
        this.shell.showText("It's a sleeping SNORLAX.\nIt won't wake up!");
        return true;
      }
      this.shell.showText("The POKé FLUTE woke up\nSNORLAX!", () => {
        this.shell.pushStubBattle("SNORLAX", 30, () => {
          this.shell.save.flags[flag] = true;
          this.npcs = this.npcs.filter(candidate => candidate !== npc);
          this.entities = [this.player, ...this.npcs];
        });
      });
      return true;
    }
    if (name === "DAYCARE_GENTLEMAN") { this.shell.openDaycare?.(); return true; }
    if (name === "BIKESHOP_CLERK") { this.shell.openBikeShop?.(); return true; }
    if (name === "POKEMONFANCLUB_CHAIRMAN") { this.shell.openFanClub?.(); return true; }
    if (name === "MTMOONPOKECENTER_MAGIKARP_SALESMAN") {
      this.shell.showChoice("A MAGIKARP for just\n¥500! Want it?", (yes) => {
        if (!yes) {
          this.shell.showText("No? Only ¥500...", () => { npc.frozen = false; });
          return;
        }
        const result = this.shell.buyMagikarp();
        const text = result === "bought"
          ? "You bought MAGIKARP!"
          : result === "money"
            ? "You don't have\nenough money."
            : result === "party-full"
              ? "Your party is full."
              : "I already sold you\nthat MAGIKARP.";
        this.shell.showText(text, () => { npc.frozen = false; });
      });
      return true;
    }
    if (name === "CERULEANCITY_ROCKET") {
      const flags = this.shell.save.flags;
      const finish = () => {
        const reward = grantItem(this.shell.save, this.shell.data, "EVENT_GOT_TM28", "TM_DIG");
        flags.EVENT_BEAT_CERULEAN_ROCKET_THIEF = true;
        if (reward === "full") { this.shell.showText("Your BAG is full.\nMake room for TM28."); return; }
        this.shell.showText("You received TM28\n- DIG!", () => {
          this.npcs = this.npcs.filter(n => n !== npc && this.objectVisible(n.def));
          const guard = this.map.def.objects.find(o => o.name === "CERULEANCITY_GUARD1");
          if (guard && !this.npcs.some(n => n.def === guard)) this.npcs.push(this.pooledNPC(this.map.id, guard));
          this.entities = [this.player, ...this.npcs];
        });
      };
      if (flags.EVENT_BEAT_CERULEAN_ROCKET_THIEF || flags.EVENT_BEAT_CERULEANCITY_ROCKET) finish();
      else {
        const party = this.shell.data.trainers?.OPP_ROCKET?.parties[4];
        if (!party) return false;
        this.shell.showText("Hey! Stay out!\nIt's not your yard!", () =>
          this.shell.pushTrainerBattle("ROCKET", "OPP_ROCKET", party, finish));
      }
      return true;
    }
    if (name === "ROUTE24_COOLTRAINER_M1" && !this.shell.save.flags.EVENT_GOT_NUGGET) {
      if (!this.bridgeComplete()) {
        this.shell.showText("Beat our five contest\ntrainers for a prize!");
        return true;
      }
      this.awardNugget(() => this.talkTo(npc));
      return true;
    }
    if (name === "BILLSHOUSE_BILL_POKEMON") {
      this.shell.save.flags.EVENT_MET_BILL = true;
      this.shell.save.flags.EVENT_GOT_SS_TICKET = true;
      this.shell.save.inventory.SS_TICKET = 1;
      this.shell.showText("BILL is back to normal!\fBILL gave you the\nS.S.TICKET!");
      return true;
    }
    if (name === "SSANNECAPTAINSROOM_CAPTAIN") {
      if (!this.shell.save.flags.EVENT_GOT_HM01) {
        this.shell.save.flags.EVENT_GOT_HM01 = true;
        this.shell.save.inventory.HM_CUT = 1;
        this.shell.showText("The CAPTAIN feels\nmuch better!\fYou received HM01\n- CUT!");
      } else {
        this.shell.showText("CAPTAIN: CUT can\nchop down small trees.");
      }
      return true;
    }
    if (name === "SSANNE2F_RIVAL") {
      const starter = this.rivalStarter();
      const index = starter === "SQUIRTLE" ? 1 : starter === "BULBASAUR" ? 2 : 3;
      const party = this.shell.data.trainers?.OPP_RIVAL2?.parties[index - 1];
      if (!party) return false;
      this.shell.showText(`${this.shell.save.player.rival}: Bonjour!\nImagine seeing you here!`, () => {
        this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL2", party, () => {
          this.shell.save.flags.EVENT_BEAT_SS_ANNE_RIVAL = true;
          this.npcs = this.npcs.filter((candidate) => candidate !== npc);
          this.entities = [this.player, ...this.npcs];
          this.shell.showText(`${this.shell.save.player.rival}: Smell ya!`);
        });
      });
      return true;
    }
    if (name.endsWith("POKECENTER_NURSE")) {
      npc.frozen = true;
      npc.facePlayer(this.player);
      this.shell.showChoice("Welcome to our\nPOKéMON CENTER!\nHeal your POKéMON?", (yes) => {
        if (yes) {
          this.shell.healParty();
          this.shell.save.lastHeal = { map: this.map.id, x: 3, y: 6 };
          this.shell.showText("Your POKéMON are\nfighting fit!", () => { npc.frozen = false; });
        } else {
          npc.frozen = false;
        }
      });
      return true;
    }
    if (name.endsWith("MART_CLERK")) {
      const pointers = this.shell.data.text_pointers as
        | Record<string, Record<string, { mart?: string[] }>>
        | undefined;
      const ids = pointers?.[this.map.def.label]?.[npc.def.text]?.mart ?? [];
      const stock = ids.flatMap((item) => {
        const def = this.shell.data.items?.[item];
        return def ? [{ item, price: def.price }] : [];
      });
      this.shell.openMart(stock);
      return true;
    }
    const itemBalls: Record<string, string> = {
      VIRIDIANFOREST_ANTIDOTE: "ANTIDOTE",
      VIRIDIANFOREST_POTION: "POTION",
      VIRIDIANFOREST_POKE_BALL: "POKE_BALL",
      ROUTE2_MOON_STONE: "MOON_STONE",
      ROUTE2_HP_UP: "HP_UP",
      MTMOON1F_POTION1: "POTION",
      MTMOON1F_MOON_STONE: "MOON_STONE",
      MTMOON1F_RARE_CANDY: "RARE_CANDY",
      MTMOON1F_ESCAPE_ROPE: "ESCAPE_ROPE",
      MTMOON1F_POTION2: "POTION",
      MTMOON1F_TM_WATER_GUN: "TM_WATER_GUN",
      MTMOONB2F_HP_UP: "HP_UP",
      MTMOONB2F_TM_MEGA_PUNCH: "TM_MEGA_PUNCH",
      ROUTE4_TM_WHIRLWIND: "TM_WHIRLWIND",
    };
    // Mt. Moon's two fossil sprites are a single story choice.  The ROM
    // leaves both objects on the floor until the Super Nerd has been beaten;
    // taking either one awards exactly one fossil and clears the blocking
    // event so the player can leave the cave.
    if (name === "MTMOONB2F_DOME_FOSSIL" || name === "MTMOONB2F_HELIX_FOSSIL") {
      if (!this.shell.save.flags.EVENT_BEAT_MT_MOON_3_SUPER_NERD) {
        this.shell.showText("The fossils are guarded by\na SUPER NERD.");
        return true;
      }
      this.shell.showChoice("Take the DOME FOSSIL\nor the HELIX FOSSIL?", (dome) => {
        const item = dome ? "DOME_FOSSIL" : "HELIX_FOSSIL";
        this.shell.save.inventory[item] = (this.shell.save.inventory[item] ?? 0) + 1;
        this.shell.save.flags[dome ? "EVENT_GOT_DOME_FOSSIL" : "EVENT_GOT_HELIX_FOSSIL"] = true;
        this.shell.save.flags.EVENT_MT_MOON_FOSSIL_TAKEN = true;
        this.npcs = this.npcs.filter((candidate) =>
          candidate.def.name !== "MTMOONB2F_DOME_FOSSIL" && candidate.def.name !== "MTMOONB2F_HELIX_FOSSIL");
        this.entities = [this.player, ...this.npcs];
        this.shell.showText(`You got the ${item.replaceAll("_", " ")}!`);
      });
      return true;
    }
    const item = itemBalls[name] ?? npc.def.item;
    if (item) {
      const reward = grantItem(this.shell.save, this.shell.data, `EVENT_TAKEN_${name}`, item);
      if (reward === "full") { this.shell.showText("Your BAG is full."); return true; }
      if (reward === "already") return true;
      this.npcs = this.npcs.filter((candidate) => candidate !== npc);
      this.entities = [this.player, ...this.npcs];
      this.shell.showText(`${this.shell.save.player.name} found\n${item.replaceAll("_", " ")}!`);
      return true;
    }
    const trainers: Record<string, { label?: string; trainerClass: string; party?: { species: string; level: number }[]; partyIndex?: number; range?: number; event?: string }> = {
      VIRIDIANFOREST_YOUNGSTER2: { label: "BUG CATCHER RICK", trainerClass: "OPP_BUG_CATCHER", party: [{ species: "WEEDLE", level: 6 }, { species: "CATERPIE", level: 6 }] },
      VIRIDIANFOREST_YOUNGSTER3: { label: "BUG CATCHER DOUG", trainerClass: "OPP_BUG_CATCHER", party: [{ species: "WEEDLE", level: 7 }, { species: "KAKUNA", level: 7 }, { species: "WEEDLE", level: 7 }] },
      VIRIDIANFOREST_YOUNGSTER4: { label: "BUG CATCHER SAMMY", trainerClass: "OPP_BUG_CATCHER", party: [{ species: "WEEDLE", level: 9 }] },
      PEWTERGYM_COOLTRAINER_M: { label: "JR.TRAINER♂ LIAM", trainerClass: "OPP_JR_TRAINER_M", party: [{ species: "DIGLETT", level: 11 }, { species: "SANDSHREW", level: 11 }] },
      PEWTERGYM_BROCK: { label: "BROCK", trainerClass: "OPP_BROCK", party: [{ species: "GEODUDE", level: 12 }, { species: "ONIX", level: 14 }] },
      ROUTE3_YOUNGSTER1: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 4, range: 2, event: "EVENT_BEAT_ROUTE_3_TRAINER_0" },
      ROUTE3_YOUNGSTER2: { trainerClass: "OPP_YOUNGSTER", partyIndex: 1, range: 3, event: "EVENT_BEAT_ROUTE_3_TRAINER_1" },
      ROUTE3_COOLTRAINER_F1: { trainerClass: "OPP_LASS", partyIndex: 1, range: 2, event: "EVENT_BEAT_ROUTE_3_TRAINER_2" },
      ROUTE3_YOUNGSTER3: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 5, range: 1, event: "EVENT_BEAT_ROUTE_3_TRAINER_3" },
      ROUTE3_COOLTRAINER_F2: { trainerClass: "OPP_LASS", partyIndex: 2, range: 4, event: "EVENT_BEAT_ROUTE_3_TRAINER_4" },
      ROUTE3_YOUNGSTER4: { trainerClass: "OPP_YOUNGSTER", partyIndex: 2, range: 3, event: "EVENT_BEAT_ROUTE_3_TRAINER_5" },
      ROUTE3_YOUNGSTER5: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 6, range: 3, event: "EVENT_BEAT_ROUTE_3_TRAINER_6" },
      ROUTE3_COOLTRAINER_F3: { trainerClass: "OPP_LASS", partyIndex: 3, range: 2, event: "EVENT_BEAT_ROUTE_3_TRAINER_7" },
      MTMOON1F_HIKER: { trainerClass: "OPP_HIKER", partyIndex: 1, range: 2, event: "EVENT_BEAT_MT_MOON_1_TRAINER_0" },
      MTMOON1F_YOUNGSTER1: { trainerClass: "OPP_YOUNGSTER", partyIndex: 3, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_1" },
      MTMOON1F_COOLTRAINER_F1: { trainerClass: "OPP_LASS", partyIndex: 5, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_2" },
      MTMOON1F_SUPER_NERD: { trainerClass: "OPP_SUPER_NERD", partyIndex: 1, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_3" },
      MTMOON1F_COOLTRAINER_F2: { trainerClass: "OPP_LASS", partyIndex: 6, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_4" },
      MTMOON1F_YOUNGSTER2: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 7, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_5" },
      MTMOON1F_YOUNGSTER3: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 8, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_6" },
      MTMOONB2F_SUPER_NERD: { trainerClass: "OPP_SUPER_NERD", partyIndex: 2, event: "EVENT_BEAT_MT_MOON_3_SUPER_NERD" },
      MTMOONB2F_ROCKET1: { trainerClass: "OPP_ROCKET", partyIndex: 1, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_0" },
      MTMOONB2F_ROCKET2: { trainerClass: "OPP_ROCKET", partyIndex: 2, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_1" },
      MTMOONB2F_ROCKET3: { trainerClass: "OPP_ROCKET", partyIndex: 3, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_2" },
      MTMOONB2F_ROCKET4: { trainerClass: "OPP_ROCKET", partyIndex: 4, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_3" },
      ROUTE4_COOLTRAINER_F2: { trainerClass: "OPP_LASS", partyIndex: 4, range: 3, event: "EVENT_BEAT_ROUTE_4_TRAINER_0" },
      CERULEANGYM_COOLTRAINER_F: { trainerClass: "OPP_JR_TRAINER_F", partyIndex: 1, range: 3, event: "EVENT_BEAT_CERULEAN_GYM_TRAINER_0" },
      CERULEANGYM_SWIMMER: { trainerClass: "OPP_SWIMMER", partyIndex: 1, range: 3, event: "EVENT_BEAT_CERULEAN_GYM_TRAINER_1" },
      VERMILIONGYM_LT_SURGE: { label: "LT. SURGE", trainerClass: "OPP_LT_SURGE", partyIndex: 1, event: "EVENT_BEAT_LT_SURGE" },
      CELADONGYM_ERIKA: { label: "ERIKA", trainerClass: "OPP_ERIKA", partyIndex: 1, event: "EVENT_BEAT_ERIKA" },
      CERULEANGYM_MISTY: { label: "MISTY", trainerClass: "OPP_MISTY", partyIndex: 1, event: "EVENT_BEAT_MISTY" },
    };
    const header = trainerHeader(this.shell.data, this.map.def, npc.def.index);
    const trainer = trainers[name] ?? (npc.def.trainerClass && npc.def.trainerParty
      ? {
          trainerClass: npc.def.trainerClass,
          partyIndex: npc.def.trainerParty,
          event: header?.event ?? `EVENT_BEAT_${name}`,
        }
      : undefined);
    if (!trainer) return false;
    const trainerDef = this.shell.data.trainers?.[trainer.trainerClass];
    const party = trainer.party ?? trainerDef?.parties[(trainer.partyIndex ?? 1) - 1];
    if (!party?.length) return false;
    const label = trainer.label ?? trainerDef?.name ?? "TRAINER";
    const forestFlag: Record<string, string> = {
      VIRIDIANFOREST_YOUNGSTER2: "EVENT_BEAT_VIRIDIAN_FOREST_TRAINER_0",
      VIRIDIANFOREST_YOUNGSTER3: "EVENT_BEAT_VIRIDIAN_FOREST_TRAINER_1",
      VIRIDIANFOREST_YOUNGSTER4: "EVENT_BEAT_VIRIDIAN_FOREST_TRAINER_2",
      PEWTERGYM_COOLTRAINER_M: "EVENT_BEAT_PEWTER_GYM_TRAINER_0",
    };
    const beatFlag = header?.event ?? trainer.event ?? (name === "PEWTERGYM_BROCK" ? "EVENT_BEAT_BROCK" : (forestFlag[name] ?? `EVENT_BEAT_${name}`));
    if (this.shell.save.flags[beatFlag] || this.shell.save.flags[`EVENT_BEAT_${name}`]) {
      if (name === "ROCKETHIDEOUTB4F_ROCKET3") {
        this.shell.save.flags.EVENT_ROCKET_DROPPED_LIFT_KEY = true;
        this.refreshChapterObjects();
        this.shell.showText("I dropped the LIFT KEY!"); return true;
      }
      if (GYM_REWARDS[name] && !this.shell.save.flags[GYM_REWARDS[name].event]) { this.giveGymReward(name); return true; }
      if (name === "PEWTERGYM_BROCK") {
        this.shell.showText("Go to the GYM in\nCERULEAN and test\nyour abilities!");
        return true;
      }
      const afterKey = header?.won ?? header?.after;
      const after = afterKey && (this.shell.data.text as Record<string, string> | undefined)?.[afterKey];
      this.shell.showText(after || `${label} was defeated!`);
      return true;
    }
    npc.frozen = true;
    npc.facePlayer(this.player);
    const pre = (header?.battle && (this.shell.data.text as Record<string, string> | undefined)?.[header.battle]) || this.resolveText(npc.def.text) || `${label} wants\nto battle!`;
    this.shell.showText(pre, () => this.shell.pushTrainerBattle(label, trainer.trainerClass, party, () => {
      this.shell.save.flags[beatFlag] = true;
      this.shell.save.flags[`EVENT_BEAT_${name}`] = true;
      this.refreshChapterDoors();
      if (name === "FIGHTINGDOJO_KARATE_MASTER") this.shell.save.flags.EVENT_BEAT_KARATE_MASTER = true;
      if (name === "SILPHCO11F_GIOVANNI") {
        this.shell.save.flags.EVENT_BEAT_SILPH_CO_GIOVANNI = true;
        this.npcs = this.npcs.filter(candidate => this.objectVisible(candidate.def));
        this.entities = [this.player, ...this.npcs];
      }
      if (name === "ROCKETHIDEOUTB4F_GIOVANNI") {
        this.shell.save.flags.EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI = true;
        this.shell.showText("GIOVANNI dropped something!\fThe SILPH SCOPE is now\nwithin reach.");
      }
      npc.frozen = false;
      if (name === "ROCKETHIDEOUTB4F_GIOVANNI") {
        this.refreshChapterObjects();
      } else if (name === "GAMECORNER_ROCKET" || (this.map.id === "POKEMON_TOWER_7F" && trainer.trainerClass === "OPP_ROCKET")) {
        this.refreshChapterObjects();
      } else if (GYM_REWARDS[name]) {
        this.giveGymReward(name);
      } else if (this.map.id === "ROUTE_24" && this.bridgeComplete() && !this.shell.save.flags.EVENT_GOT_NUGGET) {
        this.awardNugget();
      } else {
        this.shell.showText(`${label} was\ndefeated!`);
      }
    }));
    return true;
  }

  private giveGymReward(name: string): void {
    const reward = GYM_REWARDS[name];
    this.shell.save.inventory[reward.badge] = 1;
    const result = grantItem(this.shell.save, this.shell.data, reward.event, reward.tm);
    this.shell.showText(result === "full"
      ? `You earned the\n${reward.badge}!\fYour BAG is full.\nCome back for your TM.`
      : `You received the\n${reward.badge}!\fYou received\n${reward.tm.replaceAll("_", " ")}!`);
  }

  private bridgeComplete(): boolean {
    return [3, 4, 5, 6, 7].every(index => {
      const obj = this.map.def.objects.find(o => o.index === index);
      const header = trainerHeader(this.shell.data, this.map.def, index);
      return !!(header && this.shell.save.flags[header.event] ||
        obj && this.shell.save.flags[`EVENT_BEAT_${obj.name}`]);
    });
  }

  private awardNugget(done?: () => void): void {
    if (!this.shell.save.flags.EVENT_GOT_NUGGET) {
      this.shell.save.inventory.NUGGET = (this.shell.save.inventory.NUGGET ?? 0) + 1;
      this.shell.save.flags.EVENT_GOT_NUGGET = true;
    }
    this.shell.showText("You beat all five!\fYou received a NUGGET!", done);
  }

  private tryChooseStarter(npc: NPC): boolean {
    if (this.map.id !== "OAKS_LAB" || this.shell.save.flags.EVENT_GOT_STARTER) return false;
    const species = npc.def.name?.match(/^OAKSLAB_(BULBASAUR|CHARMANDER|SQUIRTLE)_POKE_BALL$/)?.[1] as
      | "BULBASAUR"
      | "CHARMANDER"
      | "SQUIRTLE"
      | undefined;
    if (!species) return false;
    const kind = species === "BULBASAUR" ? "plant" : species === "CHARMANDER" ? "fire" : "water";
    this.shell.showChoice(`So! You want the\n${kind} POKéMON,\n${species}?`, (yes) => {
      if (!yes) return;
      this.shell.chooseStarter(species);
      this.shell.showText(`${this.shell.save.player.name} received\na ${species}!`);
      this.npcs = this.npcs.filter((candidate) => this.objectVisible(candidate.def));
      this.entities = [this.player, ...this.npcs];
    });
    return true;
  }

  // OverworldController.lua:3241 showMapText — a TEXT_* constant goes to the
  // map's hand-ported script if it has one (MapScripts.lua:239 talkScript),
  // and to the plain extracted line otherwise. The scripted path is what
  // makes a text_asm branch branch: the extracted text of one of those
  // pointers is only ever its FIRST case, so without the script Mom reads the
  // wake-up line forever and Oak never stops warning you about the grass.
  showMapText(textConst: string, npc?: NPC, onDone?: () => void): void {
    const script = talkScript(this.map.id, textConst);
    if (script && !this.runner.isRunning()) {
      if (npc) npc.frozen = true;
      this.runner.run(script, {
        npc,
        onDone: () => {
          if (this.oneShotPending) {
            // Music.lua:403 oneShotPlaying holds the script until the jingle
            // ends and Music.update restores the theme; this surface cannot
            // ask, so the theme comes back when the script does.
            this.oneShotPending = false;
            this.shell.restoreMapMusic();
          }
          onDone?.();
        },
      });
      return;
    }
    const text = this.resolveText(textConst);
    if (text !== null) {
      if (npc) npc.facePlayer(this.player);
      this.shell.showText(text, onDone);
    } else {
      onDone?.();
    }
  }

  // ScriptWorld (script.ts) — the services a command reaches -------------

  /** Commands.lua:587 heal_party. */
  healParty(): void {
    this.shell.healParty();
  }

  /** Commands.lua:533 play_once — see showMapText's restore note. */
  playOnce(songId: string, onDone: () => void): void {
    this.oneShotPending = true;
    this.shell.playOnce(songId);
    onDone();
  }

  /**
   * Commands.lua:1216 fade — the overlay ramps to the colour and back. The
   * voxel surface has no overlay op, so the port spends the ramp's frames the
   * way it spends every other fade's (game.ts WarpFadeState holds the world).
   */
  fade(_dir: "in" | "out", frames: number, onDone: () => void): void {
    this.shell.pushWarpFade(frames, () => {}, onDone);
  }

  /** Commands.lua:162 face_player. */
  facePlayer(npc: NPC): void {
    npc.facePlayer(this.player);
  }

  // src/core/Data.lua:304 resolveText — map label + TEXT_* const through
  // text_pointers; a text_asm entry falls back to its extracted _Label
  // string when one exists (#318).
  resolveText(textConst: string): string | null {
    const pointers = this.shell.data.text_pointers as
      | Record<string, Record<string, { label?: string; text?: string; asm?: boolean }>>
      | undefined;
    const texts = this.shell.data.text as Record<string, string> | undefined;
    const entry = pointers?.[this.map.def.label]?.[textConst];
    if (!entry || !texts) return null;
    if (entry.text) {
      const s = texts[entry.text];
      if (s) return s;
    }
    if (entry.label) {
      const s = texts[`_${entry.label}`];
      if (s) return s;
    }
    return null;
  }

  // OverworldController.lua:1713
  npcAtCell(cx: number, cy: number): NPC | undefined {
    return this.npcs.find(
      (npc) =>
        (npc.cellX === cx && npc.cellY === cy) || (npc.targetX === cx && npc.targetY === cy),
    );
  }

  private touchWild(dir: Dir): boolean {
    if (this.pokemonPilot) return false;
    if (!this.shell.data.partyIcons || !this.shell.save.party?.some(mon => mon.hp > 0)) return false;
    const [x, y] = target(this.player.cellX, this.player.cellY, dir);
    const wild = this.wild.atCell(x, y);
    if (!wild || !canMove(this.map, this.entities, this.player, dir, this.tilePairs).ok) return false;
    const enc = this.wild.consume(wild);
    this.encounterCount++;
    this.lastEncounter = enc;
    this.shell.pushStubBattle(enc.species, enc.level);
    return true;
  }

  // OverworldController.lua:3361 onStepComplete — the completed-step
  // land-triggers, in the original's order: warp-entry staleness, the
  // standing-on-warp refresh, arrival/held-collision warps, then the wild
  // encounter roll. (Spinners, badge gates, forced movement, Safari,
  // poison and repel are outside the slice.)
  onStepComplete(): void {
    this.shell.onFieldStep?.();
    const p = this.player;
    if (this.tryChapterStep()) return;
    if (this.tryLabExitGate()) return;
    if (this.tryLabRivalEvent()) return;
    if (this.tryPalletOakEvent()) return;
    if (this.tryRoute22RivalEvent()) return;
    if (this.tryCeruleanRivalEvent()) return;
    if (this.tryPokemonTowerRivalEvent()) return;
    if (this.map.id === "SILPH_CO_7F" && !this.shell.save.flags.EVENT_BEAT_SILPH_CO_RIVAL &&
        this.player.cellX === 3 && (this.player.cellY === 2 || this.player.cellY === 3)) {
      const rival = this.npcs.find(npc => npc.def.name === "SILPHCO7F_RIVAL");
      if (rival && this.tryChapterInteraction(rival)) return;
    }
    if (this.tryTrainerSight()) return;
    // The arrival disable is POSITIONAL (issue #265): the cell we warped in
    // on is inert until we step off it; pokered has no one-shot counter —
    // every completed step runs CheckWarpsNoCollision.
    let entry = this.warpEntryCell;
    if (entry && (p.cellX !== entry.x || p.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
      entry = undefined;
    }
    // BIT_STANDING_ON_WARP maintenance: cleared before the check, set again
    // on a warp square, cleared once more when the square is warp-activating
    // but not a door (home/overworld.asm:324 + player_state.asm).
    this.refreshStandingOnWarp();
    if (!entry) {
      // CheckWarpsNoCollision: door/warp tiles fire immediately; otherwise
      // ExtraWarpCheck must pass AND a d-pad is held.
      let w = onArrive(this.map, p.cellX, p.cellY);
      if (!w && this.dirHeld()) {
        w = onCollision(this.map, this.carpets, p.cellX, p.cellY, p.facing);
      }
      if (w) {
        this.takeWarp(w.def);
        return;
      }
    }
    // Cooked icon-enabled builds use contact encounters. Legacy/raw packs
    // without icon assets retain step encounters instead of invisible wilds.
    if (this.shell.data.partyIcons) return;
    // wild encounters in grass, on water while surfing, or — on indoor maps
    // whose tileset is not FOREST — on EVERY tile (wild_encounters.asm)
    const encDef = this.shell.data.encounters[this.map.id] as EncounterDef | undefined;
    const indoor = (this.shell.data.field as {
      indoorEncounters?: { firstIndoorMap: number; excludedTileset: string };
    })?.indoorEncounters;
    let enc: { species: string; level: number } | null = null;
    if (p.surfing && encDef?.water && this.map.isWaterCell(p.cellX, p.cellY)) {
      enc = encounterRoll({ grass: encDef.water }, this.shell.rng);
    } else if (this.map.isGrassCell(p.cellX, p.cellY)) {
      enc = encounterRoll(encDef, this.shell.rng);
    } else if (
      indoor &&
      this.map.def.index >= indoor.firstIndoorMap &&
      this.map.def.tileset !== indoor.excludedTileset
    ) {
      enc = encounterRoll(encDef, this.shell.rng);
    }
    if (enc) {
      this.encounterCount += 1;
      this.lastEncounter = enc;
      // BATTLE-PORT SEAM: the real battle state machine replaces this push
      // in a later task (BattleState.newWild in the reference).
      this.shell.pushStubBattle(enc.species, enc.level);
    }
  }

  /** All cooked trainers use their imported sight range and defeat flag. */
  private tryTrainerSight(): boolean {
    if (this.fieldTrainer) return false;
    const dirs: Record<string, Dir> = {
      LEFT: "left", RIGHT: "right", UP: "up", DOWN: "down",
    };
    for (const npc of this.npcs) {
      const header = trainerHeader(this.shell.data, this.map.def, npc.def.index);
      const range = header?.range ?? 0;
      const dir = dirs[npc.def.range ?? ""];
      if (!npc.def.trainerClass || !header || range <= 0 || !dir ||
          this.shell.save.flags[header.event] || this.shell.save.flags[`EVENT_BEAT_${npc.def.name}`]) continue;
      const dx = this.player.cellX - npc.cellX;
      const dy = this.player.cellY - npc.cellY;
      const distance = Math.abs(dx) + Math.abs(dy);
      const aligned =
        (dir === "left" && dy === 0 && dx < 0) ||
        (dir === "right" && dy === 0 && dx > 0) ||
        (dir === "up" && dx === 0 && dy < 0) ||
        (dir === "down" && dx === 0 && dy > 0);
      if (!aligned || distance > range) continue;
      let clear = true;
      for (let step = 1; step < distance; step++) {
        const x = npc.cellX + (dx === 0 ? 0 : Math.sign(dx) * step);
        const y = npc.cellY + (dy === 0 ? 0 : Math.sign(dy) * step);
        if (!this.map.isWalkableCell(x, y) || this.npcAtCell(x, y)) { clear = false; break; }
      }
      if (!clear) continue;
      npc.frozen = true;
      npc.facing = dir;
      this.shell.showText("!", () => {
        this.scriptMove(npc, dir, Math.max(0, distance - 1), () => this.talkTo(npc));
      });
      return true;
    }
    return false;
  }

  private tryLabExitGate(): boolean {
    const flags = this.shell.save.flags;
    if (
      this.map.id !== "OAKS_LAB" || this.player.cellY < 6 ||
      !flags.EVENT_FOLLOWED_OAK_INTO_LAB || flags.EVENT_GOT_STARTER
    ) return false;
    const text = this.shell.data.text as Record<string, string> | undefined;
    this.shell.showText(text?._OaksLabOakDontGoAwayYetText ?? "OAK: Wait!\nDon't go away yet!", () => {
      this.scriptMove(this.player, "up", 1);
    });
    return true;
  }

  private tryLabRivalEvent(): boolean {
    const flags = this.shell.save.flags;
    if (
      this.map.id !== "OAKS_LAB" || this.player.cellY < 6 ||
      !flags.EVENT_GOT_STARTER || flags.EVENT_BATTLED_RIVAL_IN_OAKS_LAB
    ) return false;
    const rivalSpecies = flags.EVENT_CHOSE_BULBASAUR
      ? "CHARMANDER"
      : flags.EVENT_CHOSE_CHARMANDER
        ? "SQUIRTLE"
        : "BULBASAUR";
    const text = this.shell.data.text as Record<string, string> | undefined;
    this.shell.showText(
      text?._OaksLabRivalIllTakeYouOnText ?? "BLUE: Wait!\nLet's check out our\nPOKéMON!",
      () => {
        flags.EVENT_BATTLED_RIVAL_IN_OAKS_LAB = true;
        this.shell.pushTrainerBattle("RIVAL BLUE", "OPP_RIVAL1", [{ species: rivalSpecies, level: 5 }], () => {});
      },
    );
    return true;
  }

  private rivalStarter(): "BULBASAUR" | "CHARMANDER" | "SQUIRTLE" {
    const flags = this.shell.save.flags;
    return flags.EVENT_CHOSE_BULBASAUR ? "CHARMANDER"
      : flags.EVENT_CHOSE_CHARMANDER ? "SQUIRTLE" : "BULBASAUR";
  }

  /** Route22.asm first rival encounter at (29,4)/(29,5), parties 4..6. */
  private tryRoute22RivalEvent(): boolean {
    const flags = this.shell.save.flags;
    const p = this.player;
    if (this.map.id !== "ROUTE_22" || !flags.EVENT_GOT_STARTER ||
        flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE ||
        !((p.cellX === 29 && p.cellY === 4) || (p.cellX === 29 && p.cellY === 5))) return false;
    const starter = this.rivalStarter();
    const index = starter === "SQUIRTLE" ? 4 : starter === "BULBASAUR" ? 5 : 6;
    const party = this.shell.data.trainers?.OPP_RIVAL1?.parties[index - 1];
    if (!party) return false;
    this.shell.showText(`${this.shell.save.player.rival}: Hey!\nYou're going to the\nPOKéMON LEAGUE?`, () => {
      this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL1", party, () => {
        flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE = true;
        this.shell.showText(`${this.shell.save.player.rival}: Smell you later!`);
      });
    });
    return true;
  }

  /** CeruleanCity.asm bridge approach at (20,6)/(21,6), parties 7..9. */
  private tryCeruleanRivalEvent(): boolean {
    const flags = this.shell.save.flags;
    const p = this.player;
    if (this.map.id !== "CERULEAN_CITY" || flags.EVENT_BEAT_CERULEAN_RIVAL ||
        !((p.cellX === 20 || p.cellX === 21) && p.cellY === 6)) return false;
    const starter = this.rivalStarter();
    const index = starter === "SQUIRTLE" ? 7 : starter === "BULBASAUR" ? 8 : 9;
    const party = this.shell.data.trainers?.OPP_RIVAL1?.parties[index - 1];
    if (!party) return false;
    const def = this.map.def.objects.find(o => o.name === "CERULEANCITY_RIVAL");
    const rival = def ? new NPC(this.map.id, def, this.shell.npcRng) : undefined;
    if (rival) {
      rival.cellX = p.cellX; rival.cellY = p.cellY - 1;
      rival.px = rival.cellX * 16; rival.py = rival.cellY * 16;
      rival.frozen = true;
      this.npcs.push(rival); this.entities = [p, ...this.npcs];
    }
    p.facing = "up";
    this.shell.showText(`${this.shell.save.player.rival}: Yo!\nYou're still struggling\nalong back here?`, () => {
      this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL1", party, () => {
        flags.EVENT_BEAT_CERULEAN_RIVAL = true;
        this.shell.showText(`${this.shell.save.player.rival}: I went to see\nBILL! Smell ya!`, () => {
          if (!rival) return;
          this.scriptMove(rival, rival.cellX === 20 ? "right" : "left", 1, () =>
            this.scriptMove(rival, "down", 6, () => {
              this.npcs = this.npcs.filter(n => n !== rival);
              this.entities = [this.player, ...this.npcs];
            }));
        });
      });
    });
    return true;
  }

  /** Pokémon Tower 2F rival ambush (PokemonTower2F.asm). */
  private tryPokemonTowerRivalEvent(npc?: NPC): boolean {
    const flags = this.shell.save.flags;
    if (this.map.id !== "POKEMON_TOWER_2F" || flags.EVENT_BEAT_POKEMON_TOWER_RIVAL) return false;
    const rival = npc ?? this.npcs.find(n => n.def.name === "POKEMONTOWER2F_RIVAL");
    if (!rival) return false;
    const playerX = this.player.cellX;
    const playerY = this.player.cellY;
    const adjacent = (playerX === 14 && playerY === 6) || (playerX === 15 && playerY === 5);
    if (!npc && !adjacent) return false;
    if (npc && Math.abs(playerX - rival.cellX) + Math.abs(playerY - rival.cellY) > 1) return false;
    if (rival.def.name !== "POKEMONTOWER2F_RIVAL") return false;
    const starter = this.rivalStarter();
    const index = starter === "SQUIRTLE" ? 4 : starter === "BULBASAUR" ? 5 : 6;
    const party = this.shell.data.trainers?.OPP_RIVAL2?.parties[index - 1];
    if (!party) return false;
    rival.frozen = true;
    rival.facePlayer(this.player);
    const exit = playerX === 15
      ? ["down", "down", "right", "right", "right", "right", "down", "down"] as const
      : ["right", "down", "down", "right", "down", "down", "right", "right"] as const;
    this.shell.showText(`${this.shell.save.player.rival}: What brings you
here?`, () => {
      this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL2", party, () => {
        flags.EVENT_BEAT_POKEMON_TOWER_RIVAL = true;
        this.shell.showText(`${this.shell.save.player.rival}: How's your
POKéDEX coming?`, () => {
          const walk = (i: number) => {
            if (i >= exit.length) {
              this.npcs = this.npcs.filter(n => n !== rival);
              this.entities = [this.player, ...this.npcs];
              return;
            }
            this.scriptMove(rival, exit[i], 1, () => walk(i + 1));
          };
          walk(0);
        });
      });
    });
    return true;
  }

  /** PalletTownOakHeyWaitScript, before warp and encounter processing. */
  private tryPalletOakEvent(): boolean {
    const flags = this.shell.save.flags;
    if (
      this.map.id !== "PALLET_TOWN" ||
      this.player.cellY !== 1 ||
      flags.EVENT_FOLLOWED_OAK_INTO_LAB ||
      this.oakEventRunning
    ) {
      return false;
    }
    this.oakEventRunning = true;
    this.player.facing = "down";
    const text = this.shell.data.text as Record<string, string> | undefined;
    const walkPath = (entity: Player | NPC, steps: Dir[], done?: () => void): void => {
      const next = (i: number): void => {
        const dir = steps[i];
        if (!dir) { done?.(); return; }
        this.scriptMove(entity, dir, 1, () => next(i + 1));
      };
      next(0);
    };
    this.shell.showText(
      text?._PalletTownOakHeyWaitDontGoOutText ?? "OAK: Hey! Wait!\nDon't go out!",
      () => {
        const oakDef = this.map.def.objects.find((obj) => obj.name === "PALLETTOWN_OAK");
        if (!oakDef) { this.oakEventRunning = false; return; }
        const oak = new NPC(this.map.id, oakDef, this.shell.npcRng);
        oak.frozen = true;
        // Keep the escort synchronized with the current player setting.
        // Music-on mode deliberately lengthens player steps, so Oak must use
        // that same duration instead of the NPC default or he pulls ahead.
        oak.stepFrames = this.player.stepFrames;
        this.npcs.push(oak);
        this.entities = [this.player, ...this.npcs];
        const approach: Dir[] = [];
        while (oak.cellX + approach.filter((d) => d === "right").length - approach.filter((d) => d === "left").length !== this.player.cellX) {
          const projected = oak.cellX + approach.filter((d) => d === "right").length - approach.filter((d) => d === "left").length;
          approach.push(projected < this.player.cellX ? "right" : "left");
        }
        approach.push("up", "up", "up");
        walkPath(oak, approach, () => this.shell.showText(
          text?._PalletTownOakItsUnsafeText ?? "OAK: It's unsafe!\nWild POKéMON live\nin tall grass!",
          () => {
            const oakSteps: Dir[] = ["down", "down", "down", "down", "down", "left", "down", "down", "down", "down", "down", "right", "right", "right", "up"];
            const playerSteps: Dir[] = ["down", ...oakSteps];
            walkPath(oak, oakSteps);
            walkPath(this.player, playerSteps, () => {
              // This is a fully scripted entrance. Do not arm the generic
              // door walk-out: it would queue a south step at the same time
              // as the escort queues its northbound lab path. The desktop
              // scheduler happened to serialize those moves, but the PSP
              // could stall on that conflicting transition-frame pair.
              this.doorWarp = false;
              this.shell.audio.playSfx("Go_Inside");
              this.startWarpTo("OAKS_LAB", 5, 11, "up", () => {
                const labOakDef = this.map.def.objects.find((obj) => obj.name === "OAKSLAB_OAK2");
                if (labOakDef) {
                  const labOak = new NPC(this.map.id, labOakDef, this.shell.npcRng);
                  labOak.frozen = true;
                  this.npcs.push(labOak);
                  this.entities = [this.player, ...this.npcs];
                  walkPath(labOak, ["up", "up", "up"]);
                }
                // Seven north steps from y=11 reaches the same y=4 endpoint
                // as the old automatic south step followed by eight north.
                walkPath(this.player, ["up", "up", "up", "up", "up", "up", "up"], () => {
                  flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
                  flags.EVENT_FOLLOWED_OAK_INTO_LAB_2 = true;
                  flags.EVENT_OAK_ASKED_TO_CHOOSE_MON = true;
                  this.shell.showText(text?._OaksLabOakChooseMonText ?? "OAK: Choose a POKéMON!", () => {
                    this.oakEventRunning = false;
                  });
                });
              });
            });
          },
        ));
      },
    );
    return true;
  }

  // OverworldController.lua:3907 takeWarp
  takeWarp(warpDef: MapWarp): void {
    const elevator = this.map.id.endsWith("_ELEVATOR");
    if (warpDef.destMap.endsWith("_ELEVATOR")) {
      (this.shell.save.elevatorFloors ??= {})[warpDef.destMap] = this.map.id;
    }
    if (elevator) {
      const fallback = this.map.id === "SILPH_CO_ELEVATOR" ? "SILPH_CO_1F" : this.map.id === "ROCKET_HIDEOUT_ELEVATOR" ? "ROCKET_HIDEOUT_B1F" : "CELADON_MART_1F";
      const floor = this.shell.save.elevatorFloors?.[this.map.id] ?? (this.map.id === "SILPH_CO_ELEVATOR" ? this.shell.save.silphElevatorFloor : undefined) ?? fallback;
      const index = this.shell.data.maps?.[floor]?.warps.findIndex(warp => warp.destMap === this.map.id) ?? -1;
      if (index < 0) return;
      warpDef = { ...warpDef, destMap: floor, destWarp: index + 1 };
    }
    if (this.map.id === "GAME_CORNER" && warpDef.destMap === "ROCKET_HIDEOUT_B1F" && !this.shell.save.flags.EVENT_FOUND_ROCKET_HIDEOUT) return;
    if (this.map.id === "POKEMON_TOWER_6F" && warpDef.destMap === "POKEMON_TOWER_7F" && !this.shell.save.flags.EVENT_BEAT_GHOST_MAROWAK) {
      this.startTowerGhost(); return;
    }
    if (this.map.id === "SAFFRON_CITY" && warpDef.destMap === "SILPH_CO_1F" && !this.shell.save.flags.EVENT_RESCUED_MR_FUJI && !this.shell.save.flags.EVENT_BEAT_SILPH_CO_GIOVANNI) {
      this.shell.showText("TEAM ROCKET is blocking\nthe entrance."); return;
    }
    if (this.map.id === "SAFFRON_CITY" && warpDef.destMap === "SAFFRON_GYM" && !this.shell.save.flags.EVENT_BEAT_SILPH_CO_GIOVANNI) {
      this.shell.showText("Free SILPH CO. from\nTEAM ROCKET first!"); return;
    }
    let last = this.lastOutdoor;
    if (warpDef.destMap === "LAST_MAP" && !last) {
      // old saves / unexpected states: never crash on an exit mat — fall
      // back to the remembered heal point (OverworldController.lua:3909)
      const heal = this.shell.save.lastHeal;
      if (heal) last = { id: heal.map, x: heal.x, y: heal.y };
    }
    if (warpDef.destMap === "LAST_MAP") {
      last = physicalExit(this.shell.data, this.map.id, warpDef, last) ?? last;
    }
    const dest = destination(this.shell.data, warpDef, last);
    // A player already inside must always be able to leave, including old
    // saves that entered through the rear before meeting Bill.
    if (this.map.id === "CERULEAN_TRASHED_HOUSE" && dest.map === "CERULEAN_CITY") {
      this.shell.save.flags.EVENT_CERULEAN_HOUSE_OPEN = true;
    }
    // VermilionDockScript: the sailor checks the S.S.TICKET before admitting
    // Red. Once HM01 has been collected and the ship has been exited, it
    // departs and cannot be boarded again.
    if (this.map.id === "VERMILION_CITY" && dest.map === "VERMILION_DOCK") {
      if (this.shell.save.flags.EVENT_SS_ANNE_LEFT) {
        this.shell.showText("The S.S.ANNE has\nset sail!");
        return;
      }
      if (!this.shell.save.inventory.SS_TICKET) {
        this.shell.showText("You need an\nS.S.TICKET to board!");
        return;
      }
    }
    if (
      this.map.id === "SS_ANNE_1F" &&
      dest.map === "VERMILION_DOCK" &&
      this.shell.save.flags.EVENT_GOT_HM01
    ) {
      this.shell.save.flags.EVENT_SS_ANNE_LEFT = true;
    }
    // facing carries across the warp (leaving a gate sideways keeps you
    // walking sideways; house exit mats are stepped onto facing down)
    const facing = this.player.facing;
    // warp pads and fall-through holes are not doors (WarpFound2
    // .indoorMaps): no door SFX, no walk-out step
    const pad = this.map.warpPadOrHoleAt(this.player.cellX, this.player.cellY);
    if (pad === undefined) {
      this.doorWarp = true; // door SFX + PlayerStepOutFromDoor walk-out
    }
    this.startWarpTo(dest.map, dest.x, dest.y, facing);
  }

  // OverworldController.lua:3949 rememberOutdoor (pokered's wLastMap)
  rememberOutdoor(id: string, x: number, y: number): void {
    this.lastOutdoor = { id, x, y };
    this.shell.save.lastOutdoor = this.lastOutdoor;
  }

  // OverworldController.lua:4004 startWarpTo — the fade out (32 ticks,
  // Timing WARP_FADE_OUT), the map switch at the midpoint, no fade back in
  // (LoadGBPal restores the palettes in one write).
  startWarpTo(
    mapId: string,
    x: number,
    y: number,
    facing?: Dir,
    onDone?: () => void,
    rememberSource = true,
  ): void {
    if (!this.isCooked(mapId)) {
      // The door is locked: a warp into a map the pak has no geometry for
      // would land the player in an invisible world. The warp never happens,
      // so nothing it staged may survive it — a doorWarp left armed here
      // would spend itself on the NEXT warp, walking the player out of a
      // door they did not enter — and a parked script must be resumed or the
      // runner never wakes (ScriptRunner.lua:197 resume).
      this.doorWarp = false;
      onDone?.();
      return;
    }
    // ANY transition off an outdoor map remembers the outdoor side, so
    // LAST_MAP exits keep working (CheckIfInOutsideMap includes PLATEAU).
    if (rememberSource && isOutside(this.map.def) && mapId !== this.map.id) {
      this.rememberOutdoor(this.map.id, this.player.cellX, this.player.cellY);
    }
    this.transitioning = true;
    const doorWarp = this.doorWarp;
    this.doorWarp = false;
    this.shell.pushWarpFade(
      WARP_FADE_OUT,
      () => {
        this.setMap(mapId, x, y, facing ?? "down");
        // Entering the lab voluntarily means Oak no longer needs to fetch
        // the player from Pallet's grass. It does not grant a starter.
        if (mapId === "OAKS_LAB") {
          this.shell.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
          this.shell.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB_2 = true;
        }
        // The warp we land ON stays inert until we physically step off it,
        // so a warp whose destination cell is itself a warp cannot bounce
        // us straight back. BIT_STANDING_ON_WARP is deliberately NOT
        // touched here: the flag the departing tile set rides through the
        // warp (issue #378).
        this.warpEntryCell = { x, y };
        if (doorWarp) {
          // OverworldController.lua:4053: the cue is chosen by where you
          // LANDED, and it plays for every door warp — the door-tile test
          // below only gates the walk-out step.
          this.shell.audio.playSfx(isOutside(this.map.def) ? "Go_Outside" : "Go_Inside");
        }
        if (doorWarp && this.map.isDoorTileCell(this.player.cellX, this.player.cellY)) {
          // PlayerStepOutFromDoor: any warp landing on a door tile
          // auto-steps south once. The walk-out is a simulated d-pad press,
          // so it obeys collision; a blocked landing keeps the player on
          // the door with the arrival disable intact.
          if (canMove(this.map, this.entities, this.player, "down", this.tilePairs).ok) {
            this.warpEntryCell = undefined;
            this.scriptMove(this.player, "down", 1);
          } else {
            this.player.facing = "down";
          }
        }
      },
      () => {
        this.transitioning = false;
        onDone?.();
      },
    );
  }

  // OverworldController.lua:4172 scriptMove
  scriptMove(entity: Player | NPC, dir: Dir, tiles: number, onDone?: () => void): void {
    this.scriptMoves.push({ entity, dir, remaining: tiles, onDone });
  }

  // OverworldController.lua:4195 updateScriptMoves — two phases so a
  // chained step begins the SAME frame the previous one ends: phase 1
  // retires finished moves (which may chain new ones); phase 2 starts
  // every not-yet-moving move.
  updateScriptMoves(): void {
    let i = 0;
    while (i < this.scriptMoves.length) {
      const mv = this.scriptMoves[i];
      if (!mv.entity.moving && mv.remaining <= 0) {
        this.scriptMoves.splice(i, 1);
        mv.onDone?.();
        // don't advance i: a move chained by onDone may now sit at i
      } else {
        i += 1;
      }
    }
    for (const mv of this.scriptMoves) {
      const e = mv.entity;
      if (!e.moving && mv.remaining > 0) {
        if (mv.inPlace) {
          e.moving = true;
          (e as NPC).marching = true;
          e.progress = 0;
        } else {
          e.facing = mv.dir!;
          const [tx, ty] = target(e.cellX, e.cellY, mv.dir!);
          e.targetX = tx;
          e.targetY = ty;
          e.moving = true;
          e.progress = 0;
          if (e instanceof Player) {
            e.stepFramesCur = e.stepFrames;
          }
        }
        mv.remaining -= 1;
      }
    }
  }

  // ScriptWorld surface for the runner's verbs -------------------------------

  showText(text: string, onDone?: () => void): void {
    this.shell.showText(text, onDone);
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.shell.showChoice(text, choice);
  }

  setEmote(entity: unknown, kind: number, frames: number, onDone: () => void): void {
    this.emote = { entity: entity as Player | NPC, kind, frames, onDone };
  }
}
