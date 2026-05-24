/**
 * AoE templates — pure affected-tile math for area-of-effect visualization. [COMBAT-003]
 *
 * Faithfully mirrors the rpg.mcp spatial engine (src/engine/spatial/engine.ts):
 *   - Euclidean distance metric
 *   - circle: bounding box, dist <= radius
 *   - cone:   dist <= length AND cosTheta >= cos(halfAngle) - EPS (dot-product test)
 *   - line:   projection along direction in [0, length], perpendicular dist <= width/2
 *
 * Keeping this in lockstep with the engine means the on-screen preview matches what
 * the engine will actually hit — the viz stays advisory, the engine stays the arbiter.
 *
 * Coordinates and radius/length/width are in GRID TILES (callers convert feet ÷ 5).
 */

export type AoeShape = 'circle' | 'cone' | 'line';

export interface Point {
  x: number;
  y: number;
}

export interface AoeSpec {
  shape: AoeShape;
  origin: Point;
  /** circle: radius in grid tiles */
  radius?: number;
  /** cone/line: direction VECTOR (not a target point), e.g. {x:1,y:0} faces +x */
  direction?: Point;
  /** cone/line: length/reach in grid tiles */
  length?: number;
  /** cone: total angle in degrees (default 53.13 — D&D RAW, width == length) */
  angle?: number;
  /** line: total width in tiles (default 1) */
  width?: number;
}

const EPS = 0.0001;

function euclid(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function normalize(direction: Point): Point | null {
  const len = Math.sqrt(direction.x * direction.x + direction.y * direction.y);
  if (len === 0) return null;
  return { x: direction.x / len, y: direction.y / len };
}

function circleTiles(origin: Point, radius: number): Point[] {
  const tiles: Point[] = [];
  const r = Math.ceil(radius);
  for (let x = origin.x - r; x <= origin.x + r; x++) {
    for (let y = origin.y - r; y <= origin.y + r; y++) {
      if (euclid(x, y, origin.x, origin.y) <= radius) tiles.push({ x, y });
    }
  }
  return tiles;
}

function coneTiles(origin: Point, direction: Point, length: number, angleDeg: number): Point[] {
  const dir = normalize(direction);
  if (!dir) return [];
  const cosHalf = Math.cos((angleDeg / 2) * (Math.PI / 180));
  const reach = Math.ceil(length);
  const tiles: Point[] = [];
  for (let x = origin.x - reach; x <= origin.x + reach; x++) {
    for (let y = origin.y - reach; y <= origin.y + reach; y++) {
      const dist = euclid(x, y, origin.x, origin.y);
      if (dist > length) continue;
      if (dist === 0) {
        tiles.push({ x, y }); // origin tile is always in the cone
        continue;
      }
      const cosTheta = ((x - origin.x) * dir.x + (y - origin.y) * dir.y) / dist;
      if (cosTheta >= cosHalf - EPS) tiles.push({ x, y });
    }
  }
  return tiles;
}

function lineTiles(origin: Point, direction: Point, length: number, width: number): Point[] {
  const dir = normalize(direction);
  if (!dir) return [];
  const halfWidth = width / 2;
  const reach = Math.ceil(length) + Math.ceil(halfWidth);
  const tiles: Point[] = [];
  for (let x = origin.x - reach; x <= origin.x + reach; x++) {
    for (let y = origin.y - reach; y <= origin.y + reach; y++) {
      const vx = x - origin.x;
      const vy = y - origin.y;
      const along = vx * dir.x + vy * dir.y; // projection onto direction
      if (along < 0 || along > length) continue;
      const perp = Math.abs(vx * dir.y - vy * dir.x); // |cross| = perpendicular distance
      if (perp <= halfWidth + EPS) tiles.push({ x, y });
    }
  }
  return tiles;
}

/**
 * Compute the affected grid tiles for an AoE template. Returns `[]` for unknown
 * shapes or missing required parameters (defensive — preview stays empty rather
 * than throwing).
 */
export function getAoeTiles(spec: AoeSpec): Point[] {
  if (!spec || !spec.origin) return [];

  switch (spec.shape) {
    case 'circle':
      return typeof spec.radius === 'number' ? circleTiles(spec.origin, spec.radius) : [];
    case 'cone':
      return spec.direction && typeof spec.length === 'number'
        ? coneTiles(spec.origin, spec.direction, spec.length, spec.angle ?? 53.13)
        : [];
    case 'line':
      return spec.direction && typeof spec.length === 'number'
        ? lineTiles(spec.origin, spec.direction, spec.length, spec.width ?? 1)
        : [];
    default:
      return [];
  }
}
