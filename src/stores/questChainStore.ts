import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { extractEmbeddedJson } from '../utils/mcpUtils';

// ============================================
// Types
// ============================================

/** Derived, per-character gating state for a quest in a chain. */
export type UnlockState = 'locked' | 'available' | 'active' | 'completed';

/** The raw quest status enum (separate from the derived unlockState). */
export type QuestStatus = 'available' | 'active' | 'completed' | 'failed';

/** A skill gate on a quest (name + required level). */
export interface ChainSkillRequirement {
  skill: string;
  level: number;
}

/** A branching choice offered by a (completed) source quest. */
export interface ChainBranch {
  choiceId: string;
  label: string;
  questId: string;
}

/** One quest node in a chain, as returned by quest_manage get_chain. */
export interface ChainQuestNode {
  id: string;
  name: string;
  order?: number;
  status: QuestStatus;
  /** DERIVED per-character by the engine — never trust a client-supplied value. */
  unlockState: UnlockState;
  prerequisites: string[];
  skillRequirements: ChainSkillRequirement[];
  nextQuests: string[];
  branches: ChainBranch[];
}

/** A fully-resolved chain graph for a character (the get_chain payload). */
export interface ChainGraph {
  chainId?: string;
  characterId?: string;
  /** Map of source-quest-id -> chosen choiceId for this character. */
  chainChoices: Record<string, string>;
  quests: ChainQuestNode[];
}

/** A single row from list_chains. */
export interface ChainSummary {
  chainId: string;
  questCount: number;
  completedCount: number;
}

/**
 * Parsed result of the last quest_manage chain call. The engine embeds the full
 * action payload (actionType + action-specific fields) in a QUEST_MANAGE_JSON
 * comment block; we keep it around so the UI can react to e.g. chosenQuestId.
 */
export interface QuestChainResult {
  success?: boolean;
  actionType?: 'get_chain' | 'list_chains' | 'set_chain' | 'select_branch';
  chainId?: string;
  characterId?: string;
  // get_chain
  chainChoices?: Record<string, string>;
  quests?: ChainQuestNode[];
  // list_chains
  count?: number;
  chains?: ChainSummary[];
  // select_branch
  questId?: string;
  choiceId?: string;
  chosenQuestId?: string;
  // error envelope
  error?: boolean;
  message?: string;
}

interface QuestChainState {
  // Server-derived chain graphs, keyed by characterId then chainId. NEVER persisted.
  chainsByCharacter: Record<string, Record<string, ChainGraph>>;
  // Server-derived list of chains (from list_chains). NEVER persisted.
  chainList: ChainSummary[];
  // The most recent parsed quest_manage payload (for branch reactions, etc.).
  lastResult: QuestChainResult | null;

  // UI preference (persisted): which chain the user last focused.
  selectedChainId: string | null;

  // Number of in-flight chain requests. isLoading is DERIVED from this so
  // overlapping requests don't desync (a fast completion can't hide a slower
  // request that's still pending). Keep the public isLoading boolean for
  // consumers (components select it directly).
  pending: number;
  isLoading: boolean;
  error: string | null;

  // Setters
  setSelectedChainId: (chainId: string | null) => void;
  setError: (error: string | null) => void;

  // Lifecycle
  initialize: () => Promise<void>;

  // Actions (all route through the single quest_manage tool, chain actions)
  listChains: (worldId?: string) => Promise<void>;
  loadChain: (chainOrQuestId: string, characterId: string) => Promise<void>;
  selectBranch: (
    questId: string,
    choiceId: string,
    characterId: string
  ) => Promise<QuestChainResult | null>;

  // Selectors
  getChains: (characterId: string | null | undefined) => Record<string, ChainGraph> | null;
}

// ============================================
// Helpers
// ============================================

