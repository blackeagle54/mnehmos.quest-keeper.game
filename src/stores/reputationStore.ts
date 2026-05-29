import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { extractEmbeddedJson } from '../utils/mcpUtils';

// ============================================
// Types
// ============================================

/** The frozen standing ladder, ordered best -> worst. */
export type Standing =
  | 'Exalted'
  | 'Revered'
  | 'Honored'
  | 'Friendly'
  | 'Neutral'
  | 'Unfriendly'
  | 'Hostile'
  | 'Hated';

/** The clamp bounds for a reputation value (FROZEN — matches the engine). */
export const REPUTATION_MIN = -1000;
export const REPUTATION_MAX = 1000;

/**
 * Derive a standing from a reputation value, matching the FROZEN engine tiers:
 *   >=1000 Exalted; >=600 Revered; >=300 Honored; >=100 Friendly; >=0 Neutral;
 *   >=-100 Unfriendly; >=-500 Hostile; else Hated.
 * The value is clamped to [-1000, 1000] first. Used only when annotating a value
 * locally (a faction with no per-character entry, or a payload that echoes a raw
 * value without a standing). We otherwise PREFER the engine-provided standing.
 */
export function standingFromValue(value: number): Standing {
  const v = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, value));
  if (v >= 1000) return 'Exalted';
  if (v >= 600) return 'Revered';
  if (v >= 300) return 'Honored';
  if (v >= 100) return 'Friendly';
  if (v >= 0) return 'Neutral';
  if (v >= -100) return 'Unfriendly';
  if (v >= -500) return 'Hostile';
  return 'Hated';
}

/**
 * A single faction as the engine annotates it for a character (`list_factions`
 * with a characterId folds the per-character value/standing into each catalog
 * entry). A faction with no per-character entry yields value 0 / Neutral.
 */
export interface Faction {
  id: string;
  name: string;
  description: string;
  value: number;
  standing: Standing;
}

/**
 * Server-derived reputation state for one character: the annotated faction list
 * plus the count. Kept per-character and NEVER persisted (it goes stale the
 * moment the engine records an adjust/set).
 */
export interface CharacterReputation {
  factions: Faction[];
  factionCount: number;
  characterName?: string;
}

/**
 * Parsed result of the last reputation_manage call. The engine embeds the full
 * action payload (actionType + action-specific fields) in a
 * REPUTATION_MANAGE_JSON comment block; we keep it around so the UI can react.
 */
export interface ReputationManageResult {
  success?: boolean;
  actionType?: 'list_factions' | 'get' | 'adjust' | 'set' | 'define_faction' | 'check';
  // list_factions
  factions?: Array<{ id: string; name: string; description?: string; value?: number; standing?: Standing }>;
  // get
  characterId?: string;
  characterName?: string;
  reputations?: Array<{ id: string; name: string; value: number; standing: Standing }>;
  factionCount?: number;
  // adjust
  factionId?: string;
  name?: string;
  oldValue?: number;
  newValue?: number;
  oldStanding?: Standing;
  newStanding?: Standing;
  standingChanged?: boolean;
  // set / list_factions entry / check
  value?: number;
  standing?: Standing;
  // define_faction
  faction?: { id: string; name: string; description?: string };
  // check
  currentValue?: number;
  currentStanding?: Standing;
  requiredValue?: number;
  met?: boolean;
  shortfall?: number;
  // error envelope
  error?: boolean;
  message?: string;
}

/** Args for the `define_faction` action. */
export interface FactionDefinition {
  factionId: string;
  name: string;
  description?: string;
}

/** The structured result of a `check` call (returned to callers). */
export interface ReputationCheck {
  factionId: string;
  name?: string;
  currentValue: number;
  currentStanding?: Standing;
  requiredValue: number;
  met: boolean;
  shortfall: number;
}

interface ReputationState {
  // Server-derived reputation state, keyed by characterId. NEVER persisted.
  reputationByCharacter: Record<string, CharacterReputation>;
  // The most recent parsed reputation_manage payload (for toast reactions etc.).
  lastResult: ReputationManageResult | null;

  // UI preference (persisted): the active faction selection (null = none).
  selectedFaction: string | null;

  // Number of in-flight reputation requests. isLoading is DERIVED from this so
  // overlapping requests don't desync — a fast completion can't hide a slower
  // request that's still pending. Mirrors achievementStore.
  pending: number;
  // Per-character request token. syncReputation snapshots list+get across awaits
  // then replaces reputationByCharacter[characterId]; an OLDER sync finishing
  // after a NEWER one (or after a mutation) would otherwise stomp fresher data.
  // We bump this on entry, capture it locally, and drop any terminal write whose
  // captured token is stale. Mirrors achievementStore.
  requestVersionByCharacter: Record<string, number>;
  isLoading: boolean;
  error: string | null;

