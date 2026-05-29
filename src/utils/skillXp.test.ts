/**
 * Golden-value tests for the client-side OSRS skill XP curve.
 *
 * These freeze the exact published values so the frontend bar math stays in
 * lockstep with the engine (src/math/skill-xp.ts). If these drift, the UI bars
 * disagree with the server's xpProgress — caught here, not in production.
 */
import { describe, it, expect } from 'vitest';
import { xpForLevel, levelFromXp, xpProgress } from './skillXp';
import { MAX_SKILL_LEVEL, MAX_SKILL_XP } from '../data/skills';

describe('skillXp curve (client mirror of engine)', () => {
  it('matches the published golden XP-for-level values', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(83);
    expect(xpForLevel(3)).toBe(174);
    expect(xpForLevel(10)).toBe(1154);
    expect(xpForLevel(50)).toBe(101333);
    expect(xpForLevel(92)).toBe(6517253);
    expect(xpForLevel(99)).toBe(13034431);
  });

  it('round-trips levelFromXp(xpForLevel(L)) === L for all levels', () => {
    for (let L = 1; L <= MAX_SKILL_LEVEL; L++) {
      expect(levelFromXp(xpForLevel(L))).toBe(L);
    }
  });

  it('drops a level one XP below each threshold', () => {
    for (let L = 2; L <= MAX_SKILL_LEVEL; L++) {
      expect(levelFromXp(xpForLevel(L) - 1)).toBe(L - 1);
    }
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(levelFromXp(-5)).toBe(1);
    expect(levelFromXp(99999999)).toBe(MAX_SKILL_LEVEL);
    expect(levelFromXp(NaN)).toBe(1);
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(200)).toBe(xpForLevel(MAX_SKILL_LEVEL));
  });

  it('reports progress for a fresh skill', () => {
    const p = xpProgress(0);
    expect(p.level).toBe(1);
    expect(p.xpIntoLevel).toBe(0);
    expect(p.atMax).toBe(false);
    expect(p.xpForNextLevel).toBe(83);
  });

  it('reports atMax at the cap with no XP to next', () => {
    const p = xpProgress(MAX_SKILL_XP);
    expect(p.level).toBe(MAX_SKILL_LEVEL);
    expect(p.atMax).toBe(true);
    expect(p.xpToNext).toBe(0);
    expect(p.xpForNextLevel).toBeNull();
  });
});

