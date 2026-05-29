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

  // Number of in-flight achievement requests. isLoading is DERIVED from this so
  // overlapping requests don't desync — a fast completion can't hide a slower
  // request that's still pending. Mirrors questChainStore.
  pending: number;
  // Per-character request token. syncAchievements snapshots list+get across
  // awaits then replaces achievementsByCharacter[characterId]; an OLDER sync
  // finishing after a NEWER one (or after a mutation) would otherwise re-lock
  // achievements. We bump this on entry, capture it locally, and drop any
  // terminal write whose captured token is stale. Mirrors questChainStore.
  requestVersionByCharacter: Record<string, number>;
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

/** The achievement_manage action a payload is expected to answer for. */
type AchievementAction = NonNullable<AchievementManageResult['actionType']>;

/**
 * Per-action required fields that a SUCCESSFUL payload must carry before we trust
 * it. A `success:true` envelope alone is not enough — a wrong-action response
 * (tool drift / mis-dispatch) or a partial write can still parse cleanly, after
 * which sync would replace the catalog with [] and the mutators would patch from
 * incomplete data. Validating the shape per action keeps populated state safe.
 *
 * Each predicate returns true when the payload is well-formed for that action.
 */
const ACTION_SHAPE_GUARDS: Record<
  AchievementAction,
  (d: AchievementManageResult) => boolean
> = {
  // The catalog source of truth — must be an array (even if empty).
  list: (d) => Array.isArray(d.achievements),
  // define echoes the created/updated achievement.
  define: (d) => d.achievement != null,
  // get supplies authoritative totals — at least one total must be a number.
  get: (d) =>
    typeof d.totalCount === 'number' ||
    typeof d.unlockedCount === 'number' ||
    typeof d.totalPoints === 'number',
  // The per-character mutators all echo the achievementId they acted on.
  unlock: (d) => typeof d.achievementId === 'string' && d.achievementId.length > 0,
  progress: (d) => typeof d.achievementId === 'string' && d.achievementId.length > 0,
  // revoke must echo a boolean `revoked` — a missing field is malformed, not an
  // implicit success (keeps revoke pessimistic, like unlock/progress).
  revoke: (d) =>
    typeof d.achievementId === 'string' &&
    d.achievementId.length > 0 &&
    typeof d.revoked === 'boolean',
};

/**
 * Decide whether a returned-but-bad achievement_manage payload should be treated
 * as a failure BEFORE any state mutation. A payload is bad when:
 *   - it failed to parse / has no embedded block (`data` is null/undefined), or
 *   - it carries an explicit error envelope (`error` truthy), or
 *   - it reports `success === false`, or
 *   - (when `expectedAction` is given) its `actionType` does not match the
 *     action we issued, or it is missing the fields required for that action.
 * Returns a meaningful error string when the payload is a failure, else null.
 *
 * Treating these as failures keeps a valid, already-populated catalog from being
 * clobbered (syncAchievements) or silently corrupted (the mutating actions).
 */
