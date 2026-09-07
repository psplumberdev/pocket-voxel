import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native iOS controls handle chords, contact release, and menu capture', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocketvoxel-controls-'));
  try {
    const binary = join(directory, 'controls');
    const compile = Bun.spawnSync(['cc', '-std=c99', '-Wall', '-Wextra', '-Werror',
      new URL('fixtures/ios-controls.c', import.meta.url).pathname, '-o', binary]);
    expect(compile.stderr.toString()).toBe('');
    expect(compile.exitCode).toBe(0);
    const result = Bun.spawnSync([binary]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
