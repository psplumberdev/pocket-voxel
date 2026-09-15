/** Data and rules for the optional real-time overworld Pokémon control mode. */

export const OVERWORLD_ATTACK_SPECIES = ["BEEDRILL", "ONIX", "IVYSAUR", "PIKACHU"] as const;
export const OVERWORLD_ATTACK_MAPS = new Set(["ROCK_TUNNEL_1F", "ROCK_TUNNEL_B1F"]);
export const OVERWORLD_ATTACK_COOLDOWN = 180; // 3 seconds at 60 Hz

export type OverworldAttackKind = "melee" | "ranged";

export interface OverworldAttack {
  name: string;
  kind: OverworldAttackKind;
  power: number;
  /** Ranged attacks travel at bicycle speed (one cell per tick). */
  speed: number;
}

export const OVERWORLD_ATTACKS: Record<string, readonly OverworldAttack[]> = {
  BEEDRILL: [
    { name: "FURY ATTACK", kind: "melee", power: 15, speed: 0 },
    { name: "TWINEEDLE", kind: "ranged", power: 25, speed: 2 },
    { name: "POISON STING", kind: "ranged", power: 15, speed: 2 },
    { name: "PIN MISSILE", kind: "ranged", power: 20, speed: 2 },
  ],
  ONIX: [
    { name: "TACKLE", kind: "melee", power: 20, speed: 0 },
    { name: "ROCK THROW", kind: "ranged", power: 25, speed: 2 },
    { name: "BIND", kind: "melee", power: 15, speed: 0 },
    { name: "ROCK SLIDE", kind: "ranged", power: 30, speed: 2 },
  ],
  IVYSAUR: [
    { name: "TACKLE", kind: "melee", power: 20, speed: 0 },
    { name: "VINE WHIP", kind: "melee", power: 25, speed: 0 },
    { name: "RAZOR LEAF", kind: "ranged", power: 30, speed: 2 },
    { name: "LEECH SEED", kind: "ranged", power: 10, speed: 2 },
  ],
  PIKACHU: [
    { name: "QUICK ATTACK", kind: "melee", power: 20, speed: 0 },
    { name: "THUNDER SHOCK", kind: "ranged", power: 25, speed: 2 },
    { name: "THUNDER WAVE", kind: "ranged", power: 10, speed: 2 },
    { name: "SLAM", kind: "melee", power: 30, speed: 0 },
  ],
};

export function overworldAttacksFor(species: string): readonly OverworldAttack[] {
  return OVERWORLD_ATTACKS[species] ?? [];
}

export function isOverworldAttackSpecies(species: string): boolean {
  return OVERWORLD_ATTACKS[species] !== undefined;
}
