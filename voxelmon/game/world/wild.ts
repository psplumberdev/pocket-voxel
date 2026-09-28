import { newMon, type PartyMon } from "../battle/mon.ts";
import { makeBattler, type WildBattler } from "../battle/battler.ts";
import { STEP_FRAMES } from "./player.ts";
// A bounded population of visible encounters with persistent field-combat
// Pokémon and a small walking state. Contact battles retain their normal flow.
import { ENTS_MAX } from "../../../contracts/spec/voxel-spec.ts";
import type { EncounterDef, EncounterGroup, EncounterSlot, VoxelmonData } from "../data.ts";
import { ENCOUNTER_BUCKETS, effectiveRate } from "../rules/encounter.ts";
import { seededRng, type Rng } from "../rng.ts";
import { canMove, DELTA, occupied, type Dir, type Mover, type TilePairs } from "./collision.ts";
import type { GameMap } from "./map.ts";

// Match the renderer's capacity: map NPCs must not consume an obsolete
// 16-slot budget and silently disable encounters on crowded routes/caves.
// Population size stays bounded separately; callers reserve effect slots.
export const WILD_ACTOR_SLOTS = ENTS_MAX;
export const WILD_LIMIT = 4;
export const WILD_RADIUS = 5;
export const WILD_DESPAWN_RADIUS = 8;
const STEP_TICKS = STEP_FRAMES;
export function rollsAggressive(rng: Rng): boolean { return rng.int(5) === 0; }
const SPAWN_TICKS = 30;
const DIRS: readonly Dir[] = ["up", "down", "left", "right"];
type Habitat = "grass" | "water";

const PEWTER_TEST_ENCOUNTERS: EncounterGroup = {
  rate: 255,
  buckets: [64, 128, 192, 256],
  slots: [
    { species: "BEEDRILL", level: 11 },
    { species: "ONIX", level: 10 },
    { species: "IVYSAUR", level: 14 },
    { species: "PIKACHU", level: 10 },
  ],
};

function tableFor(data: VoxelmonData, mapId: string, habitat: Habitat): EncounterGroup | undefined {
  return data.encounters[mapId]?.[habitat] ??
    (habitat === "grass" && mapId === "PEWTER_CITY"
      ? PEWTER_TEST_ENCOUNTERS
      : undefined);
}

export class WildSprite implements Mover {
  trainerOwned = false;
  active = false;
  species = "";
  level = 1;
  icon = "MON";
  habitat: Habitat = "grass";
  cellX = 0;
  cellY = 0;
  px = 0;
  py = 0;
  targetX?: number;
  targetY?: number;
  facing: Dir = "down";
  surfing = false;
  moving = false;
  progress = 0;
  timer = 0;
  animation = 0;
  /** Runtime health used by overworld attacks; normal contact battles ignore it. */
  mon?: PartyMon;
  battler?: WildBattler;
  moveStepTicks = STEP_TICKS;
  hp = 1;
  maxHp = 1;
  aggressive = false;
  provoked = false;
  rewarded = false;
  aggro = false;
  attackCooldown = 0;
  bossPattern?: readonly string[];
  bossPatternIndex = 0;
  bossPatternTimer = 0;
  get frame(): number { return Math.floor(this.animation / 16) % 2; }
}

/** Same ROM slot weights as step encounters, without rerolling the species
 * on contact. The rate gate belongs to the population's spawn clock. */
export function pickWild(table: NonNullable<EncounterDef["grass"]>, rng: Rng): EncounterSlot | null {
  const pick = rng.byte();
  const buckets = table.buckets ?? ENCOUNTER_BUCKETS;
  for (let i = 0; i < buckets.length; i++) {
    if (pick < buckets[i]) {
      const slot = table.slots[i];
      return slot ? { species: slot.species, level: slot.level } : null;
    }
  }
  return null;
}

export class WildPopulation {
  readonly slots = Array.from({ length: WILD_LIMIT }, () => new WildSprite());
  trainerBattle = false;
  private clock = 0;
  private firstSpawn = true;
  private pending?: { wild: WildSprite; map: GameMap; slot: EncounterSlot; x: number; y: number; habitat: Habitat; icon: string };
  get loading(): boolean { return this.pending !== undefined; }
  // Separate from battle, encounter and NPC RNG: walking cannot reroll a
  // damage/accuracy roll or change the existing townspeople's wandering.
  constructor(readonly rng: Rng = seededRng(0x57494c44)) {}

