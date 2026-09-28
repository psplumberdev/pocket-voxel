import { VOX_BTN } from "../../contracts/spec/voxel-spec.ts";

// Return bits consumed by the PSP host after the guest turn, before drawing.
export const PSP_RELOAD_START = 1;
export const PSP_RELOAD_MAP = 2;
export const PSP_LOADING_SPAWN = 4;

interface FrameGame {
  overworld: { map: object; wild?: { loading: boolean } };
  tick(buttons: number): void;
}

/** Every setMap installs a new GameMap, including same-map warps/Fly.
 * Observe the object rather than its ID or the renderer's deduplicated
 * mapShow calls. Start remains a normal gameplay input as well. */
export function createPspFrame(game: FrameGame): (buttons: number) => number {
  let previousButtons = 0;
  return (buttons: number): number => {
    const startPressed = (buttons & VOX_BTN.start) !== 0 &&
      (previousButtons & VOX_BTN.start) === 0;
    previousButtons = buttons;
    const previousMap = game.overworld.map;
    const wasSpawning = game.overworld.wild?.loading ?? false;
    game.tick(buttons);
    return (startPressed ? PSP_RELOAD_START : 0) |
      (previousMap !== game.overworld.map ? PSP_RELOAD_MAP : 0) |
      (!wasSpawning && game.overworld.wild?.loading ? PSP_LOADING_SPAWN : 0);
  };
}
