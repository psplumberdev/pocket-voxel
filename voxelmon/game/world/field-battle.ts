import { WildBattle } from "../battle/battle.ts";
import { GEN1_FAITHFUL } from "../rules/damage.ts";
import { beforeMove, RECORDS, residual } from "../rules/status.ts";
import type { MoveSlot } from "../battle/mon.ts";
import { FIELD_MOVES } from "./field-moves.ts";
import { FIELD_LOGIC_HZ } from "./overworld-attack.ts";
import type { WildBattler } from "../battle/battler.ts";

/** Field combat owns faint removal and experience, without battle menus. */
export class FieldBattle extends WildBattle {
  override readonly ruleset = { ...GEN1_FAITHFUL, focusEnergyBug: false, enemyUnlimitedPP: false };
  private statusClocks = new Map<WildBattler, { key: string; ticks: number }>();
  private seedUsers = new Map<WildBattler, WildBattler>();

  private immobilized = new Map<WildBattler, number>();
  private rage = new Map<WildBattler, { stacks: number; ticks: number }>();
  private buffs = new Map<WildBattler, Map<string, { ticks: number; amount?: number; previous?: unknown }>>();
  lastPush = false;

  constructor(...args: ConstructorParameters<typeof WildBattle>) {
    const [data, ...rest] = args;
    const moves = { ...data.moves };
    for (const id of ["BIDE", "COUNTER", "MIRROR_MOVE", "SUBSTITUTE", "RAGE"]) {
      // TODO: true Bide/Counter/Mirror Move/Substitute mechanics after the prototype.
      if (moves[id] && moves.TACKLE) moves[id] = { ...moves.TACKLE, name: moves[id]!.name, pp: moves[id]!.pp };
    }
    for (const [id, power, type] of [["TELEPORT", 40, "PSYCHIC_TYPE"], ["SAND_ATTACK", 30, "GROUND"], ["FLASH", 30, "ELECTRIC"]] as const) {
      if (moves[id]) moves[id] = { ...moves[id]!, power, type, category: undefined, effect: "NO_ADDITIONAL_EFFECT" };
    }
    if (moves.DIZZY_PUNCH) moves.DIZZY_PUNCH = { ...moves.DIZZY_PUNCH, effect: "CONFUSION_SIDE_EFFECT" };
    if (moves.SKY_ATTACK) moves.SKY_ATTACK = { ...moves.SKY_ATTACK, highCrit: true, effect: "FLINCH_SIDE_EFFECT2" };
    if (moves.RAZOR_WIND) moves.RAZOR_WIND = { ...moves.RAZOR_WIND, highCrit: true };
    // TODO: Thrash/Petal Dance repeat and lock behavior; ordinary damage for now.
    for (const id of ["THRASH", "PETAL_DANCE"]) if (moves[id]) moves[id] = { ...moves[id]!, effect: "NO_ADDITIONAL_EFFECT" };
    // Delivery/timers and these special damage rules live in this field adapter.
    // Avoid the turn engine's unsupported-effect fallbacks for these moves.
    for (const id of ["PAY_DAY", "GUILLOTINE", "HORN_DRILL", "FISSURE", "RAZOR_WIND", "SOLARBEAM", "DIG", "SKULL_BASH", "FLY",
      "BIND", "WRAP", "FIRE_SPIN", "CLAMP", "JUMP_KICK", "HI_JUMP_KICK", "HYPER_BEAM", "SELFDESTRUCT", "EXPLOSION", "SWIFT", "SUPER_FANG"]) {
      if (moves[id]) moves[id] = { ...moves[id]!, effect: "NO_ADDITIONAL_EFFECT" };
    }
    // TODO: Hyper Beam's extra recharge; current prototype uses normal cooldown.
    super({ ...data, moves }, ...rest);
  }

  override accuracyRoll(...args: Parameters<WildBattle["accuracyRoll"]>): boolean {
    if (args[0].id === "SWIFT") return true;
    return super.accuracyRoll(...args);
  }

