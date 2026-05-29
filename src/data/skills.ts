/**
 * Single source of truth for the OSRS-style progression skills (Phase 3).
 *
 * Mirrors the engine's `src/schema/skill.ts` (SKILL_NAMES) and
 * `src/math/skill-xp.ts` (curve + caps). The five names MUST stay in lockstep
 * with the engine — they key the `skills` map returned by `skill_manage`
 * (action: get_skills). Importing this everywhere (store parser + UI) avoids
 * re-declaring the literal in multiple files (CodeRabbit: duplicated literal).
 */

// The five fixed skills, in display order. Matches engine SKILL_NAMES verbatim.
export const SKILL_NAMES = ['combat', 'magic', 'crafting', 'gathering', 'social'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

// Hard caps — mirror the engine constants (named, never inlined).
export const MAX_SKILL_LEVEL = 99;
export const MAX_SKILL_XP = 13_034_431;

