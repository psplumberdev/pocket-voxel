# Elemental overworld projectile art

User handoff: `README_CODEX.txt` and `projectile_families_gen1.json`.
The original sheet was a visual reference, not a production atlas.
`generated-reference.png` is the imagegen recreation. `tools/projectile-art.ts`
converts its 15 rows using nearest-neighbor samples, hard alpha and five
palette colors per family. Run it with Bun from the project root.

`frames/` contains 75 transparent 16x16 RGBA PNGs: four flight frames plus
one impact per family. `atlas.png` is the 128x256 RGBA production atlas;
`preview.png` enlarges the frames for inspection. `indexed.json` is the
build-time input for `voxelmon/cook/projectiles.ts`. The PSP receives one
32 KiB indexed texture and one 1 KiB palette, not the source PNGs. All
families share that texture; no per-Pokémon copies are created.

`voxelmon/shared/projectiles.ts` reads the special overrides from the supplied
JSON and maps the handoff's THUNDER_SHOCK alias to imported THUNDERSHOCK.
The existing nearest-neighbor renderer addresses these 16px cells using the
TILED entity flag. The first four cells loop every eight logic ticks; a
collision displays the fifth cell for twelve ticks. At most eight impact
records are retained, and mode/map changes clear them. Impacts only affect
presentation: speed, range, collision, PP, damage, aggro and cooldowns retain
their existing behavior.

A full cook includes this atlas automatically. For an already-cooked pack:

```
bun tools/projectile-pak.ts INPUT.vxpak OUTPUT.vxpak
cargo run --quiet -p pocketvoxel-core --example validate-pak -- OUTPUT.vxpak
```

The patcher copies geometry/audio unchanged, preserves existing page IDs,
updates metadata and adds the atlas/palette bindings. It supports updating
its existing appended projectile page without growing another copy. Use a
separate output, validate it, then package it with a freshly built EBOOT.

The requested delivery destination for this version is **J:\test**
(`/mnt/voxelrw/test`), separate from **J:\VOXELMON**. Both launch files are
needed; an older asset pack will retain the Poké Ball fallback. The startup
memory optimization and `voxel-boot.log` diagnostics remain included.
