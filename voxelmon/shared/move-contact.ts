/** Gen I move IDs cross-checked against Bulbapedia's current contact list.
 * Source: https://bulbapedia.bulbagarden.net/wiki/Contact (2026-09-15).
 * Contact was introduced after Gen I; it is used ONLY for field reach here,
 * without changing the ROM's damage categories, power, accuracy, or PP. */
export const CONTACT_MOVES = new Set([
  "POUND", "KARATE_CHOP", "DOUBLESLAP", "COMET_PUNCH", "MEGA_PUNCH",
  "FIRE_PUNCH", "ICE_PUNCH", "THUNDERPUNCH", "SCRATCH", "VICEGRIP",
  "GUILLOTINE", "CUT", "WING_ATTACK", "FLY", "BIND", "SLAM", "VINE_WHIP",
  "STOMP", "DOUBLE_KICK", "MEGA_KICK", "JUMP_KICK", "ROLLING_KICK",
  "HEADBUTT", "HORN_ATTACK", "FURY_ATTACK", "HORN_DRILL", "TACKLE",
  "BODY_SLAM", "WRAP", "TAKE_DOWN", "THRASH", "DOUBLE_EDGE", "BITE",
  "PECK", "DRILL_PECK", "SUBMISSION", "LOW_KICK", "COUNTER", "SEISMIC_TOSS",
  "STRENGTH", "PETAL_DANCE", "DIG", "QUICK_ATTACK", "RAGE", "BIDE", "LICK",
  "WATERFALL", "CLAMP", "SKULL_BASH", "CONSTRICT", "HI_JUMP_KICK",
  "LEECH_LIFE", "DIZZY_PUNCH", "CRABHAMMER", "FURY_SWIPES", "HYPER_FANG",
  "SUPER_FANG", "SLASH", "STRUGGLE",
]);