  // Setters
  setSelectedFaction: (factionId: string | null) => void;
  setError: (error: string | null) => void;

  // Lifecycle
  initialize: () => Promise<void>;

  // Actions (all route through the single reputation_manage tool)
  syncReputation: (characterId: string) => Promise<void>;
  adjust: (characterId: string, factionId: string, amount: number) => Promise<void>;
  set: (characterId: string, factionId: string, value: number) => Promise<void>;
  defineFaction: (def: FactionDefinition) => Promise<void>;
  check: (characterId: string, factionId: string, value: number) => Promise<ReputationCheck | null>;

  // Selectors
  getReputation: (characterId: string | null | undefined) => CharacterReputation | null;
}

// ============================================
// Helpers
// ============================================

/**
 * Parse a reputation_manage tool response into the embedded
 * REPUTATION_MANAGE_JSON payload.
 *
 * The engine returns markdown text with the structured payload embedded in a
 * `<!-- REPUTATION_MANAGE_JSON ... REPUTATION_MANAGE_JSON -->` comment block, so
 * a plain JSON.parse of the response text fails — we MUST extract the embedded
 * block (the token includes the `_JSON` suffix appended by
 * RichFormatter.embedJson(data, 'REPUTATION_MANAGE')).
 */
function parseReputationResponse(result: any): ReputationManageResult | null {
  // The bridge returns { content: [{ type:'text', text }] }.
  const text: string | undefined = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  return extractEmbeddedJson<ReputationManageResult>(text, 'REPUTATION_MANAGE_JSON');
}

/** The reputation_manage action a payload is expected to answer for. */
type ReputationAction = NonNullable<ReputationManageResult['actionType']>;

/**
 * Per-action required fields that a SUCCESSFUL payload must carry before we trust
 * it. A `success:true` envelope alone is not enough — a wrong-action response
 * (tool drift / mis-dispatch) or a partial write can still parse cleanly, after
 * which sync would replace the list with [] and the mutators would patch from
 * incomplete data. Validating the shape per action keeps populated state safe.
 *
 * Each predicate returns true when the payload is well-formed for that action.
 */
const ACTION_SHAPE_GUARDS: Record<
  ReputationAction,
  (d: ReputationManageResult) => boolean
> = {
  // The catalog source of truth — must be an array (even if empty).
  list_factions: (d) => Array.isArray(d.factions),
  // get supplies authoritative count + character name.
  get: (d) => typeof d.factionCount === 'number' || Array.isArray(d.reputations),
  // adjust echoes the factionId it acted on plus the new value.
  adjust: (d) =>
    typeof d.factionId === 'string' &&
    d.factionId.length > 0 &&
    typeof d.newValue === 'number',
  // set echoes the factionId and the written value.
  set: (d) =>
    typeof d.factionId === 'string' &&
    d.factionId.length > 0 &&
    typeof d.value === 'number',
  // define_faction echoes the created/updated faction.
  define_faction: (d) => d.faction != null,
  // check echoes the factionId plus the met boolean.
  check: (d) =>
    typeof d.factionId === 'string' &&
    d.factionId.length > 0 &&
    typeof d.met === 'boolean',
};

/**
 * Decide whether a returned-but-bad reputation_manage payload should be treated
 * as a failure BEFORE any state mutation. A payload is bad when:
 *   - it failed to parse / has no embedded block (`data` is null/undefined), or
 *   - it carries an explicit error envelope (`error` truthy), or
 *   - it reports `success === false`, or
 *   - (when `expectedAction` is given) its `actionType` does not match the action
 *     we issued, or it is missing the fields required for that action.
 * Returns a meaningful error string when the payload is a failure, else null.
 *
 * Treating these as failures keeps a valid, already-populated list from being
 * clobbered (syncReputation) or silently corrupted (the mutating actions).
 */
