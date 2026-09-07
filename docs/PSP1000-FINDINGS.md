# Pocket Voxel on PSP-1000: source and engineering findings

Publication checkpoint: September 6, 2026.

Pocket Voxel runs TypeScript gameplay in QuickJS and renders a retained voxel
scene through Rust and the PSP Graphics Engine. This checkpoint changes how
that runtime uses memory: the cooked world stays on the Memory Stick, visible
assets stream into reusable caches, and JavaScript compilation moves to the
build machine. It also includes the accumulated gameplay and cooker fixes.

This report describes mechanisms present in the source. It does not establish
a new measured frame rate, a complete playthrough, or hardware certification.
The README's existing PSP-2000 pictures belong to an earlier revision.

## What changed and why

| Problem | Implementation | Tradeoff |
| --- | --- | --- |
| Loading the complete pak competes with the game heap | A positional file reader validates a small index and streams mesh ranges and atlas frames | Storage reads can hold a frame |
| Parsing bundled JavaScript consumes startup memory | A host compiler serializes bytecode using the same pinned QuickJS revision as the PSP | Bytecode must be rebuilt with the matching engine |
| Startup data overlaps with steady-state allocations | Load GAME first, let the guest parse it, release the native transport buffer, collect garbage, then load resident data | Initialization order and borrowed lifetimes matter |
| Dense foliage expands the live geometry set | PSP chunk distance is 256 world pixels, grass/flower distance is 192, and detail density selects every eighth quad | Distant pop-in and less foliage are deliberate compromises |
| Allocation growth can invalidate data still used by the GE | Wait for GE completion before mutating geometry or atlas caches | Cache misses introduce a synchronization cost |
| Heap pressure is difficult to diagnose | PocketJS reports requested live/peak bytes, allocation count, largest request, and last failed request | Requested bytes are not total arena consumption |
| Reused allocator slabs can hide garbage from bump-only heuristics | Collect on scene transitions and pressure, with maintenance collection every 600 logic ticks | Collection can hold a frame; audio is prefilled ahead of it |
| Oversized terrain atlases repeat on the GE | Pack sheets into columns within a 512×512 page; split shared sheets by tileset variant | Different layout requires recooking assets |

Geometry has a 1 MiB cache-retention threshold; atlas data has a 512 KiB
threshold. **These are eviction thresholds, not hard memory ceilings.** A
frame's required assets must still fit, and retained vector capacity and
allocator overhead can exceed payload bytes. The transition prefetch uses the
first visible view; later movement loads additional assets on demand.

## Where the code lives

- `crates/pocketvoxel-core/src/pak/index.rs`: file-backed container indexing and validation.
- `crates/pocketvoxel-core/src/pak.rs`: resident and streaming-resident readers.
- `crates/pocketvoxel-core/src/draw.rs`: the draw list and its asset working set.
- `crates/pocketvoxel-psp/src/pak_file.rs`: positional reads, geometry cache, atlas cache.
- `crates/pocketvoxel-gu/src/lib.rs`: rendering through supplied geometry and atlas sources.
- `crates/pocketvoxel-psp/src/main.rs`: startup ordering, bytecode loading, GE synchronization, garbage collection, and telemetry.
- `tools/qjbc/`: the host bytecode compiler, with a pinned QuickJS dependency.
- `vendor/pocketjs/hosts/psp/src/qjs_alloc.rs`: allocator accounting required by the PSP host.
- `contracts/spec/voxel-spec.ts`: the authoritative quality settings and camera rigs.

The PocketJS allocator change is a separate dependency commit. A reproducible
checkout needs that commit available remotely, followed by a recursive
submodule update. The publication branch pins it explicitly.

## Gameplay and presentation in this checkpoint

The source includes trainer parties and payouts, expanded early-game story
handlers and encounters, inventory/economy handling, save-state serialization,
and a PSP file bridge for saves. PSP saves use a bounded 128 KiB JSON payload
with temporary and backup files in `ms0:/PSP/GAME/VOXELMON/`. Gameplay schema
validation remains in the guest. These mechanisms do not by themselves prove
that every story path or storage-failure case is complete.

Cooker changes include terrain atlas layout and palette variants, entity
support heights, and geometry adjustments. Camera rigs also changed. Existing
render hashes need comparison against this revision; historical identity and
PSP/Vita guest-byte equality claims must not be carried forward unchanged.
The PSP now embeds bytecode while the Vita path retains JavaScript.

## Reproduce from source

Install Bun, Rust, LuaJIT, and the project's pinned PSP toolchain. Follow the
[getting-started guide](guide/getting-started.md) for reference checkouts and
provide your own supported ROM. Generated content stays in ignored `dist/`.

```sh
git submodule update --init --recursive
bun install
export VOXELMON_ROM=/path/to/your/rom.gb
export VOXELMON_G1R=/path/to/gen1recomp
export VOXELMON_VOXELMOD=/path/to/DramaticShapeVoxelMod
bun tools/voxel.ts import
bun tools/voxel.ts cook
bun test tests/
cargo test -p pocketvoxel-core
bun run tsc
bun tools/voxel.ts psp --release
```

The PSP command bundles gameplay, runs the pinned host bytecode compiler, and
builds the EBOOT. Install the EBOOT and locally cooked `voxelmon.vxpak` together.
For measurements, build with the PSP `telemetry` feature and record device
model, launch method, initial free memory, cache high-water values, QuickJS
requested bytes, arena headroom, frame timing, and audio underruns. Repeat
through map transitions and dense Forest scenes; a successful boot alone is
insufficient evidence of sustained playability.

## Validation at publication preparation

- Documentation site: `bun run docs:build` passed (bundle-size warning only).
- Rust core: **55 passed**, no failures (`cargo test -p pocketvoxel-core`).
- Focused gameplay, world, rules, contract, and seam tests: **220 passed,
  3 skipped, no failures** across five test files.
- Initial full Bun run: 300 passed, 8 skipped, 11 failed. LuaJIT was absent
  from PATH, and generated web/template and trace checks also failed.
- Full rerun with the installed LuaJIT and Rust paths: the first cook/reader
  validation passed, but the process was killed before the suite completed.
  This is an incomplete run, not a pass.
- Type checking identified two source errors, which were corrected during
  preparation. Missing generated WASM modules still prevent a clean check.
- `git diff --check` passes. Publication files were checked for common private
  key/token patterns and oversized artifacts, with no matches.
- No fresh physical PSP run, full story acceptance, GE parity capture, or
  console/web rebuild was completed for this publication checkpoint.

These limits are why the source is presented as a development checkpoint.

## Credits and content boundary

Pocket Voxel builds on [PocketJS](https://github.com/pocket-stack/pocketjs),
the [gen1recomp](https://github.com/bryanthaboi/gen1recomp) gameplay reference,
and [DramaticShape's Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod).
See the repository's MIT license and existing attribution records.
This publication contains source and documentation; ROM files, extracted
content, cooked paks, local saves, and generated game bundles are excluded.