  clear(): void {
    this.pending = undefined;
    this.trainerBattle = false;
    for (const wild of this.slots) { wild.active = false; wild.moving = false; wild.aggro = false; }
    this.clock = 0;
    this.firstSpawn = true;
  }

  atCell(x: number, y: number): WildSprite | undefined {
    return this.slots.find(w => w.active && (
      (w.cellX === x && w.cellY === y) || (w.targetX === x && w.targetY === y)
    ));
  }

  consume(wild: WildSprite): EncounterSlot {
    wild.active = false;
    wild.moving = false;
    wild.targetX = wild.targetY = undefined;
    this.firstSpawn = false;
    this.clock = 180; // enough room to leave after running from a battle
    return { species: wild.species, level: wild.level };
  }

  habitatAt(data: VoxelmonData, map: GameMap, x: number, y: number): Habitat | null {
    if (!map.inBounds(x, y) || map.warpAtCell(x, y)) return null;
    // Gyms are curated trainer arenas; ordinary wandering encounters must
    // never populate them around the leader fights.
    if (map.id.endsWith("_GYM")) return null;
    // Keep stairs/doorways clear even when cave encounters cover all floor.
    for (const dir of DIRS) {
      const [dx, dy] = DELTA[dir];
      if (map.warpAtCell(x + dx, y + dy)) return null;
    }
    const grass = tableFor(data, map.id, "grass");
    const water = tableFor(data, map.id, "water");
    if (map.isWaterCell(x, y)) return water?.rate ? "water" : null;
    if (!map.isWalkableCell(x, y) || !grass?.rate) return null;
    if (map.isGrassCell(x, y)) return "grass";
    const indoor = data.field?.indoorEncounters as { firstIndoorMap: number; excludedTileset: string } | undefined;
    return indoor && map.def.index >= indoor.firstIndoorMap && map.def.tileset !== indoor.excludedTileset
      ? "grass" : null;
  }