  override computeDamage(...args: Parameters<WildBattle["computeDamage"]>): ReturnType<WildBattle["computeDamage"]> {
    const [user, target, move, opts] = args;
    if (["GUILLOTINE", "HORN_DRILL", "FISSURE"].includes(move.id)) {
      const immune = this.chart.effectiveness(move.type, target.curTypes) === 0;
      return [immune ? 0 : target.mon.hp, { crit: false, typeMult: immune ? 0 : 10 }];
    }
    if (move.id === "SUPER_FANG") return [Math.max(1, Math.floor(target.mon.hp / 2)), { crit: false, typeMult: 10 }];
    return super.computeDamage(user, target, move, { ...opts,
      explode: opts.explode || move.id === "SELFDESTRUCT" || move.id === "EXPLOSION" });
  }

  locked(b: WildBattler): boolean {
    return b.mon.status === "SLP" || b.mon.status === "FRZ" || (this.immobilized.get(b) ?? 0) > 0;
  }

  moveTicks(b: WildBattler, base: number): number {
    const stage = Math.max(-6, Math.min(6, b.stages.speed ?? 0));
    const ratio = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
    return Math.max(2, Math.round(base * (b.mon.status === "PAR" ? 4 : 1) / ratio));
  }

  private rememberBuff(b: WildBattler, key: string, previous: unknown, amount?: number): void {
    let buffs = this.buffs.get(b);
    if (!buffs) { buffs = new Map(); this.buffs.set(b, buffs); }
    const old = buffs.get(key);
    buffs.set(key, { ticks: 600, previous: old ? old.previous : previous,
      amount: amount === undefined ? undefined : (old?.amount ?? 0) + amount });
  }

  applyChargeBuff(b: WildBattler, id: string): void {
    if (id !== "SKULL_BASH") return;
    const old = b.stages.defense ?? 0;
    b.stages.defense = Math.min(6, old + 1);
    this.rememberBuff(b, "stage:defense", undefined, b.stages.defense - old);
  }

  retainActors(actors: readonly WildBattler[]): void {
    const active = new Set(actors);
    for (const map of [this.statusClocks, this.immobilized, this.rage, this.buffs]) {
      for (const actor of map.keys()) if (!active.has(actor)) map.delete(actor);
    }
    for (const [target, source] of this.seedUsers) if (!active.has(target) || !active.has(source)) this.seedUsers.delete(target);
  }

  private tickTimers(b: WildBattler): void {
    const lock = this.immobilized.get(b);
    if (lock !== undefined) { if (lock <= 1) this.immobilized.delete(b); else this.immobilized.set(b, lock - 1); }
    const rage = this.rage.get(b);
    if (rage && --rage.ticks <= 0) this.rage.delete(b);
    const buffs = this.buffs.get(b);
    if (!buffs) return;
    for (const [key, timer] of buffs) {
      if (--timer.ticks > 0) continue;
      if (key.startsWith("stage:")) {
        const stat = key.slice(6) as keyof WildBattler["stages"];
        b.stages[stat] = Math.max(-6, Math.min(6, (b.stages[stat] ?? 0) - (timer.amount ?? 0)));
      } else (b as unknown as Record<string, unknown>)[key] = timer.previous;
      buffs.delete(key);
    }
    if (!buffs.size) this.buffs.delete(b);
  }

  // Field damage is driven by time, never by attack/button frequency.
  override residualFor(_b: WildBattler, _opp: WildBattler): void {}

