# Lavender–Saffron check, September 26, 2026

The pre-audit PSP build was copied to the Windows Voxel shared folder first,
with both launch-file hashes verified and saves untouched (148 maps).

## Included and checked

- Pokémon Tower 1F–7F, Rocket Hideout B1F–B4F/elevator, Saffron,
  Silph Co. 1F–11F/elevator, Fighting Dojo, Celadon Gym and Saffron Gym.
- Added missing Copycat house floors, Mr. Psychic's house and Silph elevator.
- Removed the duplicate Mr. Fuji house entry from the cook list.
- Tower Gary battle selects the starter-dependent Tower roster. Talking to
  another NPC no longer accidentally dispatches Gary's encounter.
- Added Silph Gary's starter-dependent roster and step/talk triggers. Only
  victory retires Gary and unlocks the Lapras interaction.
- Added level-15 Lapras and mutually exclusive level-30 Hitmonlee/Hitmonchan
  gifts. Declining or a full party leaves the gift available. The Dojo master
  must be defeated first; only the chosen ball disappears.
- Verified Erika and Sabrina battle callbacks award their badge and TM once.
- Silph Giovanni victory sets the liberation flag, removes occupation Rockets
  and unlocks the President's one-time Master Ball reward.
- Fuji now requires all three Tower Rockets defeated; a full bag cannot lose
  the Flute reward.
- The Silph elevator's ROM placeholder exit resolves back to the entrance
  floor, including a saved floor marker and a first-floor fallback.

## Remaining chapter mechanics

The follow-up implementation now covers the Game Corner poster switch,
Hideout spinner paths, Lift Key drop and lift floor selection, Silph Card Key
doors and floor selection, the Tower purified healing zone and Marowak ghost
gate (including Scope disguise and Poké Doll escape), and shared drink access
through all four Saffron gates. Door stamp meshes are included in the cooked
pack so the visual door state follows collision state.

The checks still do not replace a complete physical PSP playthrough.

Validation: the chapter tests exercise imported map/warp references, Gary's
Tower and Silph rosters, win-only progression, Lapras full-party/decline/repeat
handling, both Dojo alternatives, gym rewards, Silph liberation, and elevator
return. Broader world, field-trainer and package tests are also run.
Repository TypeScript checking is blocked by two absent generated web WASM
modules (web/generated/pocketvoxel_packager_wasm.js and pocketvoxel_wasm.js).

Follow-up validation: 17 chapter tests and the broader world, field-trainer,
package, and battle suites passed (173 passed in the combined run, one terrain
profile test skipped). The release PSP package validates at 156 maps and 1,569
atlas pages. The copied C-drive files match the local release hashes:
`f980ef43ec65a5eb01b66392c50c5b35204491e02565a9cb521dd27a31eb3ebc`
for `voxelmon.vxpak` and
`cabb10dcca4ba413de429c85a817a8370aadcd82f05d4246710657c7f0941217` for
`EBOOT.PBP`.

Final validation: 126 tests passed, one terrain-profile test skipped, no failures
in the world, field-trainer and package suites. The full terrain cook completed
with 156 maps after adding per-map garbage collection to the CLI. Release PSP
build and file-backed package validation passed: 275,487,104-byte asset pack,
1,569 atlas pages. These checks do not validate a full chapter playthrough.
