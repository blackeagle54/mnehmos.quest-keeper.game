import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { extractEmbeddedJson } from '../utils/mcpUtils';

// ============================================
// Types
// ============================================

/** A single row from batch_manage list_templates. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  // The engine may attach extra metadata (step count, tags, ...). Keep it open
  // so a drifted/extended payload still slots in without a type break.
  [key: string]: unknown;
}

/** One step in a workflow template (as returned by get_template). */
export interface WorkflowStep {
  tool?: string;
  description?: string;
  [key: string]: unknown;
}

/** The full template definition (the get_template payload's `template`). */
export interface WorkflowTemplateDetail {
  id: string;
  name: string;
  steps: WorkflowStep[];
  requiredParams?: string[];
  [key: string]: unknown;
}

/**
 * Parsed result of a batch_manage get_template call. The engine embeds the full
 * action payload in a BATCH_MANAGE_JSON comment block; we keep the envelope so
 * the UI can react to actionType/error fields.
 */
export interface WorkflowDetailResult {
  success?: boolean;
  actionType?: 'get_template';
  template?: WorkflowTemplateDetail;
  error?: boolean;
  message?: string;
}

/** One step result from an executed workflow. */
export interface WorkflowRunStep {
  tool?: string;
  success?: boolean;
  resolved?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Parsed result of a batch_manage execute_workflow call (dry-run OR executed).
 *   - autoExecute:false → autoExecuted:false, prepared/resolved steps
 *   - autoExecute:true  → autoExecuted:true, executedSteps/failureCount/results
 */
export interface WorkflowRunResult {
  success?: boolean;
  actionType?: 'execute_workflow';
  autoExecuted?: boolean;
  executedSteps?: number;
  failureCount?: number;
  steps?: WorkflowRunStep[];
  results?: WorkflowRunStep[];
  error?: boolean;
  message?: string;
}

/** Options for a runWorkflow call. */
export interface RunWorkflowOptions {
  /**
   * When true, the engine EXECUTES the workflow (mass-mutating game state) and
   * the store re-syncs game state afterward. When false, it is a dry-run preview
   * that mutates nothing.
   */
  autoExecute: boolean;
}

interface WorkflowState {
  // Server-derived template list (from list_templates). NEVER persisted.
  templates: WorkflowTemplate[];
  // Server-derived detail for the selected template (from get_template). NEVER persisted.
  detail: WorkflowDetailResult | null;
  // The most recent execute_workflow payload (dry-run or executed). NEVER persisted.
  lastRun: WorkflowRunResult | null;

  // UI preference (persisted): which template the user last focused.
  selectedTemplateId: string | null;

  // In-flight request accounting. isLoading is DERIVED from `pending > 0` so
  // overlapping requests don't desync (a fast completion can't hide a slower
  // request that's still pending).
  pending: number;
  isLoading: boolean;
  error: string | null;

  // Setters
  setSelectedTemplateId: (templateId: string | null) => void;
  setError: (error: string | null) => void;