/**
 * Parse a quest_manage tool response into the embedded QUEST_MANAGE_JSON payload.
 *
 * The engine returns markdown text with the structured payload embedded in a
 * `<!-- QUEST_MANAGE_JSON ... QUEST_MANAGE_JSON -->` comment block (via
 * RichFormatter.embedJson(parsed, 'QUEST_MANAGE')), so plain JSON.parse of the
 * response text fails — we MUST extract the embedded block.
 */
function parseChainResponse(result: any): QuestChainResult | null {
  // The bridge returns { content: [{ type:'text', text }] }.
  const text: string | undefined = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  return extractEmbeddedJson<QuestChainResult>(text, 'QUEST_MANAGE_JSON');
}

/**
 * Decide whether a returned-but-bad quest_manage payload should be treated as a
 * failure BEFORE any state mutation. A payload is bad when:
 *   - it failed to parse / has no embedded block (`data` is null/undefined), or
 *   - it carries an explicit error envelope (`error` truthy), or
 *   - it reports `success === false`.
 * Returns a meaningful error string when the payload is a failure, else null.
 *
 * Treating these as failures keeps a valid, already-populated chain map from
 * being clobbered (loadChain) or silently no-op'd (the others).
 */
function chainPayloadFailure(
  data: QuestChainResult | null | undefined,
  fallback: string
): string | null {
  if (data == null) return fallback;
  if (data.error) return data.message || fallback;
  if (data.success === false) return data.message || fallback;
  return null;
}

/**
 * Validate the action-specific shape of a non-failure payload BEFORE mutating
 * state. Even a `success:true` payload can drift (tool change, partial write)
 * and arrive without the array we key our state off of. Defaulting a missing
 * `quests`/`chains` to `[]` would silently clobber a valid, populated map; we
 * treat a shape mismatch as a failure instead.
 *
 *   - get_chain   requires Array.isArray(data.quests)
 *   - list_chains requires Array.isArray(data.chains)
 *
 * Returns an error string on mismatch, else null.
 */
