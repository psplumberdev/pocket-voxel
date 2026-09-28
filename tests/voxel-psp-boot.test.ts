import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { runInNewContext } from "node:vm";

const path = `${import.meta.dir}/../dist/voxelmon/gamedata.json`;
describe.skipIf(!existsSync(path))("PSP guest startup transports", () => {
  test("native parsed data boots and emits the same frames as the string fallback", async () => {
    const built = await Bun.build({ entrypoints: [`${import.meta.dir}/../voxelmon/game/psp-main.ts`],
      format: "iife", target: "browser", minify: { syntax: true } });
    expect(built.success).toBe(true);
    const source = await built.outputs[0]!.text();
    const json = await Bun.file(path).text();
    function boot(parsed: boolean) {
      const calls: unknown[][] = [];
      let strings = 0, objects = 0;
      const voxel = new Proxy({
        gamedata() { strings++; return json; },
        parseGameData: parsed ? () => { objects++; return JSON.parse(json); } : undefined,
      } as Record<string, unknown>, {
        get(target, name: string) {
          if (name in target) return target[name];
          return (...args: unknown[]) => { calls.push([name, ...args]); };
        },
      });
      const context = { voxel } as { voxel: object; frame?: (buttons: number) => number };
      runInNewContext(source, context);
      expect(typeof context.frame).toBe("function");
      for (let tick = 0; tick < 10; tick++) context.frame!(0);
      return { calls, strings, objects };
    }
    const direct = boot(true), fallback = boot(false);
    expect(direct.calls).toEqual(fallback.calls);
    expect(direct.calls.filter(call => call[0] === "bootLog")).toEqual([
      ["bootLog", 1], ["bootLog", 2], ["bootLog", 3], ["bootLog", 4],
    ]);
    expect(direct.strings).toBe(0); expect(direct.objects).toBe(1);
    expect(fallback.strings).toBe(1); expect(fallback.objects).toBe(0);
  });
});
