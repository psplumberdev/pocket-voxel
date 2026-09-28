# Overworld battle move sheet v4

The companion text file is the user's design sheet. `field-moves.ts` maps all
165 imported Gen I move IDs to that sheet. `FieldBattle` owns action-mode
rules; ordinary `WildBattle` move definitions are unchanged.

Resolved details:

- Teleport is a 40-power Psychic-type enemy projectile with 15-tile range.
  This overrides the older SELF/teleport table row, as requested.
- Normal cooldown is 180 logic ticks; listed multi-hit moves use 60 ticks.
- Player/enemy base walking stays 24 ticks/tile. Projectiles use 12 ticks/tile,
  the bicycle pace relative to that base walk speed.
- Charge moves have a 60-tick wind-up. Skull Bash raises defense during it.
- Melee covers the five front/side neighboring tiles, excluding the rear three.
- Blizzard/Earthquake cover a four-tile straight forward strip. Haze and
  explosions cover a radius-three circle. Surf, Fissure, Rock Slide and
  Bonemerang retain the simple projectile delivery permitted by the sheet.
- Flinch immobilizes for 120 ticks; trapping hits immobilize for 600 ticks.
- Self buffs last 600 ticks; reapplication refreshes the affected buff.
  Stages remain within -6..+6. Conversion uses the first move's type.
- Poison, burn, seed drain and sleep/freeze checks retain the five-second
  cadence. Paralysis slows movement and retains battle attack checks;
  confusion and Disable countdowns now advance on the five-second timer.
- Rage gains +5 move power per successful target hit, at most five stacks;
  each hit refreshes its ten-second duration.
- Roar/Whirlwind push up to two tiles, respecting collision and occupants.
- Quick Attack lunges one walkable tile before its melee strike.
- Multi-target attacks spend PP once, with normal per-target accuracy/damage.
  Enemy moves use the same delivery implementation and learned move slots.

Intentional prototype behavior requested by the sheet: Bide, Counter, Mirror
Move and Substitute use Tackle (without Substitute HP cost). Thrash and Petal
Dance use ordinary attacks. Their true special mechanics, Hyper Beam's extra
recharge, broad Surf/Rock Slide effects and Bonemerang's return flight remain
TODOs. Transform copies battle stats/types/moves; a transformed field sprite
is a future presentation improvement.

Asset packaging still uses the validated `voxelmon.vxpak` next to `EBOOT.PBP`.
Map assets do not need recooking for this gameplay-bytecode update.

## Existing-zone completion (2026-09-21)

Field spawning now budgets against the renderer's 64 entity slots instead
of the obsolete 16-slot limit. The population remains capped at four wild
Pokémon and still reserves follower/effect slots. Previously, NPCs and
effect reservations suppressed encounters entirely in Mt. Moon 1F and
crowded routes such as Routes 9, 11 and 25.

Real-map regression tests cover natural spawning, original encounter
species/levels and learned moves on all 26 cooked maps with land encounter
tables, including the three Mt. Moon floors. Existing tests cover trainer
rosters, rewards, badges, collision, attacks, stairs and map connections.
The existing selectable pilot roster (#001–050 plus Onix) is unchanged.

Build gameplay using `bun tools/voxel.ts psp --release --reuse-pak` when
assets have not changed. This explicitly validates the existing asset pack
before rebuilding; the default command still cooks assets and runs tapes.
The completed local package is `output/overworld/PSP/GAME/VOXELMON/`, with
both `EBOOT.PBP` and `voxelmon.vxpak`.

The user's emulator runs from `J:\VOXELMON` on the Windows host, exposed
through the VirtualBox share `Voxel` at `/mnt/voxelrw/VOXELMON`. A local
Linux output folder alone is not delivery to that emulator. On 2026-09-21,
the share was reconnected and both launch files were installed there with
SHA-256 verification; existing saves were preserved. Emulator execution
has not been verified from this session.

Follow-up: normal walking contact now enters a classic battle with the
visible wild's species and level. Attack mode retains solid opponents and
real-time attacks; leaving that mode restores classic contact encounters.
Tests cover both modes, switching between them and blocked terrain.
