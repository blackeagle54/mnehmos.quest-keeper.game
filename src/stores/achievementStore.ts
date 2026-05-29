import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { extractEmbeddedJson } from '../utils/mcpUtils';

// ============================================
// Types
// ============================================

/**
 * A single achievement as the engine annotates it for a character (the `list`
 * action with a characterId folds the per-character unlock/progress state into
 * each catalog entry). Incremental achievements carry `target` (and `progress`
 * once a character is in play); one-shot achievements omit them.
 */
export interface Achievement {
  id: string;
  name: string;
  description: string;
  category: string;
  points: number;
  criteria?: string;
  hidden?: boolean;
  target?: number;
  // Per-character annotations (present when listed with a characterId).
  unlocked?: boolean;
  unlockedAt?: string;
  progress?: number;
}

/**
 * Server-derived achievement state for one character: the annotated catalog plus
 * the summary totals. Kept per-character and NEVER persisted (it goes stale the
 * moment the engine records an unlock).
 */
export interface CharacterAchievements {
  catalog: Achievement[];
  totalCount: number;
  unlockedCount: number;
  totalPoints: number;
  characterName?: string;
}

/**
 * Parsed result of the last achievement_manage call. The engine embeds the full
 * action payload (actionType + action-specific fields) in an
 * ACHIEVEMENT_MANAGE_JSON comment block; we keep it around so the UI can react
 * to e.g. justUnlocked.
 */
export interface AchievementManageResult {
  success?: boolean;
  actionType?: 'define' | 'list' | 'unlock' | 'progress' | 'get' | 'revoke';
  // define
  achievement?: Achievement;
  // list
  achievements?: Achievement[];
  // unlock / progress / revoke / get
  characterId?: string;
  characterName?: string;
  achievementId?: string;
  name?: string;
  points?: number;
  unlockedAt?: string;
  alreadyUnlocked?: boolean;
  // progress
  progress?: number;
  target?: number;
  unlocked?: boolean;
  justUnlocked?: boolean;
  // get
  unlockedList?: Array<{ id: string; name: string; points: number; unlockedAt: string }>;
  inProgress?: Array<{ id: string; name: string; progress: number; target: number }>;
  totalPoints?: number;
  unlockedCount?: number;
  totalCount?: number;
  // revoke
  revoked?: boolean;
  // error envelope
  error?: boolean;
  message?: string;
}

/** Args for the optional/admin `define` action. */
export interface AchievementDefinition {
  achievementId: string;
  name: string;
  description: string;
  category: string;
  points?: number;
  criteria?: string;
  hidden?: boolean;
  target?: number;
}

interface AchievementState {
  // Server-derived achievement state, keyed by characterId. NEVER persisted.
  achievementsByCharacter: Record<string, CharacterAchievements>;
  // The most recent parsed achievement_manage payload (for toast reactions etc.).
  lastResult: AchievementManageResult | null;

  // UI preference (persisted): the active category filter (null = all).
  selectedCategory: string | null;

  isLoading: boolean;
  error: string | null;

  // Setters
  setSelectedCategory: (category: string | null) => void;
  setError: (error: string | null) => void;

  // Lifecycle
  initialize: () => Promise<void>;

  // Actions (all route through the single achievement_manage tool)
  syncAchievements: (characterId: string) => Promise<void>;
  unlock: (characterId: string, achievementId: string) => Promise<void>;
  progress: (characterId: string, achievementId: string, amount?: number) => Promise<void>;
  define: (def: AchievementDefinition) => Promise<void>;
  revoke: (characterId: string, achievementId: string) => Promise<void>;

  // Selectors
  getAchievements: (characterId: string | null | undefined) => CharacterAchievements | null;
}

// ============================================
// Helpers
// ============================================

/**
 * Parse an achievement_manage tool response into the embedded
 * ACHIEVEMENT_MANAGE_JSON payload.
 *
 * The engine returns markdown text with the structured payload embedded in an
 * `<!-- ACHIEVEMENT_MANAGE_JSON ... ACHIEVEMENT_MANAGE_JSON -->` comment block,
 * so a plain JSON.parse of the response text fails — we MUST extract the
 * embedded block (the token includes the `_JSON` suffix appended by
 * RichFormatter.embedJson(data, 'ACHIEVEMENT_MANAGE')).
 */
function parseAchievementResponse(result: any): AchievementManageResult | null {
  // The bridge returns { content: [{ type:'text', text }] }.
  const text: string | undefined = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  return extractEmbeddedJson<AchievementManageResult>(text, 'ACHIEVEMENT_MANAGE_JSON');
}

