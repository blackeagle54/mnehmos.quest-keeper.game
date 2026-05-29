/**
 * Client-side mirror of the engine OSRS skill XP curve
 * (engine: src/math/skill-xp.ts).
 *
 * Why duplicate it on the client: `skill_manage` (get_skills) returns each skill
 * as `{ xp, level }` only — it does NOT embed per-skill xpProgress. To draw a
 * "into this level" progress bar the UI needs the curve. Re-deriving it here
 * (instead of asking the server per skill) keeps the Skills tab a single round
 * trip. The golden-value tests in skillXp.test.ts lock these outputs to the same
 * published values the engine asserts, so the two can never silently drift.
 *
 * The sum-then-floor ORDER below (accumulate floor() per inner level, then
 * floor(points / 4)) is load-bearing: it is the only order that reproduces the
 * exact published values under JS floating point. Do not "simplify" it.
 */
import { MAX_SKILL_LEVEL, MAX_SKILL_XP } from '../data/skills';

function buildXpTable(): readonly number[] {
  // Index 0 is unused; index L holds the cumulative XP to reach level L.
  const table: number[] = new Array(MAX_SKILL_LEVEL + 1).fill(0);
  let points = 0;
  for (let lvl = 1; lvl < MAX_SKILL_LEVEL; lvl++) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    table[lvl + 1] = Math.floor(points / 4);
  }
  // Frozen so no consumer can mutate the locked floating-point result.
  return Object.freeze(table);
}

const SKILL_XP_TABLE = buildXpTable();

/** Clamp a level into the valid 1..MAX_SKILL_LEVEL range (non-finite -> 1). */
function clampLevel(level: number): number {
  const safe = Number.isFinite(level) ? level : 1;
  if (safe < 1) return 1;
  if (safe > MAX_SKILL_LEVEL) return MAX_SKILL_LEVEL;
  return Math.floor(safe);
}

/** Cumulative XP required to reach `level`. Pure; clamps out-of-range input. */
export function xpForLevel(level: number): number {
  return SKILL_XP_TABLE[clampLevel(level)];
}

/** Derive the level from total XP. Scans top-down; clamps XP to 0..MAX. */
export function levelFromXp(totalXp: number): number {
  const finiteXp = Number.isFinite(totalXp) ? totalXp : 0;
  const xp = finiteXp < 0 ? 0 : finiteXp > MAX_SKILL_XP ? MAX_SKILL_XP : finiteXp;
  for (let lvl = MAX_SKILL_LEVEL; lvl >= 1; lvl--) {
    if (xp >= SKILL_XP_TABLE[lvl]) return lvl;
  }
  return 1;
}

export interface SkillProgress {
  level: number;
  totalXp: number;
  xpIntoLevel: number;
  xpForNextLevel: number | null;
  xpToNext: number;
  atMax: boolean;
}

/** Progress data for UI bars: how far into the current level the XP sits. */
export function xpProgress(totalXp: number): SkillProgress {
  const finiteXp = Number.isFinite(totalXp) ? totalXp : 0;
  const xp = finiteXp < 0 ? 0 : finiteXp > MAX_SKILL_XP ? MAX_SKILL_XP : finiteXp;
  const level = levelFromXp(xp);
  const atMax = level >= MAX_SKILL_LEVEL;
  const xpForNextLevel = atMax ? null : xpForLevel(level + 1);
  return {
    level,
    totalXp: xp,
    xpIntoLevel: xp - xpForLevel(level),
    xpForNextLevel,
    xpToNext: atMax ? 0 : (xpForNextLevel as number) - xp,
    atMax,
  };
}
