import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { extractEmbeddedJson } from '../utils/mcpUtils';
import { SKILL_NAMES, type SkillName } from '../data/skills';

// ============================================
// Types
// ============================================

/** A single skill's persisted state as returned by the engine (xp + level). */
export interface SkillEntry {
  xp: number;
  level: number;
}

/** The five-skill map keyed by skill name. */
export type SkillMap = Record<SkillName, SkillEntry>;

/**
 * Parsed result of the last skill_manage call. The engine embeds the full
 * action payload (actionType + action-specific fields) in a SKILL_MANAGE_JSON
 * comment block; we keep it around so the UI can react to e.g. leveledUp.
 */
export interface SkillManageResult {
  success?: boolean;
  actionType?: 'get_skills' | 'grant_xp' | 'set_level' | 'check_requirement';
  characterId?: string;
  characterName?: string;
  skill?: SkillName;
  skills?: SkillMap;
  // grant_xp
  amount?: number;
  oldXp?: number;
  newXp?: number;
  oldLevel?: number;
  newLevel?: number;
  leveledUp?: boolean;
  // set_level
  level?: number;
  xp?: number;
  // check_requirement
  currentLevel?: number;
  requiredLevel?: number;
  met?: boolean;
  shortfall?: number;
  // error envelope
  error?: boolean;
  message?: string;
}

interface SkillState {
  // Server-derived skill maps, keyed by characterId. NEVER persisted.
  skillsByCharacter: Record<string, SkillMap>;
  // The most recent parsed skill_manage payload (for level-up reactions, etc.).
  lastResult: SkillManageResult | null;

  // UI preference (persisted): which skill the user last focused.
  selectedSkill: SkillName | null;

  isLoading: boolean;
  error: string | null;

  // Setters
  setSelectedSkill: (skill: SkillName | null) => void;
  setError: (error: string | null) => void;

  // Lifecycle
  initialize: () => Promise<void>;

  // Actions (all route through the single skill_manage tool)
  syncSkills: (characterId: string) => Promise<void>;
  grantXp: (characterId: string, skill: SkillName, amount: number) => Promise<void>;
  setLevel: (characterId: string, skill: SkillName, level: number) => Promise<void>;
  checkRequirement: (
    characterId: string,
    skill: SkillName,
    level: number
  ) => Promise<SkillManageResult | null>;

  // Selectors
  getSkills: (characterId: string | null | undefined) => SkillMap | null;
}

// ============================================
// Helpers
// ============================================

/**
 * Build a fresh all-level-1 skill map. Used as a back-compat default so the UI
 * has something to render even if the engine omits the skills block. Keyed off
 * SKILL_NAMES so the five keys never drift from the engine.
 */
function defaultSkillMap(): SkillMap {
  const map = {} as SkillMap;
  for (const name of SKILL_NAMES) {
    map[name] = { xp: 0, level: 1 };
  }
  return map;
}

/**
 * Parse a skill_manage tool response into the embedded SKILL_MANAGE_JSON payload.
 *
 * The engine returns markdown text with the structured payload embedded in a
 * `<!-- SKILL_MANAGE_JSON ... SKILL_MANAGE_JSON -->` comment block, so plain
 * JSON.parse of the response text fails — we MUST extract the embedded block.
 */
function parseSkillResponse(result: any): SkillManageResult | null {
  // The bridge returns { content: [{ type:'text', text }] }.
  const text: string | undefined = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  return extractEmbeddedJson<SkillManageResult>(text, 'SKILL_MANAGE_JSON');
}

/**
 * Decide whether a returned-but-bad skill_manage payload should be treated as a
 * failure BEFORE any state mutation. A payload is bad when:
 *   - it failed to parse / has no embedded block (`data` is null/undefined), or
 *   - it carries an explicit error envelope (`error` truthy), or
 *   - it reports `success === false`.
 * Returns a meaningful error string when the payload is a failure, else null.
 *
 * Treating these as failures keeps a valid, already-populated skills map from
 * being clobbered with defaults (syncSkills) or silently no-op'd (the others).
 */
function skillPayloadFailure(
  data: SkillManageResult | null | undefined,
  fallback: string
): string | null {
  if (data == null) return fallback;
  if (data.error) return data.message || fallback;
  if (data.success === false) return data.message || fallback;
  return null;
}