  override resolveFieldAction(user: WildBattler, target: WildBattler, action: MoveSlot & { struggle?: boolean }): string[] {
    this.lastPush = false;
    if (this.locked(user)) return [`${user.name} cannot act!`];
    const rule = FIELD_MOVES[action.id];
    const move = this.data.moves[action.id];
    if (!move) return [];
    if (rule?.push || ["CONVERSION", "MIMIC", "DISABLE"].includes(action.id)) {
      const confused = user.confusedTurns, disabled = user.disabledTurns;
      if (confused !== undefined) user.confusedTurns = 99;
      if (disabled !== undefined) user.disabledTurns = 99;
      const check = beforeMove(user, this.rng);
      user.confusedTurns = confused; user.disabledTurns = disabled;
      if (check.selfHit) {
        const [damage] = this.computeDamage(user, user, { id: "CONFUSED", power: 40, type: "NORMAL", accuracy: 100 },
          { rng: this.rng, forceCrit: false, typeless: true, screens: target });
        user.mon.hp = Math.max(0, user.mon.hp - damage);
        if (user.mon.hp <= 0) this.onFaint(user);
      }
      if (!check.canMove) return check.messages;
      user.lastMove = action.id;
    }
    if (rule?.push) {
      action.pp = Math.max(0, action.pp - 1);
      this.lastPush = this.accuracyRoll(move, user, target);
      return [this.lastPush ? `${target.name} was pushed back!` : `${move.name} missed!`];
    }
    if (action.id === "CONVERSION") {
      action.pp = Math.max(0, action.pp - 1);
      this.rememberBuff(user, "curTypes", [...user.curTypes]);
      user.curTypes = [this.data.moves[user.curMoves[0]?.id ?? ""]?.type ?? "NORMAL"];
      return [`${user.name} changed type!`];
    }
    if (action.id === "MIMIC" || action.id === "DISABLE") {
      action.pp = Math.max(0, action.pp - 1);
      if (!this.accuracyRoll(move, user, target)) return [`${move.name} missed!`];
      const recent = target.lastMove;
      if (!recent || !this.data.moves[recent]) return ["But, it failed!"];
      if (action.id === "DISABLE") {
        const slot = target.curMoves.findIndex(m => m.id === recent);
        if (slot < 0) return ["But, it failed!"];
        target.disabledSlot = slot + 1; target.disabledTurns = 2;
        return [`${recent} was disabled!`];
      }
      user.curMoves = user.curMoves.map(m => m.id === "MIMIC" ? { id: recent, pp: m.pp } : m);
      return [`${user.name} copied ${recent}!`];
    }
    const stages = { ...user.stages };
    const previous = { reflect: user.reflect, lightScreen: user.lightScreen, mist: user.mist, focusEnergy: user.focusEnergy };
    const seeded = target.leechSeeded;
    const targetHp = target.mon.hp;
    const targetStatus = target.mon.status;
    const confused = user.confusedTurns, disabled = user.disabledTurns;
    const rage = this.rage.get(user);
    if (action.id === "RAGE") this.data.moves.RAGE = { ...move, power: move.power + 5 * (rage?.stacks ?? 0) };
    // Reapplying an active screen refreshes it rather than failing.
    const flag = ({ REFLECT: "reflect", LIGHT_SCREEN: "lightScreen", MIST: "mist", FOCUS_ENERGY: "focusEnergy" } as const)[action.id as "REFLECT"];
    if (flag) user[flag] = undefined;
    if (confused !== undefined) user.confusedTurns = 99;
    if (disabled !== undefined) user.disabledTurns = 99;
    let messages: string[];
    try { messages = super.resolveFieldAction(user, target, action); }
    finally { this.data.moves[action.id] = move; }
    // These countdowns run on time, not on button presses.
    if (confused !== undefined && user.confusedTurns !== undefined) user.confusedTurns = confused;
    if (disabled !== undefined && user.disabledTurns !== undefined) user.disabledTurns = disabled;
    if ((action.id === "JUMP_KICK" || action.id === "HI_JUMP_KICK") && messages.some(m => m.includes("missed"))) {
      user.mon.hp = Math.max(0, user.mon.hp - 1);
      messages.push(`${user.name} crashed!`);
      if (user.mon.hp <= 0) this.onFaint(user);
    }
    if (!seeded && target.leechSeeded) this.seedUsers.set(target, user);
    if (target.flinched) { this.immobilized.set(target, Math.max(120, this.immobilized.get(target) ?? 0)); target.flinched = false; }
    if (rule?.trap && target.mon.hp < targetHp) this.immobilized.set(target, rule.trap);
    if (target.mon.status === "FRZ" && targetStatus !== "FRZ") target.sleepTurns = 1 + this.rng.int(7);
    if (action.id === "RAGE" && target.mon.hp < targetHp) this.rage.set(user, { stacks: Math.min(5, (rage?.stacks ?? 0) + 1), ticks: 600 });
    if (flag && !user[flag]) user[flag] = previous[flag];
    const used = messages.some(message => message.includes(" used "));
    if (rule?.delivery === "self" && used) {
      const buffStat: Record<string, keyof WildBattler["stages"]> = {
        SWORDS_DANCE: "attack", MEDITATE: "attack", SHARPEN: "attack", GROWTH: "special", AMNESIA: "special",
        HARDEN: "defense", WITHDRAW: "defense", DEFENSE_CURL: "defense", BARRIER: "defense", ACID_ARMOR: "defense",
        AGILITY: "speed", DOUBLE_TEAM: "evasion", MINIMIZE: "evasion",
      };
      for (const stat of Object.keys(user.stages) as (keyof WildBattler["stages"])[]) {
        const change = (user.stages[stat] ?? 0) - (stages[stat] ?? 0);
        if (change > 0) this.rememberBuff(user, `stage:${stat}`, undefined, change);
        else if (buffStat[action.id] === stat && this.buffs.get(user)?.has(`stage:${stat}`)) this.buffs.get(user)!.get(`stage:${stat}`)!.ticks = 600;
      }
      for (const key of ["reflect", "lightScreen", "mist", "focusEnergy"] as const) if (key === flag && user[key]) this.rememberBuff(user, key, previous[key]);
    }
    if (action.id === "HAZE") { this.buffs.delete(user); this.buffs.delete(target); this.rage.delete(user); this.rage.delete(target); }
    return messages;
  }