  update(data: VoxelmonData, map: GameMap, player: Mover, entities: readonly Mover[], pairs?: TilePairs, reservedSlots = 0, readyToAttack?: (wild: WildSprite) => boolean, locked?: (wild: WildSprite) => boolean, stepTicks?: (wild: WildSprite) => number): void {
    if (!data.partyIcons) return;
    const limit = Math.max(0, Math.min(WILD_LIMIT, Math.min(WILD_ACTOR_SLOTS, ENTS_MAX) - entities.length - reservedSlots));
    // A separate tick lets the host present LOADING POKEMON before stats,
    // moves and battler state are constructed. No half-built enemy is active.
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      const onWater = map.isWaterCell(player.cellX, player.cellY);
      if ((p.habitat === "water" && !(onWater && (player.surfing || player.waterWalking || player.flying))) ||
          (p.habitat === "grass" && onWater)) return;
      if (p.map !== map || this.slots.indexOf(p.wild) >= limit || occupied(entities, p.x, p.y) ||
          Math.max(Math.abs(p.x - player.cellX), Math.abs(p.y - player.cellY)) > WILD_DESPAWN_RADIUS) return;
      const free = p.wild;
      free.trainerOwned = false;
      free.species = p.slot.species; free.level = p.slot.level; free.icon = p.icon;
      free.mon = newMon(data, p.slot.species, p.slot.level, this.rng);
      free.battler = makeBattler(data, free.mon, false);
      free.maxHp = free.hp = free.mon.hp;
      free.aggressive = rollsAggressive(this.rng);
      free.provoked = free.rewarded = free.aggro = false;
      free.attackCooldown = 0;
      free.habitat = p.habitat; free.surfing = p.habitat === "water";
      free.cellX = p.x; free.cellY = p.y; free.px = p.x * 16; free.py = p.y * 16;
      free.targetX = free.targetY = undefined;
      free.moving = false; free.progress = 0; free.timer = 30 + this.rng.int(91);
      free.animation = 0; free.facing = "down"; free.active = true;
      this.firstSpawn = false;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const wild = this.slots[i];
      if (!wild.active) continue;
      // A map swap can land between the population update and the renderer.
      // Never retain or draw a stale encounter outside the new map's cell
      // rectangle.
      if (!map.inBounds(wild.cellX, wild.cellY) ||
          (wild.targetX !== undefined && !map.inBounds(wild.targetX, wild.targetY!))) {
        wild.active = false;
        wild.moving = false;
        wild.targetX = wild.targetY = undefined;
        continue;
      }
      if (!wild.trainerOwned && i >= limit) {
        wild.active = false;
        continue;
      }
      if (!wild.trainerOwned && Math.max(Math.abs(wild.cellX - player.cellX), Math.abs(wild.cellY - player.cellY)) > WILD_DESPAWN_RADIUS) {
        wild.active = false;
        continue;
      }
      if (wild.mon?.status === "SLP" || wild.mon?.status === "FRZ" || locked?.(wild)) continue;
      wild.animation = (wild.animation + 1) % 32;
      if (wild.attackCooldown > 0) wild.attackCooldown--;
      if (wild.moving) {
        wild.progress += 1;
        const [dx, dy] = DELTA[wild.facing];
        const pixels = Math.floor(wild.progress * 16 / wild.moveStepTicks);
        wild.px = wild.cellX * 16 + dx * pixels;
        wild.py = wild.cellY * 16 + dy * pixels;
        if (wild.progress >= wild.moveStepTicks) {
          wild.cellX = wild.targetX!;
          wild.cellY = wild.targetY!;
          wild.targetX = wild.targetY = undefined;
          wild.moving = false;
        }
        continue;
      }
      if (!wild.aggro && --wild.timer > 0) continue;
      wild.timer = wild.aggro ? 0 : 30 + this.rng.int(91);
      const dxToPlayer = player.cellX - wild.cellX;
      const dyToPlayer = player.cellY - wild.cellY;
      const dir = wild.aggro
        ? (Math.abs(dxToPlayer) >= Math.abs(dyToPlayer)
          ? (dxToPlayer < 0 ? "left" : "right")
          : (dyToPlayer < 0 ? "up" : "down"))
        : DIRS[this.rng.int(DIRS.length)];
      const [dx, dy] = DELTA[dir];
      const x = wild.cellX + dx, y = wild.cellY + dy;
      wild.facing = dir;
      // Field combat must get a stationary attack opportunity before pursuit
      // starts another step. Facing is already aimed at the opponent.
      if (readyToAttack?.(wild)) continue;
      // Keep idle populations near the view instead of letting all four
      // wander far away while still occupying the active slots.
      if (Math.max(Math.abs(x - player.cellX), Math.abs(y - player.cellY)) > WILD_RADIUS) continue;
      if ((!wild.trainerOwned && this.habitatAt(data, map, x, y) !== wild.habitat) || this.atCell(x, y)) continue;
      if (!canMove(map, entities, wild, dir, pairs).ok) continue;
      wild.targetX = x; wild.targetY = y;
      wild.moveStepTicks = stepTicks?.(wild) ?? (player as Mover & { stepFrames?: number }).stepFrames ?? STEP_FRAMES;
      wild.progress = 0; wild.moving = true;
    }
    if (this.trainerBattle) return;
    if (--this.clock > 0) return;
    this.clock = SPAWN_TICKS;
    const free = this.slots.find((w, i) => i < limit && !w.active);
    if (!free) return;
    // Fixed effort, independent of map size. Sparse grass never means a
    // whole-map search or an unbounded spawn retry on PSP.
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = player.cellX + this.rng.int(WILD_RADIUS * 2 + 1) - WILD_RADIUS;
      const y = player.cellY + this.rng.int(WILD_RADIUS * 2 + 1) - WILD_RADIUS;
      if (Math.max(Math.abs(x - player.cellX), Math.abs(y - player.cellY)) < 3) continue;
      const habitat = this.habitatAt(data, map, x, y);
      if (!habitat || (habitat === "water" && !(map.isWaterCell(player.cellX, player.cellY) &&
          (player.surfing || player.waterWalking || player.flying)))) continue;
      if (map.isWaterCell(player.cellX, player.cellY) && habitat !== "water") continue;
      if (occupied(entities, x, y) || this.atCell(x, y)) continue;
      const table = tableFor(data, map.id, habitat);
      if (!table || (!this.firstSpawn && this.rng.byte() >= effectiveRate(table.rate))) return;
      const slot = pickWild(table, this.rng);
      const icon = slot && data.pokemon[slot.species]?.partyIcon;
      if (!slot || !icon || data.partyIcons[icon] === undefined) return;
      this.pending = { wild: free, map, slot, x, y, habitat, icon };
      return;
    }
  }
}