/** Coerce an unknown thrown value (callTool rejects with the JSON-RPC error). */
function toErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  if (typeof err === 'string' && err.length > 0) return err;
  return fallback;
}

// ============================================
// Store
// ============================================

export const useSkillStore = create<SkillState>()(
  persist(
    (set, get) => ({
      skillsByCharacter: {},
      lastResult: null,
      selectedSkill: null,
      isLoading: false,
      error: null,

      setSelectedSkill: (skill) => set({ selectedSkill: skill }),
      setError: (error) => set({ error }),

      initialize: async () => {
        // Skills load lazily per-character via syncSkills() on view mount, so
        // there is nothing eager to do here. Kept for parity with other stores
        // and as a hook if eager loading is wanted later.
        set({ error: null });
      },

      syncSkills: async (characterId) => {
        if (!characterId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('skill_manage', {
            action: 'get_skills',
            characterId,
          });
          const data = parseSkillResponse(result);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state — never overwrite a valid, populated
          // skills map with defaults on a bad sync.
          const failure = skillPayloadFailure(data, 'Failed to load skills');
          if (failure) {
            set({ error: failure });
            return;
          }

          const skills = data?.skills ?? defaultSkillMap();
          set((state) => ({
            skillsByCharacter: { ...state.skillsByCharacter, [characterId]: skills },
            lastResult: data,
          }));
        } catch (err) {
          // callTool REJECTS on a JSON-RPC error — must be caught here, never
          // allowed to bubble into a React render.
          set({ error: toErrorMessage(err, 'Failed to load skills') });
        } finally {
          set({ isLoading: false });
        }
      },

      grantXp: async (characterId, skill, amount) => {
        if (!characterId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('skill_manage', {
            action: 'grant_xp',
            characterId,
            skill,
            amount,
          });
          const data = parseSkillResponse(result);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state — never silently no-op on bad data.
          const failure = skillPayloadFailure(data, 'Failed to grant XP');
          if (failure) {
            set({ error: failure });
            return;
          }

          // Apply the recomputed xp/level for just this skill from the response.
          set((state) => {
            const existing = state.skillsByCharacter[characterId] ?? defaultSkillMap();
            const updated: SkillMap = { ...existing };
            if (data && data.newXp !== undefined && data.newLevel !== undefined) {
              updated[skill] = { xp: data.newXp, level: data.newLevel };
            }
            return {
              skillsByCharacter: { ...state.skillsByCharacter, [characterId]: updated },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to grant XP') });
        } finally {
          set({ isLoading: false });
        }
      },

      setLevel: async (characterId, skill, level) => {
        if (!characterId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('skill_manage', {
            action: 'set_level',
            characterId,
            skill,
            level,
          });
          const data = parseSkillResponse(result);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state — never silently no-op on bad data.
          const failure = skillPayloadFailure(data, 'Failed to set level');
          if (failure) {
            set({ error: failure });
            return;
          }

          set((state) => {
            const existing = state.skillsByCharacter[characterId] ?? defaultSkillMap();
            const updated: SkillMap = { ...existing };
            if (data && data.xp !== undefined && data.level !== undefined) {
              updated[skill] = { xp: data.xp, level: data.level };
            }
            return {
              skillsByCharacter: { ...state.skillsByCharacter, [characterId]: updated },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to set level') });
        } finally {
          set({ isLoading: false });
        }
      },

      checkRequirement: async (characterId, skill, level) => {
        if (!characterId) return null;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('skill_manage', {
            action: 'check_requirement',
            characterId,
            skill,
            level,
          });
          const data = parseSkillResponse(result);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state — never set lastResult to bad data.
          const failure = skillPayloadFailure(data, 'Failed to check requirement');
          if (failure) {
            set({ error: failure });
            return data ?? null;
          }

          set({ lastResult: data });
          return data;
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to check requirement') });
          return null;
        } finally {
          set({ isLoading: false });
        }
      },

      getSkills: (characterId) => {
        if (!characterId) return null;
        return get().skillsByCharacter[characterId] ?? null;
      },
    }),
    {
      name: 'quest-keeper-skill-store',
      // Persist ONLY UI prefs/ids — never the server-derived skills map (which
      // would go stale after an engine write). Mirrors partyStore persisting
      // only activePartyId.
      partialize: (state) => ({
        selectedSkill: state.selectedSkill,
      }),
    }
  )
);
