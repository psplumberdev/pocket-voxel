import type { VoxelmonData } from "../data.ts";
import type { PartyMon } from "../battle/mon.ts";
import { expForLevel } from "./growth.ts";
import { calc } from "./stats.ts";

export function useRareCandy(data: VoxelmonData, mon: PartyMon): boolean {
  const cap = Math.min(100, data.constants?.levelCap ?? 100);
  if (mon.level >= cap) return false;
  const def = data.pokemon[mon.species];
  if (!def) return false;
  const oldHp = mon.stats.hp;
  mon.level++;
  mon.exp = expForLevel(def.growthRate, mon.level, data.growth_rates);
  // Keep battler stat aliases valid while preserving status and stat experience.
  Object.assign(mon.stats, calc(def, mon.level, mon.dvs, mon.statExp));
  mon.hp = Math.min(mon.stats.hp, mon.hp + mon.stats.hp - oldHp);
  return true;
}
