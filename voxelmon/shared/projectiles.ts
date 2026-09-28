import handoff from "../art/projectiles/projectile_families_gen1.json";
/** One shared 16px tile atlas; five cells per elemental family. */
export const PROJECTILE_FAMILIES = ["NORMAL", "FIRE", "WATER", "GRASS", "ELECTRIC", "ICE", "ROCK", "GROUND", "POISON", "BUG", "FLYING", "PSYCHIC", "GHOST", "FIGHTING", "DRAGON"] as const;
export type ProjectileFamily = typeof PROJECTILE_FAMILIES[number];
export const PROJECTILE_FRAMES = 4;
export const PROJECTILE_IMPACT_FRAME = 4;
export const PROJECTILE_FRAME_TICKS = 8;
export const PROJECTILE_IMPACT_TICKS = 12;
export const PROJECTILE_IMPACT_LIMIT = 8;
// Handoff filenames resolve to these shared families. THUNDERSHOCK is the
// imported ROM spelling of the handoff's THUNDER_SHOCK alias.
export const PROJECTILE_OVERRIDES: Record<string, ProjectileFamily> = {};
for (const [move, file] of Object.entries(handoff.special_overrides)) {
  const family = PROJECTILE_FAMILIES.find(type => handoff.families[type].sprite === file);
  if (!family) throw new Error(`Unknown projectile override ${move}: ${file}`);
  PROJECTILE_OVERRIDES[move] = family;
}
PROJECTILE_OVERRIDES.THUNDERSHOCK = PROJECTILE_OVERRIDES.THUNDER_SHOCK!;
export function projectileFamily(move: string, type?: string): ProjectileFamily {
  return PROJECTILE_OVERRIDES[move] ?? (PROJECTILE_FAMILIES.includes(type as ProjectileFamily) ? type as ProjectileFamily : "NORMAL");
}
export function projectileFrame(move: string, type: string | undefined, ticks: number, impact = false): number {
  return PROJECTILE_FAMILIES.indexOf(projectileFamily(move, type)) * 5 +
    (impact ? PROJECTILE_IMPACT_FRAME : Math.floor(ticks / PROJECTILE_FRAME_TICKS) % PROJECTILE_FRAMES);
}
