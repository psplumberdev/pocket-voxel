import { expect, test } from 'bun:test';
import { rasterizeVoxelIcon } from '../tools/ios-artwork.ts';

test('iOS artwork preserves the metallic mark and uses the installation mask', async () => {
  for (const size of [57, 114]) {
    for (const userApp of [false, true]) {
      const canvas = await rasterizeVoxelIcon(size, userApp);
      const pixels = canvas.getContext('2d').getImageData(0, 0, size, size).data;
      expect(pixels[3]).toBe(userApp ? 255 : 0);
      // The original ImageMagick SVG path silently lost the gradient stroke.
      const edge = (Math.floor(size / 2) * size + Math.round(size * 2 / 32)) * 4;
      expect(pixels[edge]).toBeGreaterThan(100);
      expect(pixels[edge + 3]).toBe(255);
      if (userApp) {
        for (let index = 3; index < pixels.length; index += 4) expect(pixels[index]).toBe(255);
      }
    }
  }
});