  tickStatus(b: WildBattler): string[] {
    this.tickTimers(b);
    const key = `${b.mon.status ?? ""}:${!!b.leechSeeded}:${!!b.confusedTurns}:${!!b.disabledTurns}`;
    if (b.mon.hp <= 0 || (!b.mon.status && !b.leechSeeded && !b.confusedTurns && !b.disabledTurns)) {
      this.statusClocks.delete(b);
      if (!b.leechSeeded) this.seedUsers.delete(b);
      return [];
    }
    let clock = this.statusClocks.get(b);
    if (!clock || clock.key !== key) {
      clock = { key, ticks: 0 };
      this.statusClocks.set(b, clock);
    }
    if (++clock.ticks < 5 * FIELD_LOGIC_HZ) return [];
    clock.ticks = 0;
    const messages: string[] = [];
    if (b.mon.status === "SLP" || b.mon.status === "FRZ") {
      const frozen = b.mon.status === "FRZ";
      messages.push(...RECORDS.SLP!.beforeMove!(b, this.rng)[1].map(m => frozen ? m.replace("woke up", "thawed out").replace("fast asleep", "frozen") : m));
    }
    if (b.confusedTurns && --b.confusedTurns <= 0) b.confusedTurns = undefined;
    if (b.disabledTurns && --b.disabledTurns <= 0) { b.disabledTurns = undefined; b.disabledSlot = undefined; }
    // A seed heals the Pokémon that planted it, not the last enemy targeted.
    const source = this.seedUsers.get(b);
    const noSource = { ...b, mon: { ...b.mon, hp: 0 } };
    messages.push(...residual(b, source ?? noSource));
    b.shownHP = b.mon.hp;
    if (b.mon.hp <= 0) this.onFaint(b);
    return messages;
  }

  /** Healthy opponent placeholder for self moves between encounters. */
  readonly idleTarget = this.enemy;
  override onFaint(battler: WildBattler): void {
    battler.fainted = true;
  }
}
