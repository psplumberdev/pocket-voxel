import { FIELD_MOVES } from "./field-moves.ts";
import { CONTACT_MOVES } from "../../shared/move-contact.ts";

/** National Pokédex #001–050; retain the existing Onix field pilot too. */
export const OVERWORLD_ATTACK_SPECIES = [
  "BULBASAUR", "IVYSAUR", "VENUSAUR", "CHARMANDER", "CHARMELEON",
  "CHARIZARD", "SQUIRTLE", "WARTORTLE", "BLASTOISE", "CATERPIE",
  "METAPOD", "BUTTERFREE", "WEEDLE", "KAKUNA", "BEEDRILL",
  "PIDGEY", "PIDGEOTTO", "PIDGEOT", "RATTATA", "RATICATE",
  "SPEAROW", "FEAROW", "EKANS", "ARBOK", "PIKACHU",
  "RAICHU", "SANDSHREW", "SANDSLASH", "NIDORAN_F", "NIDORINA",
  "NIDOQUEEN", "NIDORAN_M", "NIDORINO", "NIDOKING", "CLEFAIRY",
  "CLEFABLE", "VULPIX", "NINETALES", "JIGGLYPUFF", "WIGGLYTUFF",
  "ZUBAT", "GOLBAT", "ODDISH", "GLOOM", "VILEPLUME",
  "PARAS", "PARASECT", "VENONAT", "VENOMOTH", "DIGLETT",
  "ONIX",
] as const;
const PILOT_SPECIES = new Set<string>(OVERWORLD_ATTACK_SPECIES);
/** The host can advance 60 logic ticks/sec (two ticks per 30 Hz display).
 * Budget for that fastest cadence, not measured slowdown on a busy PSP. */
export const FIELD_LOGIC_HZ = 60;
export const FIELD_WALK_TICKS = 24;
export const OVERWORLD_ATTACK_COOLDOWN = 3 * FIELD_LOGIC_HZ;
export const OVERWORLD_PROJECTILE_SPEED = 2;
export const MELEE_FLASH_TICKS = FIELD_LOGIC_HZ / 4;

const SELF_MOVES = new Set([
  "SWORDS_DANCE", "MIST", "GROWTH", "MEDITATE", "AGILITY", "DOUBLE_TEAM",
  "RECOVER", "HARDEN", "MINIMIZE", "WITHDRAW", "DEFENSE_CURL", "BARRIER",
  "LIGHT_SCREEN", "HAZE", "REFLECT", "FOCUS_ENERGY", "SOFTBOILED", "AMNESIA",
  "SPLASH", "ACID_ARMOR", "REST", "SHARPEN", "CONVERSION", "SUBSTITUTE", "TELEPORT",
]);
export type OverworldAttackKind = "melee" | "ranged";
export interface OverworldAttack {
  id: string;
  name: string;
  kind: OverworldAttackKind;
  target: "self" | "opponent";
  power: number;
  range: number;
  area?: "self" | "forward";
  /** Ratio of the base walking speed. */
  speed: number;
}

/** Use every learned slot, in order, with its original battle definition. */
export function overworldAttacksFor(
  _species: string,
  learned: readonly { id: string }[] = [],
  moves?: Record<string, { name?: string; power?: number; contact?: boolean }>,
): readonly OverworldAttack[] {
  return learned.map(slot => {
    const def = moves?.[slot.id];
    const rule = FIELD_MOVES[slot.id];
    const contact = rule ? rule.delivery === "melee" : def?.contact ?? CONTACT_MOVES.has(slot.id);
    return {
      id: slot.id,
      name: def?.name ?? slot.id.replaceAll("_", " "),
      kind: contact ? "melee" : "ranged",
      target: (rule ? rule.target === "self" : SELF_MOVES.has(slot.id)) ? "self" : "opponent",
      power: def?.power ?? 0,
      range: rule?.range ?? (rule?.area === "self" ? 3 : rule?.area === "forward" ? 4 : contact ? 1 : 5),
      area: rule?.area,
      speed: contact ? 0 : OVERWORLD_PROJECTILE_SPEED,
    };
  });
}

export function isOverworldAttackSpecies(species: string): boolean {
  return PILOT_SPECIES.has(species);
}