/**
 * Decide whether a returned-but-bad achievement_manage payload should be treated
 * as a failure BEFORE any state mutation. A payload is bad when:
 *   - it failed to parse / has no embedded block (`data` is null/undefined), or
 *   - it carries an explicit error envelope (`error` truthy), or
 *   - it reports `success === false`.
 * Returns a meaningful error string when the payload is a failure, else null.
 *
 * Treating these as failures keeps a valid, already-populated catalog from being
 * clobbered (syncAchievements) or silently corrupted (the mutating actions).
 */
function achievementPayloadFailure(
  data: AchievementManageResult | null | undefined,
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

/** Derive totals straight from the annotated catalog (fallback when `get` fails). */
function totalsFromCatalog(catalog: Achievement[]): {
  totalCount: number;
  unlockedCount: number;
  totalPoints: number;
} {
  let unlockedCount = 0;
  let totalPoints = 0;
  for (const a of catalog) {
    if (a.unlocked) {
      unlockedCount += 1;
      totalPoints += a.points ?? 0;
    }
  }
  return { totalCount: catalog.length, unlockedCount, totalPoints };
}

// ============================================
// Store
// ============================================

export const useAchievementStore = create<AchievementState>()(
  persist(
    (set, get) => ({
      achievementsByCharacter: {},
      lastResult: null,
      selectedCategory: null,
      isLoading: false,
      error: null,

      setSelectedCategory: (category) => set({ selectedCategory: category }),
      setError: (error) => set({ error }),

      initialize: async () => {
        // Achievements load lazily per-character via syncAchievements() on view
        // mount, so there is nothing eager to do here. Kept for parity with the
        // other stores and as a hook if eager loading is wanted later.
        set({ error: null });
      },

      syncAchievements: async (characterId) => {
        if (!characterId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');

          // 1) list (with characterId) is the source of truth for the catalog —
          //    the engine annotates each entry with unlock/progress state and
          //    omits hidden&&!unlocked entries.
          const listResult = await mcpManager.gameStateClient.callTool('achievement_manage', {
            action: 'list',
            characterId,
          });
          const listData = parseAchievementResponse(listResult);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state — never clobber a populated catalog on
          // a bad sync.
          const failure = achievementPayloadFailure(listData, 'Failed to load achievements');
          if (failure) {
            set({ error: failure });
            return;
          }

          const catalog = listData?.achievements ?? [];
          const fallbackTotals = totalsFromCatalog(catalog);

          // 2) get supplies authoritative totals (and the character name). It is
          //    best-effort: if it fails we keep the catalog and derive totals
          //    from it, since `list` already succeeded.
          let totalCount = fallbackTotals.totalCount;
          let unlockedCount = fallbackTotals.unlockedCount;
          let totalPoints = fallbackTotals.totalPoints;
          let characterName: string | undefined;
          try {
            const getResult = await mcpManager.gameStateClient.callTool('achievement_manage', {
              action: 'get',
              characterId,
            });
            const getData = parseAchievementResponse(getResult);
            if (!achievementPayloadFailure(getData, '')) {
              if (typeof getData?.totalCount === 'number') totalCount = getData.totalCount;
              if (typeof getData?.unlockedCount === 'number') unlockedCount = getData.unlockedCount;
              if (typeof getData?.totalPoints === 'number') totalPoints = getData.totalPoints;
              characterName = getData?.characterName;
            }
          } catch {
            // Swallow — totals already defaulted from the catalog above.
          }

          set((state) => ({
            achievementsByCharacter: {
              ...state.achievementsByCharacter,
              [characterId]: { catalog, totalCount, unlockedCount, totalPoints, characterName },
            },
            lastResult: listData,
          }));
        } catch (err) {
          // callTool REJECTS on a JSON-RPC error — must be caught here, never
          // allowed to bubble into a React render.
          set({ error: toErrorMessage(err, 'Failed to load achievements') });
        } finally {
          set({ isLoading: false });
        }
      },

      unlock: async (characterId, achievementId) => {
        if (!characterId || !achievementId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('achievement_manage', {
            action: 'unlock',
            characterId,
            achievementId,
          });
          const data = parseAchievementResponse(result);

          const failure = achievementPayloadFailure(data, 'Failed to unlock achievement');
          if (failure) {
            set({ error: failure });
            return;
          }

          set((state) => {
            const entry = state.achievementsByCharacter[characterId];
            if (!entry) {
              return { lastResult: data };
            }
            // Only adjust totals on a genuine (not already-unlocked) transition.
            const wasUnlocked = entry.catalog.find((a) => a.id === achievementId)?.unlocked === true;
            const newlyUnlocked = data?.alreadyUnlocked !== true && !wasUnlocked;
            const catalog = entry.catalog.map((a) =>
              a.id === achievementId
                ? { ...a, unlocked: true, unlockedAt: data?.unlockedAt ?? a.unlockedAt }
                : a
            );
            return {
              achievementsByCharacter: {
                ...state.achievementsByCharacter,
                [characterId]: {
                  ...entry,
                  catalog,
                  unlockedCount: newlyUnlocked ? entry.unlockedCount + 1 : entry.unlockedCount,
                  totalPoints: newlyUnlocked
                    ? entry.totalPoints + (data?.points ?? 0)
                    : entry.totalPoints,
                },
              },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to unlock achievement') });
        } finally {
          set({ isLoading: false });
        }
      },

      progress: async (characterId, achievementId, amount) => {
        if (!characterId || !achievementId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const args: Record<string, unknown> = { action: 'progress', characterId, achievementId };
          if (amount !== undefined) args.amount = amount;
          const result = await mcpManager.gameStateClient.callTool('achievement_manage', args);
          const data = parseAchievementResponse(result);

          const failure = achievementPayloadFailure(data, 'Failed to update progress');
          if (failure) {
            set({ error: failure });
            return;
          }

          set((state) => {
            const entry = state.achievementsByCharacter[characterId];
            if (!entry) {
              return { lastResult: data };
            }
            const justUnlocked = data?.justUnlocked === true;
            const catalog = entry.catalog.map((a) =>
              a.id === achievementId
                ? {
                    ...a,
                    progress: data?.progress ?? a.progress,
                    target: data?.target ?? a.target,
                    unlocked: data?.unlocked ?? a.unlocked,
                    unlockedAt: justUnlocked ? data?.unlockedAt ?? a.unlockedAt : a.unlockedAt,
                  }
                : a
            );
            // Points for a just-unlocked incremental achievement come from the
            // catalog entry (the progress payload does not echo points).
            const pts = entry.catalog.find((a) => a.id === achievementId)?.points ?? 0;
            return {
              achievementsByCharacter: {
                ...state.achievementsByCharacter,
                [characterId]: {
                  ...entry,
                  catalog,
                  unlockedCount: justUnlocked ? entry.unlockedCount + 1 : entry.unlockedCount,
                  totalPoints: justUnlocked ? entry.totalPoints + pts : entry.totalPoints,
                },
              },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to update progress') });
        } finally {
          set({ isLoading: false });
        }
      },

      define: async (def) => {
        if (!def?.achievementId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const args: Record<string, unknown> = {
            action: 'define',
            achievementId: def.achievementId,
            name: def.name,
            description: def.description,
            category: def.category,
          };
          if (def.points !== undefined) args.points = def.points;
          if (def.criteria !== undefined) args.criteria = def.criteria;
          if (def.hidden !== undefined) args.hidden = def.hidden;
          if (def.target !== undefined) args.target = def.target;

          const result = await mcpManager.gameStateClient.callTool('achievement_manage', args);
          const data = parseAchievementResponse(result);

          const failure = achievementPayloadFailure(data, 'Failed to define achievement');
          if (failure) {
            set({ error: failure });
            return;
          }

          // `define` mutates the global catalog, not per-character state, so we
          // only record the result; callers re-sync to pick up the new entry.
          set({ lastResult: data });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to define achievement') });
        } finally {
          set({ isLoading: false });
        }
      },

      revoke: async (characterId, achievementId) => {
        if (!characterId || !achievementId) return;
        set({ isLoading: true, error: null });
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('achievement_manage', {
            action: 'revoke',
            characterId,
            achievementId,
          });
          const data = parseAchievementResponse(result);

          const failure = achievementPayloadFailure(data, 'Failed to revoke achievement');
          if (failure) {
            set({ error: failure });
            return;
          }

          set((state) => {
            const entry = state.achievementsByCharacter[characterId];
            if (!entry || data?.revoked === false) {
              return { lastResult: data };
            }
            const wasUnlocked = entry.catalog.find((a) => a.id === achievementId)?.unlocked === true;
            const pts = entry.catalog.find((a) => a.id === achievementId)?.points ?? 0;
            const catalog = entry.catalog.map((a) =>
              a.id === achievementId
                ? { ...a, unlocked: false, unlockedAt: undefined }
                : a
            );
            return {
              achievementsByCharacter: {
                ...state.achievementsByCharacter,
                [characterId]: {
                  ...entry,
                  catalog,
                  unlockedCount: wasUnlocked
                    ? Math.max(0, entry.unlockedCount - 1)
                    : entry.unlockedCount,
                  totalPoints: wasUnlocked ? Math.max(0, entry.totalPoints - pts) : entry.totalPoints,
                },
              },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to revoke achievement') });
        } finally {
          set({ isLoading: false });
        }
      },

      getAchievements: (characterId) => {
        if (!characterId) return null;
        return get().achievementsByCharacter[characterId] ?? null;
      },
    }),
    {
      name: 'quest-keeper-achievement-store',
      // Persist ONLY UI prefs — never the server-derived achievement data (which
      // would go stale after an engine write). Mirrors skillStore persisting
      // only selectedSkill.
      partialize: (state) => ({
        selectedCategory: state.selectedCategory,
      }),
    }
  )
);
