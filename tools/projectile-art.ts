// Deterministic asset conversion: imagegen artwork -> hard-alpha 16px RGBA
// frames and the compact indexed data consumed by the cooker. No smoothing.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync } from "node:fs";
import { PROJECTILE_FAMILIES } from "../voxelmon/shared/projectiles.ts";

const root = `${import.meta.dir}/../voxelmon/art/projectiles`;
const image = await loadImage(`${root}/generated-reference.png`);
const source = createCanvas(image.width, image.height);
const ctx = source.getContext("2d"); ctx.drawImage(image, 0, 0);
const rgba = ctx.getImageData(0, 0, image.width, image.height).data;
const bands: [number, number][] = [];
let first = -1, last = 0;
for (let y = 0; y < image.height; y++) {
  let count = 0;
  for (let x = 0; x < image.width; x++) if (rgba[(y * image.width + x) * 4 + 3]! > 128) count++;
  if (count > 3) { if (first < 0) first = y; last = y; }
  else if (first >= 0 && y - last > 8) { bands.push([first, last]); first = -1; }
}
if (first >= 0) bands.push([first, last]);
if (bands.length !== PROJECTILE_FAMILIES.length) throw new Error(`Expected 15 sprite rows, found ${bands.length}`);
const colors = [
  ["171326", "595665", "999aa8", "d6dce6", "ffffff"],
  ["590e23", "b32419", "ed4c19", "ffb633", "fff5bc"],
  ["132b76", "2054c4", "198bef", "65d5ff", "edfcff"],
  ["153822", "275e2d", "4d922f", "96c842", "e0ed8a"],
  ["393326", "8b631e", "d6a929", "f9de3d", "fffbd0"],
  ["24306f", "345bcb", "65a4ed", "a2e8ff", "f7ffff"],
  ["232336", "4a4753", "7f786c", "b3a68a", "e2d5b7"],
  ["4e3524", "785534", "a78054", "d3b383", "f2dfb7"],
  ["3e1456", "74218a", "a934bc", "e97ee4", "fff0ff"],
  ["143b2b", "286046", "568568", "b7d4b7", "edf8da"],
  ["263957", "44688e", "79a8d5", "b9dff7", "ffffff"],
  ["571967", "98369f", "d464d4", "f6b2ed", "fff2fd"],
  ["171326", "321942", "582071", "883caf", "97c7ff"],
  ["661e1c", "b73319", "ed7027", "ffbc60", "fff5d2"],
  ["15275d", "184cac", "198fe3", "51dff4", "e2ffff"],
].map(row => row.map(hex => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]));
const frames: string[][] = [];
const atlas = createCanvas(128, 256), ac = atlas.getContext("2d");
mkdirSync(`${root}/frames`, { recursive: true });
for (let family = 0; family < 15; family++) {
  const [top, bottom] = bands[family]!;
  const centerY = (top + bottom) / 2, cell = image.width / 5;
  for (let frame = 0; frame < 5; frame++) {
    const canvas = createCanvas(16, 16), c = canvas.getContext("2d"), out = c.createImageData(16, 16);
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) {
      let row = "";
      for (let x = 0; x < 16; x++) {
        const sx = Math.floor(frame * cell + (x + 0.5) * cell / 16);
        const sy = Math.max(0, Math.min(image.height - 1, Math.floor(centerY + (y + 0.5 - 8) * cell / 16)));
        const at = (sy * image.width + sx) * 4;
        if (rgba[at + 3]! < 192) { row += "."; continue; }
        let best = 0, distance = Infinity;
        colors[family]!.forEach((color, i) => {
          const d = color.reduce((sum, v, channel) => sum + (v - rgba[at + channel]!) ** 2, 0);
          if (d < distance) { best = i; distance = d; }
        });
        row += best;
        out.data.set([...colors[family]![best]!, 255], (y * 16 + x) * 4);
      }
      rows.push(row);
    }
    frames.push(rows); c.putImageData(out, 0, 0);
    const tile = family * 5 + frame;
    ac.drawImage(canvas, tile % 8 * 16, Math.floor(tile / 8) * 16);
    await Bun.write(`${root}/frames/${PROJECTILE_FAMILIES[family]!.toLowerCase()}-${frame === 4 ? "impact" : frame}.png`, canvas.toBuffer("image/png"));
  }
}
await Bun.write(`${root}/indexed.json`, JSON.stringify({ colors, frames }));
await Bun.write(`${root}/atlas.png`, atlas.toBuffer("image/png"));
const preview = createCanvas(640, 1920), pc = preview.getContext("2d"); pc.imageSmoothingEnabled = false;
pc.fillStyle = "#303845"; pc.fillRect(0, 0, 640, 1920);
for (let i = 0; i < 75; i++) pc.drawImage(atlas, i % 8 * 16, Math.floor(i / 8) * 16, 16, 16, i % 5 * 128, Math.floor(i / 5) * 128, 128, 128);
await Bun.write(`${root}/preview.png`, preview.toBuffer("image/png"));
console.log("75 transparent RGBA frames; shared 128x256 indexed atlas = 32768 texel bytes + 1024-byte palette");
