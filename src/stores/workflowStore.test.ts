/**
 * Tests for workflowStore.ts
 *
 * Zustand persist store for Phase 6 workflows. Talks to the engine via the
 * single mcpManager bridge (batch_manage tool). Mock the bridge BEFORE importing
 * the store so the lazy `import('../services/mcpClient')` resolves to the mock.
 *
 * Mirrors questChainStore.test.ts: failure payloads (null-parse / success:false /
 * error envelope) must set `error` WITHOUT clobbering already-loaded data, and
 * callTool REJECTS on a JSON-RPC error and must be caught.
 *
 * The workflow-specific contract on top of that:
 *   - runWorkflow(autoExecute:true) sends the right batch_manage args AND, on a
 *     SUCCESSFUL run, re-syncs game state (a workflow may have created
 *     characters/party/etc.).
 *   - a failed/rejected run sets error, leaves prior state intact, and does NOT
 *     trigger a re-sync (no state was mutated server-side).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Bridge + downstream store mocks (must precede the store import) ---------

vi.mock('../services/mcpClient', () => ({
  mcpManager: {
    gameStateClient: {
      callTool: vi.fn(),
    },
  },
}));

// The re-sync targets. workflowStore lazily imports these after a successful
// autoExecute run; intercept them so we can assert the re-sync fired (or did
// NOT fire) without a live engine.
const syncState = vi.fn().mockResolvedValue(undefined);
vi.mock('../stores/gameStateStore', () => ({
  useGameStateStore: {
    getState: () => ({ syncState }),
  },
}));

const syncParties = vi.fn().mockResolvedValue(undefined);
vi.mock('../stores/partyStore', () => ({
  usePartyStore: {
    getState: () => ({ syncParties }),
  },
}));

import { useWorkflowStore } from './workflowStore';
import { mcpManager } from '../services/mcpClient';

const callTool = mcpManager.gameStateClient.callTool as ReturnType<typeof vi.fn>;

// The engine wraps the JSON payload in markdown + an embedded comment block
// (RichFormatter.embedJson(parsed, 'BATCH_MANAGE')). Shape responses the way the
// live tool actually returns them so the store's extraction path is exercised.
function wrapResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Some markdown\n<!-- BATCH_MANAGE_JSON\n${JSON.stringify(payload)}\nBATCH_MANAGE_JSON -->\n`,
      },
    ],
  };
}

function sampleTemplates() {
  return [
    { id: 'onboard-party', name: 'Onboard a Party', description: 'Create a party and members.' },
    { id: 'seed-world', name: 'Seed the World', description: 'Generate a starter world.' },
  ];
}

function sampleDetailPayload() {
  return {
    success: true,
    actionType: 'get_template',
    template: {
      id: 'onboard-party',
      name: 'Onboard a Party',
      steps: [
        { tool: 'create_party', description: 'Create the party' },
        { tool: 'create_character', description: 'Create the leader' },
      ],
      requiredParams: ['partyName', 'leaderName'],
    },
  };
}

// Wait for the microtasks the lazy re-sync import schedules to flush. The store
// awaits runWorkflow's callTool, then fires the re-sync via a chained dynamic
// import; a single extra macrotask tick lets those settle before we assert.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('workflowStore', () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      templates: [],
      selectedTemplateId: null,
      detail: null,
      lastRun: null,
      pending: 0,
      isLoading: false,
      error: null,
    });
    vi.clearAllMocks();
    syncState.mockResolvedValue(undefined);
    syncParties.mockResolvedValue(undefined);
  });

  describe('initial state', () => {
    it('has the expected defaults', () => {
      const s = useWorkflowStore.getState();
      expect(s.templates).toEqual([]);
      expect(s.selectedTemplateId).toBeNull();
      expect(s.detail).toBeNull();
      expect(s.lastRun).toBeNull();
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
    });
  });

  describe('loadTemplates', () => {
    it('calls batch_manage list_templates and populates templates', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'list_templates', templates: sampleTemplates() })
      );

      await useWorkflowStore.getState().loadTemplates();

      expect(callTool).toHaveBeenCalledWith('batch_manage', { action: 'list_templates' });

      const s = useWorkflowStore.getState();
      expect(s.templates).toHaveLength(2);
      expect(s.templates[0].id).toBe('onboard-party');
      expect(s.isLoading).toBe(false);
    });

    it('sets error and does NOT clobber templates on a success:false payload', async () => {
      useWorkflowStore.setState({ templates: sampleTemplates() });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'list_templates' })
      );

      await useWorkflowStore.getState().loadTemplates();

      const s = useWorkflowStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.templates).toHaveLength(2);
    });

    it('treats a success:true payload WITHOUT a templates array as a failure', async () => {
      useWorkflowStore.setState({ templates: sampleTemplates() });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'list_templates' })
      );

      await useWorkflowStore.getState().loadTemplates();

      const s = useWorkflowStore.getState();
      expect(s.error).toBeTruthy();
      // The previously-populated list must NOT be replaced by [].
      expect(s.templates).toHaveLength(2);
    });

    it('catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce({ code: -32603, message: 'JSON-RPC error: boom' });

      await expect(useWorkflowStore.getState().loadTemplates()).resolves.toBeUndefined();

      const s = useWorkflowStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
    });
  });

  describe('loadDetail', () => {
    it('calls batch_manage get_template with the templateId and populates detail', async () => {
      callTool.mockResolvedValueOnce(wrapResponse(sampleDetailPayload()));

      await useWorkflowStore.getState().loadDetail('onboard-party');

      expect(callTool).toHaveBeenCalledWith('batch_manage', {
        action: 'get_template',
        templateId: 'onboard-party',
      });

      const s = useWorkflowStore.getState();
      expect(s.detail?.template?.id).toBe('onboard-party');
      expect(s.detail?.template?.steps).toHaveLength(2);
      expect(s.detail?.template?.requiredParams).toEqual(['partyName', 'leaderName']);
      expect(s.isLoading).toBe(false);
    });

    it('sets error and does NOT clobber a populated detail on a null-parse payload', async () => {
      useWorkflowStore.setState({ detail: sampleDetailPayload() as any });

      callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some markdown with no embedded payload at all.' }],
      });

      await useWorkflowStore.getState().loadDetail('onboard-party');

      const s = useWorkflowStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.detail?.template?.steps).toHaveLength(2);
    });

    it('sets error and does NOT clobber detail on an error-envelope payload', async () => {
      useWorkflowStore.setState({ detail: sampleDetailPayload() as any });

      callTool.mockResolvedValueOnce(
        wrapResponse({ error: true, message: 'No template found for onboard-party' })
      );

      await useWorkflowStore.getState().loadDetail('onboard-party');

      const s = useWorkflowStore.getState();
      expect(s.error).toBe('No template found for onboard-party');
      expect(s.detail?.template?.steps).toHaveLength(2);
    });
  });

  describe('runWorkflow (autoExecute:true)', () => {
    it('calls batch_manage execute_workflow with autoExecute:true + params, stores lastRun, re-syncs game state', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'execute_workflow',
          autoExecuted: true,
          executedSteps: 2,
          failureCount: 0,
          steps: [
            { tool: 'create_party', success: true },
            { tool: 'create_character', success: true },
          ],
        })
      );

      const params = { partyName: 'The Brave', leaderName: 'Aria' };
      await useWorkflowStore.getState().runWorkflow('onboard-party', params, { autoExecute: true });
      await flush();

      expect(callTool).toHaveBeenCalledWith('batch_manage', {
        action: 'execute_workflow',
        templateId: 'onboard-party',
        params,
        autoExecute: true,
      });

      const s = useWorkflowStore.getState();
      expect(s.lastRun?.autoExecuted).toBe(true);
      expect(s.lastRun?.executedSteps).toBe(2);
      expect(s.lastRun?.failureCount).toBe(0);
      expect(s.error).toBeNull();
      expect(s.isLoading).toBe(false);

      // A successful mass-mutating run MUST re-sync game state — a workflow may
      // have created characters/party/etc.
      expect(syncState).toHaveBeenCalledWith(true);
    });

    it('does NOT re-sync game state on a success:false run and sets error', async () => {
      useWorkflowStore.setState({ lastRun: { actionType: 'execute_workflow', autoExecuted: true } as any });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: false,
          actionType: 'execute_workflow',
          message: 'Missing required param: leaderName',
        })
      );

      await useWorkflowStore.getState().runWorkflow('onboard-party', {}, { autoExecute: true });
      await flush();

      const s = useWorkflowStore.getState();
      expect(s.error).toBe('Missing required param: leaderName');
      expect(s.isLoading).toBe(false);
      // No server mutation happened -> no re-sync.
      expect(syncState).not.toHaveBeenCalled();
    });

    it('does NOT re-sync game state on an error-envelope run', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({ error: true, message: 'Template not found' })
      );

      await useWorkflowStore.getState().runWorkflow('nope', {}, { autoExecute: true });
      await flush();

      const s = useWorkflowStore.getState();
      expect(s.error).toBe('Template not found');
      expect(syncState).not.toHaveBeenCalled();
    });

    it('catches a rejection, sets error, and does NOT re-sync', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      await expect(
        useWorkflowStore.getState().runWorkflow('onboard-party', {}, { autoExecute: true })
      ).resolves.toBeDefined();

      const s = useWorkflowStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(syncState).not.toHaveBeenCalled();
    });
  });

  describe('runWorkflow (autoExecute:false — dry-run preview)', () => {
    it('calls batch_manage execute_workflow with autoExecute:false and does NOT re-sync', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'execute_workflow',
          autoExecuted: false,
          steps: [
            { tool: 'create_party', resolved: true },
            { tool: 'create_character', resolved: true },
          ],
        })
      );

      await useWorkflowStore.getState().runWorkflow('onboard-party', {}, { autoExecute: false });
      await flush();

      expect(callTool).toHaveBeenCalledWith('batch_manage', {
        action: 'execute_workflow',
        templateId: 'onboard-party',
        params: {},
        autoExecute: false,
      });

      const s = useWorkflowStore.getState();
      expect(s.lastRun?.autoExecuted).toBe(false);
      // A dry-run mutates nothing server-side -> never re-sync.
      expect(syncState).not.toHaveBeenCalled();
    });
  });

  describe('setters', () => {
    it('setSelectedTemplateId updates the selection', () => {
      useWorkflowStore.getState().setSelectedTemplateId('seed-world');
      expect(useWorkflowStore.getState().selectedTemplateId).toBe('seed-world');
    });
  });

  describe('in-flight counter (isLoading derived from pending)', () => {
    it('keeps isLoading true until BOTH overlapping loads resolve', async () => {
      const deferred = <T,>() => {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      };

      const first = deferred<unknown>();
      const second = deferred<unknown>();
      callTool.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const p1 = useWorkflowStore.getState().loadTemplates();
      const p2 = useWorkflowStore.getState().loadDetail('onboard-party');

      expect(useWorkflowStore.getState().pending).toBe(2);
      expect(useWorkflowStore.getState().isLoading).toBe(true);

      first.resolve(
        wrapResponse({ success: true, actionType: 'list_templates', templates: sampleTemplates() })
      );
      await p1;

      expect(useWorkflowStore.getState().pending).toBe(1);
      expect(useWorkflowStore.getState().isLoading).toBe(true);

      second.resolve(wrapResponse(sampleDetailPayload()));
      await p2;

      expect(useWorkflowStore.getState().pending).toBe(0);
      expect(useWorkflowStore.getState().isLoading).toBe(false);
    });

    it('never drives pending below zero', async () => {
      callTool.mockResolvedValue(
        wrapResponse({ success: true, actionType: 'list_templates', templates: sampleTemplates() })
      );
      await useWorkflowStore.getState().loadTemplates();
      expect(useWorkflowStore.getState().pending).toBe(0);
      expect(useWorkflowStore.getState().isLoading).toBe(false);
    });
  });

  describe('persist partialize', () => {
    it('persists only selectedTemplateId, never the server-derived data', () => {
      const persistApi = (useWorkflowStore as unknown as {
        persist: { getOptions: () => { partialize?: (s: any) => any } };
      }).persist;
      const partialize = persistApi.getOptions().partialize;
      expect(partialize).toBeTypeOf('function');

      const partial = partialize!({
        templates: sampleTemplates(),
        selectedTemplateId: 'onboard-party',
        detail: sampleDetailPayload(),
        lastRun: { actionType: 'execute_workflow', autoExecuted: true },
        isLoading: true,
        error: 'x',
      });

      expect(partial).not.toHaveProperty('templates');
      expect(partial).not.toHaveProperty('detail');
      expect(partial).not.toHaveProperty('lastRun');
      expect(partial).not.toHaveProperty('isLoading');
      expect(partial).not.toHaveProperty('error');
      expect(partial.selectedTemplateId).toBe('onboard-party');
    });
  });
});