  // Actions (all route through the single batch_manage tool)
  loadTemplates: () => Promise<void>;
  loadDetail: (templateId: string) => Promise<void>;
  runWorkflow: (
    templateId: string,
    params: Record<string, unknown>,
    opts: RunWorkflowOptions
  ) => Promise<WorkflowRunResult | null>;
}

// ============================================
// Helpers
// ============================================

/**
 * Parse a batch_manage tool response into the embedded BATCH_MANAGE_JSON payload.
 *
 * The engine returns markdown text with the structured payload embedded in a
 * `<!-- BATCH_MANAGE_JSON ... BATCH_MANAGE_JSON -->` comment block (via
 * RichFormatter.embedJson(parsed, 'BATCH_MANAGE')), so a plain JSON.parse of the
 * response text fails — we MUST extract the embedded block. Mirrors how
 * achievementStore/reputationStore parse their envelopes (FULL _JSON token).
 */
function parseBatchResponse<T>(result: any): T | null {
  // The bridge returns { content: [{ type:'text', text }] }.
  const text: string | undefined = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  return extractEmbeddedJson<T>(text, 'BATCH_MANAGE_JSON');
}

/**
 * Decide whether a returned-but-bad batch_manage payload should be treated as a
 * failure BEFORE any state mutation. A payload is bad when:
 *   - it failed to parse / has no embedded block (`data` is null/undefined), or
 *   - it carries an explicit error envelope (`error` truthy), or
 *   - it reports `success === false`.
 * Returns a meaningful error string when the payload is a failure, else null.
 *
 * Treating these as failures keeps already-populated state (templates/detail)
 * from being clobbered on a bad load.
 */
function batchPayloadFailure(
  data: { success?: boolean; error?: boolean; message?: string } | null | undefined,
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

/**
 * After a SUCCESSFUL autoExecute run, re-sync game state — a workflow may have
 * created characters/party/world entities. Mirrors how LLMService syncs after
 * mutating tools: lazy, fire-and-forget, and each leg guarded so a sync failure
 * never bubbles into the caller (the run itself already succeeded). Fired from a
 * non-blocking context so the store's `pending`/`isLoading` already settled.
 *
 * NOTE on error visibility: syncState()/syncParties() catch their OWN failures
 * internally (they don't reject), so the `.catch` below only ever fires on a
 * dynamic-import failure. A failed refresh therefore leaves the local view stale
 * without a banner — accepted here because the server mutation already succeeded
 * and the next sync/refresh reconciles it. Surfacing it would require changing
 * those shared stores' error semantics (out of scope for this store).
 */
function resyncAfterRun(): void {
  // gameState is the POV source of truth; force the sync (bypass the rate limit)
  // so a fresh workflow result is reflected immediately.
  import('../stores/gameStateStore')
    .then(({ useGameStateStore }) => useGameStateStore.getState().syncState(true))
    .catch((e) => console.warn('[workflowStore] game state re-sync failed:', e));
  // A workflow can also create/modify parties; refresh the party roster too.
  import('../stores/partyStore')
    .then(({ usePartyStore }) => usePartyStore.getState().syncParties())
    .catch((e) => console.warn('[workflowStore] party re-sync failed:', e));
}

// ============================================
// Store
// ============================================

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set) => {
      // Monotonic token for loadDetail: a newer call bumps it, so an older (slower)
      // response can detect it has been superseded by a newer selection and bow out
      // (the project's request-version staleness guard).
      let detailRequestSeq = 0;

      // isLoading is derived from `pending > 0` so overlapping loads keep
      // isLoading true until ALL of them resolve.
      const beginRequest = () =>
        set((state) => ({ pending: state.pending + 1, isLoading: true, error: null }));
      const endRequest = () =>
        set((state) => {
          const pending = Math.max(0, state.pending - 1);
          return { pending, isLoading: pending > 0 };
        });

      return {
        templates: [],
        detail: null,
        lastRun: null,
        selectedTemplateId: null,
        pending: 0,
        isLoading: false,
        error: null,

        setSelectedTemplateId: (templateId) => set({ selectedTemplateId: templateId }),
        setError: (error) => set({ error }),

        loadTemplates: async () => {
          beginRequest();
          try {
            const { mcpManager } = await import('../services/mcpClient');
            const result = await mcpManager.gameStateClient.callTool('batch_manage', {
              action: 'list_templates',
            });
            const data = parseBatchResponse<{
              success?: boolean;
              error?: boolean;
              message?: string;
              templates?: WorkflowTemplate[];
            }>(result);

            // Treat a null-parse / error-envelope / success:false payload as a
            // failure BEFORE touching state — never overwrite a valid list.
            const failure = batchPayloadFailure(data, 'Failed to load workflow templates');
            if (failure) {
              set({ error: failure });
              return;
            }

            // Even on success:true, require the expected array shape. A drifted
            // payload without `templates` must NOT clobber a valid list with [].
            if (!Array.isArray(data!.templates)) {
              set({ error: 'Malformed templates payload' });
              return;
            }

            set({ templates: data!.templates });
          } catch (err) {
            // callTool REJECTS on a JSON-RPC error — must be caught here, never
            // allowed to bubble into a React render.
            set({ error: toErrorMessage(err, 'Failed to load workflow templates') });
          } finally {
            endRequest();
          }
        },

        loadDetail: async (templateId) => {
          if (!templateId) return;
          // Claim a token for THIS request; a later loadDetail will bump it past us.
          const seq = ++detailRequestSeq;
          beginRequest();
          try {
            const { mcpManager } = await import('../services/mcpClient');
            const result = await mcpManager.gameStateClient.callTool('batch_manage', {
              action: 'get_template',
              templateId,
            });

            // STALENESS: if a newer loadDetail superseded this one, drop the whole
            // response — set neither detail NOR error from a stale request, so a
            // slow response for an old selection can't clobber the current detail.
            if (seq !== detailRequestSeq) return;

            const data = parseBatchResponse<WorkflowDetailResult>(result);

            // Treat a null-parse / error-envelope / success:false payload as a
            // failure BEFORE touching state — never overwrite a populated detail.
            const failure = batchPayloadFailure(data, 'Failed to load workflow template');
            if (failure) {
              set({ error: failure });
              return;
            }

            // Even on success:true, require the template object shape. A drifted
            // payload without `template` must NOT clobber a populated detail
            // (mirrors loadTemplates' array-shape guard).
            if (!data!.template || typeof data!.template !== 'object') {
              set({ error: 'Malformed template payload' });
              return;
            }

            set({ detail: data });
          } catch (err) {
            // Only surface the error if THIS request is still current — a stale
            // request's rejection must not clobber the live template's state.
            if (seq === detailRequestSeq) {
              set({ error: toErrorMessage(err, 'Failed to load workflow template') });
            }
          } finally {
            endRequest();
          }
        },

        runWorkflow: async (templateId, params, opts) => {
          if (!templateId) return null;
          const autoExecute = !!opts?.autoExecute;
          beginRequest();
          try {
            const { mcpManager } = await import('../services/mcpClient');
            const result = await mcpManager.gameStateClient.callTool('batch_manage', {
              action: 'execute_workflow',
              templateId,
              params: params ?? {},
              autoExecute,
            });
            const data = parseBatchResponse<WorkflowRunResult>(result);

            // Treat a null-parse / error-envelope / success:false payload as a
            // failure BEFORE touching state. A failed run mutated nothing
            // server-side, so we must NOT re-sync game state.
            const failure = batchPayloadFailure(data, 'Failed to run workflow');
            if (failure) {
              set({ error: failure });
              return data ?? null;
            }

            set({ lastRun: data });

            // Only an EXECUTED (autoExecute:true) run mass-mutates game state; a
            // dry-run preview (autoExecute:false) changes nothing, so it must not
            // trigger a re-sync. Fire the re-sync from the finally tail so the
            // store's pending counter has already settled.
            if (autoExecute) {
              // Defer until after endRequest() runs so isLoading reflects the
              // run itself, not the trailing background sync.
              queueMicrotask(resyncAfterRun);
            }

            return data;
          } catch (err) {
            // A rejection means the call never landed — no mutation, no re-sync.
            set({ error: toErrorMessage(err, 'Failed to run workflow') });
            return null;
          } finally {
            endRequest();
          }
        },
      };
    },
    {
      name: 'quest-keeper-workflow-store',
      // Persist ONLY the UI pref — never the server-derived templates/detail/run
      // (which would go stale after an engine write). Mirrors questChainStore
      // persisting only selectedChainId.
      partialize: (state) => ({
        selectedTemplateId: state.selectedTemplateId,
      }),
    }
  )
);