function reputationPayloadFailure(
  data: ReputationManageResult | null | undefined,
  fallback: string,
  expectedAction?: ReputationAction
): string | null {
  // Guarantee a NON-EMPTY failure string so callers that test truthiness
  // (`if (!reputationPayloadFailure(...))`) can never mistake a failure for
  // success. An empty fallback previously made a success:false payload return
  // '' (falsy), which let failed-get fields leak into state.
  const fb = fallback || 'Invalid reputation payload';
  if (data == null) return fb;
  if (data.error) return data.message || fb;
  if (data.success === false) return data.message || fb;
  if (expectedAction) {
    // Reject a wrong-action payload (e.g. a list_factions call answered with a
    // get shape) — trusting it would clobber/patch from the wrong data.
    if (data.actionType !== expectedAction) {
      return data.message || `Unexpected reputation payload (expected ${expectedAction})`;
    }
    // Reject a right-action payload that is missing its required fields.
    if (!ACTION_SHAPE_GUARDS[expectedAction](data)) {
      return data.message || `Malformed ${expectedAction} reputation payload`;
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

/**
 * Normalize a raw list_factions entry into a fully-annotated Faction. A faction
 * with no per-character entry omits value/standing — it defaults to 0 / Neutral.
 * When a value is present but the standing is not, derive it from the value.
 */
function normalizeFaction(raw: {
  id: string;
  name: string;
  description?: string;
  value?: number;
  standing?: Standing;
}): Faction {
  const value = typeof raw.value === 'number' ? raw.value : 0;
  const standing = raw.standing ?? standingFromValue(value);
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    value,
    standing,
  };
}

// ============================================
// Store
// ============================================

export const useReputationStore = create<ReputationState>()(
  persist(
    (set, get) => {
      // In-flight request accounting. isLoading is derived from `pending > 0` so
      // overlapping actions keep isLoading true until ALL of them resolve, rather
      // than the first completion flipping it false. Mirrors achievementStore.
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
        reputationByCharacter: {},
        lastResult: null,
        selectedFaction: null,
        pending: 0,
        requestVersionByCharacter: {},
        isLoading: false,
        error: null,

        setSelectedFaction: (factionId) => set({ selectedFaction: factionId }),
        setError: (error) => set({ error }),

        initialize: async () => {
          // Reputation loads lazily per-character via syncReputation() on view
          // mount, so there is nothing eager to do here. Kept for parity with the
          // other stores and as a hook if eager loading is wanted later.
          set({ error: null });
        },

        syncReputation: async (characterId) => {
          if (!characterId) return;
          beginRequest();
          // Capture this sync's token; a newer sync (or any later request for the
          // same character) bumps the version, so a stale completion is dropped
          // before it can stomp fresher data.
          const token = nextRequestVersion(characterId);
          try {
            const { mcpManager } = await import('../services/mcpClient');

            // 1) list_factions (with characterId) is the source of truth for the
            //    catalog — the engine annotates each entry with the character's
            //    value/standing (omitted -> Neutral/0).
            const listResult = await mcpManager.gameStateClient.callTool('reputation_manage', {
              action: 'list_factions',
              characterId,
            });
            const listData = parseReputationResponse(listResult);

            // Treat a null-parse / error-envelope / success:false / wrong-action
            // payload as a failure BEFORE touching state — never clobber a
            // populated list on a bad or mis-shaped sync.
            const failure = reputationPayloadFailure(
              listData,
              'Failed to load reputation',
              'list_factions'
            );
            if (failure) {
              // Drop the error write too if a newer request superseded us.
              if (isCurrentRequest(characterId, token)) set({ error: failure });
              return;
            }

            const factions = (listData?.factions ?? []).map(normalizeFaction);
            let factionCount = factions.length;
            let characterName: string | undefined;

            // 2) get supplies the authoritative count (and the character name). It
            //    is best-effort: if it fails we keep the list and derive the count
            //    from it, since list_factions already succeeded.
            try {
              const getResult = await mcpManager.gameStateClient.callTool('reputation_manage', {
                action: 'get',
                characterId,
              });
              const getData = parseReputationResponse(getResult);
              if (!reputationPayloadFailure(getData, '', 'get')) {
                if (typeof getData?.factionCount === 'number') factionCount = getData.factionCount;
                characterName = getData?.characterName;
              }
            } catch {
              // Swallow — count already defaulted from the list above.
            }

            // Bail if a newer sync (or a mutation's reconcile) started after we
            // snapshotted — its write is fresher and must win.
            if (!isCurrentRequest(characterId, token)) return;

            set((state) => ({
              reputationByCharacter: {
                ...state.reputationByCharacter,
                [characterId]: { factions, factionCount, characterName },
              },
              lastResult: listData,
            }));
          } catch (err) {
            // callTool REJECTS on a JSON-RPC error — must be caught here, never
            // allowed to bubble into a React render.
            if (isCurrentRequest(characterId, token)) {
              set({ error: toErrorMessage(err, 'Failed to load reputation') });
            }
          } finally {
            endRequest();
          }
        },

        adjust: async (characterId, factionId, amount) => {
          if (!characterId || !factionId) return;
          beginRequest();
          try {
            const { mcpManager } = await import('../services/mcpClient');
            const result = await mcpManager.gameStateClient.callTool('reputation_manage', {
              action: 'adjust',
              characterId,
              factionId,
              amount,
            });
            const data = parseReputationResponse(result);

            const failure = reputationPayloadFailure(
              data,
              'Failed to adjust reputation',
              'adjust'
            );
            if (failure) {
              set({ error: failure });
              return;
            }

            // Fast-patch only when we already hold the faction. If it is absent
            // locally our cached list/count can't be trusted — reconcile via a
            // full sync rather than patch from incomplete data.
            const state = get();
            const entry = state.reputationByCharacter[characterId];
            const local = entry?.factions.find((f) => f.id === factionId);
            const canFastPatch = !!entry && !!local;

            if (!canFastPatch) {
              set({ lastResult: data });
              await get().syncReputation(characterId);
              return;
            }

            const newValue = data!.newValue!;
            const newStanding = data?.newStanding ?? standingFromValue(newValue);
            set((s) => {
              const e = s.reputationByCharacter[characterId]!;
              const factions = e.factions.map((f) =>
                f.id === factionId ? { ...f, value: newValue, standing: newStanding } : f
              );
              return {
                reputationByCharacter: {
                  ...s.reputationByCharacter,
                  [characterId]: { ...e, factions },
                },
                lastResult: data,
              };
            });
          } catch (err) {
            set({ error: toErrorMessage(err, 'Failed to adjust reputation') });
          } finally {
            endRequest();
          }
        },

        set: async (characterId, factionId, value) => {
          if (!characterId || !factionId) return;
          beginRequest();
          try {
            const { mcpManager } = await import('../services/mcpClient');
            const result = await mcpManager.gameStateClient.callTool('reputation_manage', {
              action: 'set',
              characterId,
              factionId,
              value,
            });
            const data = parseReputationResponse(result);

            const failure = reputationPayloadFailure(
              data,
              'Failed to set reputation',
              'set'
            );
            if (failure) {
              set({ error: failure });
              return;
            }

            // Fast-patch only when we already hold the faction; otherwise the
            // cached list/count can't be trusted — reconcile via a full sync.
            const state = get();
            const entry = state.reputationByCharacter[characterId];
            const local = entry?.factions.find((f) => f.id === factionId);
            const canFastPatch = !!entry && !!local;

            if (!canFastPatch) {
              set({ lastResult: data });
              await get().syncReputation(characterId);
              return;
            }

            const newValue = data!.value!;
            const newStanding = data?.standing ?? standingFromValue(newValue);
            set((s) => {
              const e = s.reputationByCharacter[characterId]!;
              const factions = e.factions.map((f) =>
                f.id === factionId ? { ...f, value: newValue, standing: newStanding } : f
              );
              return {
                reputationByCharacter: {
                  ...s.reputationByCharacter,
                  [characterId]: { ...e, factions },
                },
                lastResult: data,
              };
            });
          } catch (err) {
            set({ error: toErrorMessage(err, 'Failed to set reputation') });
          } finally {
            endRequest();
          }
        },

        defineFaction: async (def) => {
          if (!def?.factionId) return;
          beginRequest();
          try {
            const { mcpManager } = await import('../services/mcpClient');
            const args: Record<string, unknown> = {
              action: 'define_faction',
              factionId: def.factionId,
              name: def.name,
            };
            if (def.description !== undefined) args.description = def.description;

            const result = await mcpManager.gameStateClient.callTool('reputation_manage', args);
            const data = parseReputationResponse(result);

            const failure = reputationPayloadFailure(
              data,
              'Failed to define faction',
              'define_faction'
            );
            if (failure) {
              set({ error: failure });
              return;
            }

            // define_faction mutates the global catalog, not per-character state,
            // so we only record the result; callers re-sync to pick up the entry.
            set({ lastResult: data });
          } catch (err) {
            set({ error: toErrorMessage(err, 'Failed to define faction') });
          } finally {
            endRequest();
          }
        },

        check: async (characterId, factionId, value) => {
          if (!characterId || !factionId) return null;
          beginRequest();
          try {
            const { mcpManager } = await import('../services/mcpClient');
            const result = await mcpManager.gameStateClient.callTool('reputation_manage', {
              action: 'check',
              characterId,
              factionId,
              value,
            });
            const data = parseReputationResponse(result);

            const failure = reputationPayloadFailure(
              data,
              'Failed to check reputation',
              'check'
            );
            if (failure) {
              set({ error: failure });
              return null;
            }

            set({ lastResult: data });
            return {
              factionId: data!.factionId!,
              name: data?.name,
              currentValue: data?.currentValue ?? 0,
              currentStanding: data?.currentStanding,
              requiredValue: data?.requiredValue ?? value,
              met: data!.met === true,
              shortfall: data?.shortfall ?? 0,
            };
          } catch (err) {
            set({ error: toErrorMessage(err, 'Failed to check reputation') });
            return null;
          } finally {
            endRequest();
          }
        },

        getReputation: (characterId) => {
          if (!characterId) return null;
          return get().reputationByCharacter[characterId] ?? null;
        },
      };
    },
    {
      name: 'quest-keeper-reputation-store',
      // Persist ONLY UI prefs — never the server-derived reputation data (which
      // would go stale after an engine write). Mirrors achievementStore
      // persisting only selectedCategory.
      partialize: (state) => ({
        selectedFaction: state.selectedFaction,
      }),
    }
  )
);