function achievementPayloadFailure(
  data: AchievementManageResult | null | undefined,
  fallback: string,
  expectedAction?: AchievementAction
): string | null {
  if (data == null) return fallback;
  if (data.error) return data.message || fallback;
  if (data.success === false) return data.message || fallback;
  if (expectedAction) {
    // Reject a wrong-action payload (e.g. a `list` call answered with a `get`
    // shape) — trusting it would clobber/patch from the wrong data.
    if (data.actionType !== expectedAction) {
      return data.message || `Unexpected achievement payload (expected ${expectedAction})`;
    }
    // Reject a right-action payload that is missing its required fields.
    if (!ACTION_SHAPE_GUARDS[expectedAction](data)) {
      return data.message || `Malformed ${expectedAction} achievement payload`;
    }
  }
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
    (set, get) => {
      // In-flight request accounting. isLoading is derived from `pending > 0` so
      // overlapping actions keep isLoading true until ALL of them resolve, rather
      // than the first completion flipping it false. Mirrors questChainStore.
      const beginRequest = () =>
        set((state) => ({ pending: state.pending + 1, isLoading: true, error: null }));
      const endRequest = () =>
        set((state) => {
          const pending = Math.max(0, state.pending - 1);
          return { pending, isLoading: pending > 0 };
        });

      // Bump and return the new request token for a character. A captured token
      // that no longer equals the current version means a newer request started
      // since — the stale completion must drop its terminal write.
      const nextRequestVersion = (characterId: string): number => {
        const current = get().requestVersionByCharacter[characterId] ?? 0;
        const next = current + 1;
        set((state) => ({
          requestVersionByCharacter: {
            ...state.requestVersionByCharacter,
            [characterId]: next,
          },
        }));
        return next;
      };
      const isCurrentRequest = (characterId: string, token: number): boolean =>
        (get().requestVersionByCharacter[characterId] ?? 0) === token;

      return {
      achievementsByCharacter: {},
      lastResult: null,
      selectedCategory: null,
      pending: 0,
      requestVersionByCharacter: {},
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
        beginRequest();
        // Capture this sync's token; a newer sync (or any later request for the
        // same character) bumps the version, so a stale completion is dropped
        // before it can re-lock achievements with older data.
        const token = nextRequestVersion(characterId);
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

          // Treat a null-parse / error-envelope / success:false / wrong-action
          // payload as a failure BEFORE touching state — never clobber a
          // populated catalog on a bad or mis-shaped sync.
          const failure = achievementPayloadFailure(
            listData,
            'Failed to load achievements',
            'list'
          );
          if (failure) {
            // Drop the error write too if a newer request superseded us.
            if (isCurrentRequest(characterId, token)) set({ error: failure });
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
            if (!achievementPayloadFailure(getData, '', 'get')) {
              if (typeof getData?.totalCount === 'number') totalCount = getData.totalCount;
              if (typeof getData?.unlockedCount === 'number') unlockedCount = getData.unlockedCount;
              if (typeof getData?.totalPoints === 'number') totalPoints = getData.totalPoints;
              characterName = getData?.characterName;
            }
          } catch {
            // Swallow — totals already defaulted from the catalog above.
          }

          // Bail if a newer sync (or a mutation's reconcile) started after we
          // snapshotted — its write is fresher and must win.
          if (!isCurrentRequest(characterId, token)) return;

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
          if (isCurrentRequest(characterId, token)) {
            set({ error: toErrorMessage(err, 'Failed to load achievements') });
          }
        } finally {
          endRequest();
        }
      },

      unlock: async (characterId, achievementId) => {
        if (!characterId || !achievementId) return;
        beginRequest();
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('achievement_manage', {
            action: 'unlock',
            characterId,
            achievementId,
          });
          const data = parseAchievementResponse(result);

          const failure = achievementPayloadFailure(
            data,
            'Failed to unlock achievement',
            'unlock'
          );
          if (failure) {
            set({ error: failure });
            return;
          }

          // Decide between a cheap optimistic patch and a full reconcile. The
          // fast path is ONLY safe for the genuine locked->unlocked transition of
          // an entry we already have. Any drift from engine truth — the entry is
          // absent locally, or the engine says it was ALREADY unlocked while we
          // show it locked — means our cached totals/flags can't be trusted, so
          // we re-sync to reconcile rather than patch from incomplete data.
          const state = get();
          const entry = state.achievementsByCharacter[characterId];
          const local = entry?.catalog.find((a) => a.id === achievementId);
          const alreadyUnlocked = data?.alreadyUnlocked === true;
          const canFastPatch = !!entry && !!local && !alreadyUnlocked && local.unlocked !== true;

          if (!canFastPatch) {
            set({ lastResult: data });
            await get().syncAchievements(characterId);
            return;
          }

          set((s) => {
            const e = s.achievementsByCharacter[characterId]!;
            const catalog = e.catalog.map((a) =>
              a.id === achievementId
                ? { ...a, unlocked: true, unlockedAt: data?.unlockedAt ?? a.unlockedAt }
                : a
            );
            return {
              achievementsByCharacter: {
                ...s.achievementsByCharacter,
                [characterId]: {
                  ...e,
                  catalog,
                  unlockedCount: e.unlockedCount + 1,
                  totalPoints: e.totalPoints + (data?.points ?? local!.points ?? 0),
                },
              },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to unlock achievement') });
        } finally {
          endRequest();
        }
      },

      progress: async (characterId, achievementId, amount) => {
        if (!characterId || !achievementId) return;
        beginRequest();
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const args: Record<string, unknown> = { action: 'progress', characterId, achievementId };
          if (amount !== undefined) args.amount = amount;
          const result = await mcpManager.gameStateClient.callTool('achievement_manage', args);
          const data = parseAchievementResponse(result);

          const failure = achievementPayloadFailure(
            data,
            'Failed to update progress',
            'progress'
          );
          if (failure) {
            set({ error: failure });
            return;
          }

          // Fast-patch only when we hold the entry AND the response is consistent
          // with local state. A justUnlocked:true that conflicts with a locally
          // already-unlocked entry (or a missing entry) means our totals would
          // double-count or drift — reconcile via a full sync instead.
          const state = get();
          const entry = state.achievementsByCharacter[characterId];
          const local = entry?.catalog.find((a) => a.id === achievementId);
          const justUnlocked = data?.justUnlocked === true;
          const conflictsWithLocal = justUnlocked && local?.unlocked === true;
          const canFastPatch = !!entry && !!local && !conflictsWithLocal;

          if (!canFastPatch) {
            set({ lastResult: data });
            await get().syncAchievements(characterId);
            return;
          }

          set((s) => {
            const e = s.achievementsByCharacter[characterId]!;
            const catalog = e.catalog.map((a) =>
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
            const pts = local!.points ?? 0;
            return {
              achievementsByCharacter: {
                ...s.achievementsByCharacter,
                [characterId]: {
                  ...e,
                  catalog,
                  unlockedCount: justUnlocked ? e.unlockedCount + 1 : e.unlockedCount,
                  totalPoints: justUnlocked ? e.totalPoints + pts : e.totalPoints,
                },
              },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to update progress') });
        } finally {
          endRequest();
        }
      },

      define: async (def) => {
        if (!def?.achievementId) return;
        beginRequest();
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

          const failure = achievementPayloadFailure(
            data,
            'Failed to define achievement',
            'define'
          );
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
          endRequest();
        }
      },

      revoke: async (characterId, achievementId) => {
        if (!characterId || !achievementId) return;
        beginRequest();
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const result = await mcpManager.gameStateClient.callTool('achievement_manage', {
            action: 'revoke',
            characterId,
            achievementId,
          });
          const data = parseAchievementResponse(result);

          const failure = achievementPayloadFailure(
            data,
            'Failed to revoke achievement',
            'revoke'
          );
          if (failure) {
            set({ error: failure });
            return;
          }

          // Fast-patch only the genuine unlocked->revoked transition of an entry
          // we hold. If the engine reports revoked:false (nothing changed there)
          // or the entry is absent locally, our cached totals can't be trusted —
          // reconcile via a full sync.
          const state = get();
          const entry = state.achievementsByCharacter[characterId];
          const local = entry?.catalog.find((a) => a.id === achievementId);
          // Pessimistic, mirroring alreadyUnlocked/justUnlocked (=== true): only a
          // boolean true is a confirmed revoke. (The shape guard already ensures
          // `revoked` is a boolean here; this stays consistent with siblings.)
          const engineRevoked = data?.revoked === true;
          const canFastPatch = !!entry && !!local && engineRevoked;

          if (!canFastPatch) {
            set({ lastResult: data });
            await get().syncAchievements(characterId);
            return;
          }

          set((s) => {
            const e = s.achievementsByCharacter[characterId]!;
            const wasUnlocked = local!.unlocked === true;
            const pts = local!.points ?? 0;
            const catalog = e.catalog.map((a) =>
              a.id === achievementId ? { ...a, unlocked: false, unlockedAt: undefined } : a
            );
            return {
              achievementsByCharacter: {
                ...s.achievementsByCharacter,
                [characterId]: {
                  ...e,
                  catalog,
                  unlockedCount: wasUnlocked
                    ? Math.max(0, e.unlockedCount - 1)
                    : e.unlockedCount,
                  totalPoints: wasUnlocked ? Math.max(0, e.totalPoints - pts) : e.totalPoints,
                },
              },
              lastResult: data,
            };
          });
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to revoke achievement') });
        } finally {
          endRequest();
        }
      },

      getAchievements: (characterId) => {
        if (!characterId) return null;
        return get().achievementsByCharacter[characterId] ?? null;
      },
      };
    },
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
