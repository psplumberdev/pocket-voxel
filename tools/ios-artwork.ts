import { readFileSync } from 'node:fs';
import { rasterizeIconSvg } from '../vendor/pocketjs/tools/icon-raster.ts';

export async function rasterizeVoxelIcon(size: number, userApp = false) {
  let svg = readFileSync(new URL('../web/favicon.svg', import.meta.url), 'utf8')
    .replace('<svg ', '<svg width="32" height="32" ');
  if (userApp) {
    svg = svg.replace('</defs>', '</defs><rect width="32" height="32" fill="#0a0a0c" />');
  }
  return rasterizeIconSvg(svg, size, size, userApp);
}
