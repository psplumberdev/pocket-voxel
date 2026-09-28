// Add/update the tiny shared projectile asset without rebuilding map geometry.
// Untouched sections are copied in bounded chunks; all offsets stay relative
// to their sections. Always write a separate file, then validate before use.
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { VXPK_MAGIC, VXPK_VERSION, VXPK_TAG } from "../contracts/spec/voxel-spec.ts";
import { buildProjectileAtlas } from "../voxelmon/cook/projectiles.ts";
import { swizzle } from "../voxelmon/cook/atlas.ts";

const align = (n: number) => Math.ceil(n / 16) * 16;
export function patchProjectilePak(source: string, destination: string): void {
  if (source === destination) throw new Error("Use a separate output pack");
  const fd = openSync(source, "r");
  let output: number | undefined;
  function read(offset: number, len: number): Buffer {
    const bytes = Buffer.alloc(len);
    let at = 0;
    while (at < len) {
      const n = readSync(fd, bytes, at, len - at, offset + at);
      if (!n) throw new Error("Truncated pack");
      at += n;
    }
    return bytes;
  }
  try {
    const header = read(0, 160);
    if (header.readUInt32LE(0) !== VXPK_MAGIC || header.readUInt16LE(4) !== VXPK_VERSION || header.readUInt16LE(6) !== 9) throw new Error("Unsupported pack");
    const sections = Array.from({ length: 9 }, (_, i) => {
      const at = 16 + i * 16;
      return { tag: header.readUInt32LE(at), offset: header.readUInt32LE(at + 4), len: header.readUInt32LE(at + 8), count: header.readUInt32LE(at + 12) };
    });
    const section = (tag: number) => {
      const s = sections.find(s => s.tag === tag);
      if (!s) throw new Error(`Missing section ${tag}`);
      return s;
    };
    const bytes = (tag: number) => { const s = section(tag); return read(s.offset, s.len); };
    const game = JSON.parse(bytes(VXPK_TAG.game).toString());
    const atls = bytes(VXPK_TAG.atlas), vpal = bytes(VXPK_TAG.palette), vcol = bytes(VXPK_TAG.color);
    const oldPages = atls.readUInt16LE(0), oldPals = vpal.readUInt16LE(0);
    const existing = game.projectilePage !== undefined;
    const page = existing ? game.projectilePage as number : oldPages;
    if (existing && page !== oldPages - 1) throw new Error("Projectile page must be last");
    const maps = vcol.readUInt16LE(2), palette = existing ? vcol.readUInt16LE(16 + maps * 8 + page * 2) : oldPals;
    if (existing && palette !== oldPals - 1) throw new Error("Projectile palette must be last");
    const asset = buildProjectileAtlas();
    const texels = Buffer.from(swizzle(asset.page.w, asset.page.h, asset.page.frames[0]!));
    let nextAtlas: Buffer;
    const record = 2 + page * 16;
    if (existing) {
      nextAtlas = Buffer.from(atls);
      if (nextAtlas.readUInt32LE(record + 12) !== texels.length || nextAtlas.readUInt16LE(record + 6) !== 1) throw new Error("Unexpected projectile atlas layout");
      texels.copy(nextAtlas, nextAtlas.readUInt32LE(record + 8));
    } else {
      const oldStart = align(2 + oldPages * 16), nextStart = align(2 + (oldPages + 1) * 16);
      const shift = nextStart - oldStart, tileStart = align(atls.length + shift);
      nextAtlas = Buffer.alloc(tileStart + texels.length);
      atls.copy(nextAtlas, 0, 0, 2 + oldPages * 16);
      nextAtlas.writeUInt16LE(oldPages + 1, 0);
      for (let i = 0; i < oldPages; i++) {
        const pos = 2 + i * 16 + 8;
        nextAtlas.writeUInt32LE(atls.readUInt32LE(pos) + shift, pos);
      }
      atls.copy(nextAtlas, nextStart, oldStart);
      nextAtlas.writeUInt16LE(asset.page.w, record); nextAtlas.writeUInt16LE(asset.page.h, record + 2);
      nextAtlas.writeUInt16LE(asset.page.kind, record + 4); nextAtlas.writeUInt16LE(1, record + 6);
      nextAtlas.writeUInt32LE(tileStart, record + 8); nextAtlas.writeUInt32LE(texels.length, record + 12);
      texels.copy(nextAtlas, tileStart);
    }
    const nextPal = Buffer.alloc(vpal.length + (existing ? 0 : 1024)); vpal.copy(nextPal);
    nextPal.writeUInt16LE(oldPals + (existing ? 0 : 1), 0);
    asset.palette.forEach((color, i) => nextPal.writeUInt32LE(color, 2 + palette * 1024 + i * 4));
    const nextColor = Buffer.alloc(vcol.length + (existing ? 0 : 2)); vcol.copy(nextColor);
    nextColor.writeUInt16LE(oldPages + (existing ? 0 : 1), 4);
    nextColor.writeUInt16LE(palette, 16 + maps * 8 + page * 2);
    game.projectilePage = page;
    const meta = bytes(VXPK_TAG.meta);
    meta.writeUInt32LE(oldPages + (existing ? 0 : 1), 4);
    meta.writeUInt32LE(oldPals + (existing ? 0 : 1), 8);
    const replacements = new Map<number, Buffer>([
      [VXPK_TAG.meta, meta],
      [VXPK_TAG.atlas, nextAtlas], [VXPK_TAG.palette, nextPal],
      [VXPK_TAG.color, nextColor], [VXPK_TAG.game, Buffer.from(JSON.stringify(game))],
    ]);
    let end = 160;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!, replacement = replacements.get(s.tag);
      header.writeUInt32LE(end, 20 + i * 16);
      header.writeUInt32LE(replacement?.length ?? s.len, 24 + i * 16);
      if (!existing && (s.tag === VXPK_TAG.atlas || s.tag === VXPK_TAG.palette)) header.writeUInt32LE(s.count + 1, 28 + i * 16);
      end += align(replacement?.length ?? s.len);
    }
    header.writeUInt32LE(end, 8);
    output = openSync(destination, "wx");
    const write = (data: Buffer) => {
      let at = 0;
      while (at < data.length) { const n = writeSync(output!, data, at, data.length - at); if (n <= 0) throw new Error("Short pack write"); at += n; }
    };
    write(header);
    for (const s of sections) {
      const replacement = replacements.get(s.tag);
      if (replacement) write(replacement);
      else for (let offset = 0; offset < s.len; offset += 1024 * 1024) write(read(s.offset + offset, Math.min(1024 * 1024, s.len - offset)));
      const len = replacement?.length ?? s.len;
      write(Buffer.alloc(align(len) - len));
    }
  } finally { closeSync(fd); if (output !== undefined) closeSync(output); }
}
if (import.meta.main) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error("Usage: bun tools/projectile-pak.ts INPUT.vxpak OUTPUT.vxpak");
  patchProjectilePak(source, destination);
  console.log(`Wrote ${destination}; validate with the PSP streaming reader before installation.`);
}
