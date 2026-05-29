/**
 * Tests for questChainStore.ts
 *
 * Zustand persist store for Phase 3 quest chains. Talks to the engine via the
 * single mcpManager bridge (quest_manage tool, chain actions). Mock the bridge
 * BEFORE importing the store so the lazy `import('../services/mcpClient')`
 * resolves to the mock.
 *
 * Mirrors skillStore.test.ts exactly: failure payloads (null-parse /
 * success:false / error envelope) must set `error` WITHOUT clobbering already
 * loaded chain data; callTool REJECTS on JSON-RPC error and must be caught.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP client bridge before importing the store.
vi.mock('../services/mcpClient', () => ({
  mcpManager: {
    gameStateClient: {
      callTool: vi.fn(),
    },
  },
}));

import { useQuestChainStore } from './questChainStore';
import { mcpManager } from '../services/mcpClient';

const callTool = mcpManager.gameStateClient.callTool as ReturnType<typeof vi.fn>;

// The engine wraps the JSON payload in markdown + an embedded comment block
// (RichFormatter.embedJson(parsed, 'QUEST_MANAGE')). Shape responses the way the
// live tool actually returns them so the store's extraction path is exercised.
function wrapResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Some markdown\n<!-- QUEST_MANAGE_JSON\n${JSON.stringify(payload)}\nQUEST_MANAGE_JSON -->\n`,
      },
    ],
  };
}

function sampleChainPayload() {
  return {
    success: true,
    actionType: 'get_chain',
    chainId: 'storyline-1',
    characterId: 'char-1',
    chainChoices: {},
    quests: [
      {
        id: 'q-a',
        name: 'The Beginning',
        order: 0,
        status: 'completed',
        unlockState: 'completed',
        prerequisites: [],
        skillRequirements: [],
        nextQuests: ['q-b'],
        branches: [],
      },
      {
        id: 'q-b',
        name: 'The Crossroads',
        order: 1,
        status: 'active',
        unlockState: 'active',
        prerequisites: ['q-a'],
        skillRequirements: [],
        nextQuests: [],
        branches: [
          { choiceId: 'good', label: 'Take the high road', questId: 'q-c' },
          { choiceId: 'evil', label: 'Take the low road', questId: 'q-d' },
        ],
      },
      {
        id: 'q-c',
        name: 'The High Road',
        order: 2,
        status: 'available',
        unlockState: 'locked',
        prerequisites: ['q-b'],
        skillRequirements: [],
        nextQuests: [],
        branches: [],
      },
    ],
  };
}

describe('questChainStore', () => {
  beforeEach(() => {
    useQuestChainStore.setState({
      chainsByCharacter: {},
      chainList: [],
      selectedChainId: null,
      isLoading: false,
      error: null,
      lastResult: null,
    });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('has the expected defaults', () => {
      const s = useQuestChainStore.getState();
      expect(s.chainsByCharacter).toEqual({});
      expect(s.chainList).toEqual([]);
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
    });
  });

  describe('listChains', () => {
    it('calls quest_manage list_chains and populates chainList', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'list_chains',
          count: 1,
          chains: [{ chainId: 'storyline-1', questCount: 3, completedCount: 1 }],
        })
      );

      await useQuestChainStore.getState().listChains();

      expect(callTool).toHaveBeenCalledWith('quest_manage', { action: 'list_chains' });

      const s = useQuestChainStore.getState();
      expect(s.chainList).toEqual([{ chainId: 'storyline-1', questCount: 3, completedCount: 1 }]);
      expect(s.isLoading).toBe(false);
    });

    it('passes worldId when provided', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'list_chains', count: 0, chains: [] })
      );

      await useQuestChainStore.getState().listChains('world-7');

      expect(callTool).toHaveBeenCalledWith('quest_manage', {
        action: 'list_chains',
        worldId: 'world-7',
      });
    });

    it('sets error and does NOT clobber chainList on a success:false payload', async () => {
      useQuestChainStore.setState({
        chainList: [{ chainId: 'storyline-1', questCount: 3, completedCount: 1 }],
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'list_chains' })
      );

      await useQuestChainStore.getState().listChains();

      const s = useQuestChainStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.chainList).toEqual([{ chainId: 'storyline-1', questCount: 3, completedCount: 1 }]);
    });
  });

  describe('loadChain', () => {
    it('calls quest_manage get_chain by chainId and populates chainsByCharacter', async () => {
      callTool.mockResolvedValueOnce(wrapResponse(sampleChainPayload()));

      await useQuestChainStore.getState().loadChain('storyline-1', 'char-1');

      expect(callTool).toHaveBeenCalledWith('quest_manage', {
        action: 'get_chain',
        chainId: 'storyline-1',
        characterId: 'char-1',
      });

      const chains = useQuestChainStore.getState().chainsByCharacter['char-1'];
      expect(chains).toBeDefined();
      expect(chains['storyline-1'].quests).toHaveLength(3);
      expect(chains['storyline-1'].quests[0].unlockState).toBe('completed');
      expect(chains['storyline-1'].quests[1].branches).toHaveLength(2);
    });

    it('resolves chain by questId when the id is not a known chainId', async () => {
      // loadChain accepts either a chainId or a source questId; callers that pass
      // a quest id rely on the engine resolving its chainId. The store sends the
      // raw identifier; we assert it round-trips into chainsByCharacter under the
      // resolved chainId from the payload.
      callTool.mockResolvedValueOnce(wrapResponse(sampleChainPayload()));

      await useQuestChainStore.getState().loadChain('storyline-1', 'char-1');

      const chains = useQuestChainStore.getState().chainsByCharacter['char-1'];
      expect(Object.keys(chains)).toContain('storyline-1');
    });

    it('sets error and does NOT clobber a populated chain map on a null-parse payload', async () => {
      // Seed a previously-populated chain map.
      const seeded = sampleChainPayload();
      useQuestChainStore.setState({
        chainsByCharacter: { 'char-1': { 'storyline-1': seeded as any } },
      });

      // Response text has NO embedded QUEST_MANAGE_JSON block -> extract returns null.
      callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some markdown with no embedded payload at all.' }],
      });

      await useQuestChainStore.getState().loadChain('storyline-1', 'char-1');

      const s = useQuestChainStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      // The previously-populated chain was NOT overwritten.
      expect(s.chainsByCharacter['char-1']['storyline-1'].quests).toHaveLength(3);
    });

    it('sets error and does NOT clobber a populated chain map on a success:false payload', async () => {
      const seeded = sampleChainPayload();
      useQuestChainStore.setState({
        chainsByCharacter: { 'char-1': { 'storyline-1': seeded as any } },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'get_chain', chainId: 'storyline-1' })
      );

      await useQuestChainStore.getState().loadChain('storyline-1', 'char-1');

      const s = useQuestChainStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.chainsByCharacter['char-1']['storyline-1'].quests).toHaveLength(3);
    });

    it('sets error and does NOT clobber on an error-envelope payload', async () => {
      const seeded = sampleChainPayload();
      useQuestChainStore.setState({
        chainsByCharacter: { 'char-1': { 'storyline-1': seeded as any } },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ error: true, message: 'No chain found for storyline-1' })
      );

      await useQuestChainStore.getState().loadChain('storyline-1', 'char-1');

      const s = useQuestChainStore.getState();
      expect(s.error).toBe('No chain found for storyline-1');
      expect(s.chainsByCharacter['char-1']['storyline-1'].quests).toHaveLength(3);
    });
  });

  describe('selectBranch', () => {
    it('calls quest_manage select_branch with the SOURCE questId, choiceId and characterId', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'select_branch',
          characterId: 'char-1',
          questId: 'q-b',
          chainId: 'storyline-1',
          choiceId: 'good',
          chosenQuestId: 'q-c',
          message: 'Chose "Take the high road" — unlocked "The High Road"',
        })
      );

      await useQuestChainStore.getState().selectBranch('q-b', 'good', 'char-1');

      // The engine keys the choice on the SOURCE (branching) quest, NOT chainId.
      expect(callTool).toHaveBeenCalledWith('quest_manage', {
        action: 'select_branch',
        characterId: 'char-1',
        questId: 'q-b',
        choiceId: 'good',
      });

      expect(useQuestChainStore.getState().lastResult?.chosenQuestId).toBe('q-c');
    });

    it('sets error and does NOT clobber chain data on a success:false payload', async () => {
      const seeded = sampleChainPayload();
      useQuestChainStore.setState({
        chainsByCharacter: { 'char-1': { 'storyline-1': seeded as any } },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ error: true, message: 'Branch already chosen' })
      );

      await useQuestChainStore.getState().selectBranch('q-b', 'evil', 'char-1');

      const s = useQuestChainStore.getState();
      expect(s.error).toBe('Branch already chosen');
      expect(s.isLoading).toBe(false);
      expect(s.chainsByCharacter['char-1']['storyline-1'].quests).toHaveLength(3);
      expect(s.lastResult).toBeNull();
    });
  });

  describe('error handling (callTool rejects, not returns)', () => {
    it('loadChain catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce({ code: -32603, message: 'JSON-RPC error: boom' });

      await expect(
        useQuestChainStore.getState().loadChain('storyline-1', 'char-1')
      ).resolves.toBeUndefined();

      const s = useQuestChainStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
    });

    it('listChains catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      await expect(useQuestChainStore.getState().listChains()).resolves.toBeUndefined();

      expect(useQuestChainStore.getState().error).toBeTruthy();
      expect(useQuestChainStore.getState().isLoading).toBe(false);
    });

    it('selectBranch catches a rejection and returns null without throwing', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      // selectBranch resolves to the payload (or null on failure) — it must
      // never throw the rejection into a React handler.
      await expect(
        useQuestChainStore.getState().selectBranch('q-b', 'good', 'char-1')
      ).resolves.toBeNull();

      expect(useQuestChainStore.getState().error).toBeTruthy();
      expect(useQuestChainStore.getState().isLoading).toBe(false);
    });
  });

  describe('persist partialize', () => {
    it('persists only selectedChainId, never the server-derived chain data', () => {
      const persistApi = (useQuestChainStore as unknown as {
        persist: { getOptions: () => { partialize?: (s: any) => any } };
      }).persist;
      const partialize = persistApi.getOptions().partialize;
      expect(partialize).toBeTypeOf('function');

      const partial = partialize!({
        chainsByCharacter: { 'char-1': { 'storyline-1': sampleChainPayload() } },
        chainList: [{ chainId: 'storyline-1', questCount: 3, completedCount: 1 }],
        selectedChainId: 'storyline-1',
        isLoading: true,
        error: 'x',
        lastResult: { actionType: 'get_chain' },
      });

      expect(partial).not.toHaveProperty('chainsByCharacter');
      expect(partial).not.toHaveProperty('chainList');
      expect(partial).not.toHaveProperty('lastResult');
      expect(partial).not.toHaveProperty('isLoading');
      expect(partial.selectedChainId).toBe('storyline-1');
    });
  });
});