function chainShapeFailure(
  data: QuestChainResult | null | undefined,
  expect: 'quests' | 'chains',
  fallback: string
): string | null {
  if (!data || !Array.isArray(data[expect])) return fallback;
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

export const useQuestChainStore = create<QuestChainState>()(
  persist(
    (set, get) => {
      // In-flight request accounting. isLoading is derived from `pending > 0`
      // so overlapping loads (e.g. loadChain fired per-chain in a loop) keep
      // isLoading true until ALL of them resolve, rather than the first
      // completion flipping it false while others are still running.
      const beginRequest = () =>
        set((state) => ({ pending: state.pending + 1, isLoading: true, error: null }));
      const endRequest = () =>
        set((state) => {
          const pending = Math.max(0, state.pending - 1);
          return { pending, isLoading: pending > 0 };
        });

      return {
      chainsByCharacter: {},
      chainList: [],
      lastResult: null,
      selectedChainId: null,
      pending: 0,
      isLoading: false,
      error: null,

      setSelectedChainId: (chainId) => set({ selectedChainId: chainId }),
      setError: (error) => set({ error }),

      initialize: async () => {
        // Chains load lazily per-character via loadChain()/listChains() on view
        // mount, so there is nothing eager to do here. Kept for parity with the
        // other stores and as a hook if eager loading is wanted later.
        set({ error: null });
      },

      listChains: async (worldId) => {
        beginRequest();
        try {
          const { mcpManager } = await import('../services/mcpClient');
          const args: { action: 'list_chains'; worldId?: string } = { action: 'list_chains' };
          if (worldId) args.worldId = worldId;
          const result = await mcpManager.gameStateClient.callTool('quest_manage', args);
          const data = parseChainResponse(result);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state — never overwrite a valid list.
          const failure = chainPayloadFailure(data, 'Failed to load chains');
          if (failure) {
            set({ error: failure });
            return;
          }

          // Even on success:true, require the expected array shape. A drifted
          // payload without `chains` must NOT clobber a valid list with [].
          const shapeFailure = chainShapeFailure(data, 'chains', 'Malformed chains payload');
          if (shapeFailure) {
            set({ error: shapeFailure });
            return;
          }

          set({ chainList: data!.chains!, lastResult: data });
        } catch (err) {
          // callTool REJECTS on a JSON-RPC error — must be caught here, never
          // allowed to bubble into a React render.
          set({ error: toErrorMessage(err, 'Failed to load chains') });
        } finally {
          endRequest();
        }
      },

      loadChain: async (chainOrQuestId, characterId) => {
        if (!chainOrQuestId || !characterId) return;
        beginRequest();
        try {
          const { mcpManager } = await import('../services/mcpClient');
          // get_chain resolves by chainId; the engine also resolves a source
          // questId to its chainId, so either identifier works.
          const result = await mcpManager.gameStateClient.callTool('quest_manage', {
            action: 'get_chain',
            chainId: chainOrQuestId,
            characterId,
          });
          const data = parseChainResponse(result);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state — never overwrite a valid, populated
          // chain map on a bad load.
          const failure = chainPayloadFailure(data, 'Failed to load chain');
          if (failure) {
            set({ error: failure });
            return;
          }

          // Even on success:true, require quests to be an array before keying
          // state off it. A drifted payload must NOT clobber a populated chain
          // map with an empty quests list.
          const shapeFailure = chainShapeFailure(data, 'quests', 'Malformed chain payload');
          if (shapeFailure) {
            set({ error: shapeFailure });
            return;
          }

          // Key by the engine-resolved chainId (falls back to the requested id
          // so a singleton/unnamed chain still slots in deterministically).
          const resolvedId = data!.chainId ?? chainOrQuestId;
          const graph: ChainGraph = {
            chainId: data!.chainId,
            characterId: data!.characterId ?? characterId,
            chainChoices: data!.chainChoices ?? {},
            quests: data!.quests!,
          };

          set((state) => ({
            chainsByCharacter: {
              ...state.chainsByCharacter,
              [characterId]: {
                ...(state.chainsByCharacter[characterId] ?? {}),
                [resolvedId]: graph,
              },
            },
            lastResult: data,
          }));
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to load chain') });
        } finally {
          endRequest();
        }
      },

      selectBranch: async (questId, choiceId, characterId) => {
        if (!questId || !choiceId || !characterId) return null;
        beginRequest();
        try {
          const { mcpManager } = await import('../services/mcpClient');
          // NOTE: select_branch keys the decision on the SOURCE (branching)
          // questId, NOT the chainId — the engine looks the branch up on that
          // quest's chain.branches.
          const result = await mcpManager.gameStateClient.callTool('quest_manage', {
            action: 'select_branch',
            characterId,
            questId,
            choiceId,
          });
          const data = parseChainResponse(result);

          // Treat a null-parse / error-envelope / success:false payload as a
          // failure BEFORE touching state. Also CLEAR lastResult so consumers
          // can't read a stale prior chosenQuestId from a successful earlier
          // branch.
          const failure = chainPayloadFailure(data, 'Failed to select branch');
          if (failure) {
            set({ error: failure, lastResult: null });
            return data ?? null;
          }

          set({ lastResult: data });
          return data;
        } catch (err) {
          set({ error: toErrorMessage(err, 'Failed to select branch'), lastResult: null });
          return null;
        } finally {
          endRequest();
        }
      },

      getChains: (characterId) => {
        if (!characterId) return null;
        return get().chainsByCharacter[characterId] ?? null;
      },
      };
    },
    {
      name: 'quest-keeper-quest-chain-store',
      // Persist ONLY UI prefs/ids — never the server-derived chain data (which
      // would go stale after an engine write). Mirrors skillStore persisting
      // only selectedSkill.
      partialize: (state) => ({
        selectedChainId: state.selectedChainId,
      }),
    }
  )
);
