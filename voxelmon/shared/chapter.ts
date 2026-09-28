/** ROM field tables shared by the streamed cooker and chapter controller. */
export interface ChapterDoor { bx: number; by: number; block: number; open: number; event?: string; events?: string[] }
export interface ChapterField {
  cardKeyDoors?: { closedDoors?: Record<string, ChapterDoor[]> };
  gameCornerPoster?: { map: string; x: number; y: number; closedBlock: number; openBlock: number; event: string; posterText: string };
  spinners?: Record<string, { x: number; y: number; moves: { dir: "up" | "down" | "left" | "right"; count: number }[] }[]>;
}
export function chapterDoors(field: ChapterField, map: string): ChapterDoor[] {
  const doors = field.cardKeyDoors?.closedDoors?.[map] ?? [];
  const poster = field.gameCornerPoster;
  return poster?.map === map ? [...doors, { bx: poster.x, by: poster.y, block: poster.closedBlock, open: poster.openBlock, event: poster.event }] : doors;
}
export function doorOpen(door: ChapterDoor, flags: Record<string, boolean>): boolean {
  return (door.events ?? (door.event ? [door.event] : [])).every(event => !!flags[event]);
}
export const SAFFRON_GATES: Record<string, { cells: [number, number][]; horizontal?: boolean }> = {
  ROUTE_5_GATE: { cells: [[3, 3], [4, 3]] },
  ROUTE_6_GATE: { cells: [[3, 2], [4, 2]] },
  ROUTE_7_GATE: { cells: [[3, 3], [3, 4]], horizontal: true },
  ROUTE_8_GATE: { cells: [[2, 3], [2, 4]], horizontal: true },
};
export const DRINKS = ["FRESH_WATER", "SODA_POP", "LEMONADE"];
