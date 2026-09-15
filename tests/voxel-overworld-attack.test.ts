import { expect, test } from "bun:test";
import {
  OVERWORLD_ATTACK_COOLDOWN,
  OVERWORLD_ATTACK_MAPS,
  isOverworldAttackSpecies,
  overworldAttacksFor,
} from "../voxelmon/game/world/overworld-attack.ts";

test("overworld attack mode exposes the four requested Pokémon", () => {
  for (const species of ["BEEDRILL", "ONIX", "IVYSAUR", "PIKACHU"]) {
    expect(isOverworldAttackSpecies(species)).toBe(true);
    expect(overworldAttacksFor(species)).toHaveLength(4);
  }
  expect(isOverworldAttackSpecies("RATTATA")).toBe(false);
});

test("overworld attacks separate one-tile melee from five-tile ranged attacks", () => {
  for (const species of ["BEEDRILL", "ONIX", "IVYSAUR", "PIKACHU"]) {
    const attacks = overworldAttacksFor(species);
    expect(attacks.some(a => a.kind === "melee" && a.speed === 0)).toBe(true);
    expect(attacks.some(a => a.kind === "ranged" && a.speed === 2)).toBe(true);
  }
  expect(OVERWORLD_ATTACK_COOLDOWN).toBe(180);
  expect(OVERWORLD_ATTACK_MAPS.has("ROCK_TUNNEL_1F")).toBe(true);
  expect(OVERWORLD_ATTACK_MAPS.has("ROCK_TUNNEL_B1F")).toBe(true);
});
