GEN 1 PROJECTILE SPRITE HANDOFF FOR CODEX

Goal:
Replace the current Pokeball placeholder used for ranged overworld attacks with small GBC-style elemental projectile sprites.

The PNG is a VISUAL REFERENCE SHEET, not a final production atlas.

Codex should:
- recreate/convert each family as transparent 16x16 RGBA sprites
- use 4 projectile frames + 1 impact frame
- pack all families into one shared PSP atlas
- use nearest-neighbor sampling
- reuse projectile textures by MOVE TYPE, not by Pokemon
- keep existing projectile speed, collision, damage, aggro, and cooldown behavior
- allow special move overrides from projectile_families_gen1.json
- keep PSP-1000 RAM usage tiny

Families:
NORMAL = white hit/pellet
FIRE = fireball
WATER = bubbles / water wave
GRASS = leaf
ELECTRIC = lightning bolt
ICE = ice shard
ROCK = rock chunk
GROUND = dust / dirt burst
POISON = purple skull/blob
BUG = web
FLYING = mini tornado
PSYCHIC = pink/purple orb
GHOST = dark purple shadow orb
FIGHTING = punch/impact wave
DRAGON = blue/cyan dragon-energy orb

Current custom rules:
- Flash = 30 damage Electric ranged attack
- Sand Attack = 30 damage Ground ranged attack
- Freeze follows Sleep rules
- Whirlwind / Roar = pushback 2 tiles
- Teleport = temporary 15-tile ranged damage move
- Normal cooldown = 3 sec
- Multi-hit cooldown = 1 sec
