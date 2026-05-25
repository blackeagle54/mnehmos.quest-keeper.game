/**
 * Tests for aoe.ts — pure affected-tile math for AoE templates. [COMBAT-003]
 *
 * Mirrors the rpg.mcp spatial engine: Euclidean distance, cone via half-angle
 * dot-product test (cosTheta >= cos(halfAngle) - eps). Shapes match the backend
 * combat_map `aoe` vocabulary: circle | cone | line.
 */

import { describe, it, expect } from 'vitest';
import { getAoeTiles } from './aoe';

describe('getAoeTiles', () => {
  describe('circle', () => {
    it('returns the Euclidean disk of tiles within radius', () => {
      const tiles = getAoeTiles({ shape: 'circle', origin: { x: 10, y: 10 }, radius: 2 });
      // dx^2 + dy^2 <= 4  → 13 tiles
      expect(tiles).toHaveLength(13);
      expect(tiles).toContainEqual({ x: 10, y: 10 }); // center
      expect(tiles).toContainEqual({ x: 12, y: 10 }); // dist 2
      expect(tiles).toContainEqual({ x: 11, y: 11 }); // dist ~1.41
      expect(tiles).not.toContainEqual({ x: 12, y: 12 }); // dist ~2.83
      expect(tiles).not.toContainEqual({ x: 12, y: 11 }); // dist ~2.24
    });

    it('returns just the origin for radius 0', () => {
      expect(getAoeTiles({ shape: 'circle', origin: { x: 4, y: 7 }, radius: 0 })).toEqual([{ x: 4, y: 7 }]);
    });

    it('returns [] when radius is missing', () => {
      expect(getAoeTiles({ shape: 'circle', origin: { x: 0, y: 0 } })).toEqual([]);
    });
  });

  describe('line', () => {
    it('returns the row of tiles along an axis-aligned direction', () => {
      const tiles = getAoeTiles({ shape: 'line', origin: { x: 10, y: 10 }, direction: { x: 1, y: 0 }, length: 3 });
      expect(tiles).toContainEqual({ x: 10, y: 10 });
      expect(tiles).toContainEqual({ x: 11, y: 10 });
      expect(tiles).toContainEqual({ x: 13, y: 10 });
      expect(tiles).not.toContainEqual({ x: 14, y: 10 }); // beyond length
      expect(tiles).not.toContainEqual({ x: 9, y: 10 }); // behind origin
      expect(tiles).not.toContainEqual({ x: 11, y: 11 }); // off the 1-wide line
      expect(tiles).toHaveLength(4);
    });

    it('widens the line when width > 1', () => {
      const tiles = getAoeTiles({ shape: 'line', origin: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, length: 2, width: 3 });
      // width 3 → perpendicular offset up to 1 tile each side
      expect(tiles).toContainEqual({ x: 1, y: 1 });
      expect(tiles).toContainEqual({ x: 1, y: -1 });
    });

    it('returns [] when direction or length is missing', () => {
      expect(getAoeTiles({ shape: 'line', origin: { x: 0, y: 0 }, length: 3 })).toEqual([]);
      expect(getAoeTiles({ shape: 'line', origin: { x: 0, y: 0 }, direction: { x: 1, y: 0 } })).toEqual([]);
    });
  });

  describe('cone', () => {
    it('returns tiles within a 90-degree cone facing the direction', () => {
      const tiles = getAoeTiles({ shape: 'cone', origin: { x: 10, y: 10 }, direction: { x: 1, y: 0 }, length: 3, angle: 90 });
      expect(tiles).toContainEqual({ x: 10, y: 10 }); // origin
      expect(tiles).toContainEqual({ x: 11, y: 10 }); // straight ahead
      expect(tiles).toContainEqual({ x: 13, y: 10 }); // ahead at length
      expect(tiles).toContainEqual({ x: 11, y: 11 }); // 45° edge (boundary, within eps)
      expect(tiles).not.toContainEqual({ x: 10, y: 12 }); // 90° off-axis
      expect(tiles).not.toContainEqual({ x: 10, y: 11 }); // perpendicular
      expect(tiles).not.toContainEqual({ x: 7, y: 10 }); // behind
      expect(tiles).not.toContainEqual({ x: 14, y: 10 }); // beyond length
    });

    it('respects a narrow angle', () => {
      const narrow = getAoeTiles({ shape: 'cone', origin: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, length: 4, angle: 20 });
      // a 20° cone should not include the 45° diagonal
      expect(narrow).not.toContainEqual({ x: 1, y: 1 });
      expect(narrow).toContainEqual({ x: 4, y: 0 });
    });

    it('returns [] when direction or length is missing', () => {
      expect(getAoeTiles({ shape: 'cone', origin: { x: 0, y: 0 }, length: 3 })).toEqual([]);
    });
  });

  it('returns [] for an unknown shape', () => {
    // @ts-expect-error intentional invalid shape
    expect(getAoeTiles({ shape: 'pyramid', origin: { x: 0, y: 0 }, radius: 2 })).toEqual([]);
  });
});
