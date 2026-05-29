/**
 * Tests for achievementStore.ts
 *
 * Zustand persist store for the Achievements system. Talks to the engine via the
 * single mcpManager bridge (achievement_manage tool). Mock the bridge BEFORE
 * importing the store so the lazy `import('../services/mcpClient')` resolves to
 * the mock. Mirrors skillStore.test.ts coverage exactly:
 *   - sync populates the catalog + totals
 *   - success:false / unparseable payloads set error and DO NOT clobber state
 *   - callTool rejections are caught (never thrown into a React render)
 *   - unlock/progress update state from the response payload
 *   - persist partialize keeps ONLY ui prefs, never server-derived data
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

import { useAchievementStore } from './achievementStore';
import { mcpManager } from '../services/mcpClient';

const callTool = mcpManager.gameStateClient.callTool as ReturnType<typeof vi.fn>;

// The engine wraps the JSON payload in markdown + an embedded comment block
// (RichFormatter.embedJson(parsed, 'ACHIEVEMENT_MANAGE') -> token
// 'ACHIEVEMENT_MANAGE_JSON'). Shape responses the way the live tool returns
// them so the store's extraction path is exercised.
function wrapResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Some markdown\n<!-- ACHIEVEMENT_MANAGE_JSON\n${JSON.stringify(payload)}\nACHIEVEMENT_MANAGE_JSON -->\n`,
      },
    ],
  };
}

function sampleCatalog() {
  return [
    {
      id: 'first-blood',
      name: 'First Blood',
      description: 'Win your first battle.',
      category: 'combat',
      points: 10,
      hidden: false,
      unlocked: true,
      unlockedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'collector',
      name: 'Collector',
      description: 'Gather 100 items.',
      category: 'exploration',
      points: 25,
      target: 100,
      progress: 40,
      hidden: false,
      unlocked: false,
    },
  ];
}

function sampleSummary() {
  return {
    success: true,
    actionType: 'get',
    characterId: 'char-1',
    characterName: 'Aria',
    unlocked: [{ id: 'first-blood', name: 'First Blood', points: 10, unlockedAt: '2026-01-01T00:00:00.000Z' }],
    inProgress: [{ id: 'collector', name: 'Collector', progress: 40, target: 100 }],
    totalPoints: 10,
    unlockedCount: 1,
    totalCount: 2,
  };
}

describe('achievementStore', () => {
  beforeEach(() => {
    useAchievementStore.setState({
      achievementsByCharacter: {},
      selectedCategory: null,
      isLoading: false,
      error: null,
      lastResult: null,
    });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('has the expected defaults', () => {
      const s = useAchievementStore.getState();
      expect(s.achievementsByCharacter).toEqual({});
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
    });
  });

  describe('syncAchievements', () => {
    it('calls achievement_manage list (with characterId) then get, and populates the catalog + totals', async () => {
      callTool
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'list', achievements: sampleCatalog() })
        )
        .mockResolvedValueOnce(wrapResponse(sampleSummary()));

      await useAchievementStore.getState().syncAchievements('char-1');

      expect(callTool).toHaveBeenNthCalledWith(1, 'achievement_manage', {
        action: 'list',
        characterId: 'char-1',
      });
      expect(callTool).toHaveBeenNthCalledWith(2, 'achievement_manage', {
        action: 'get',
        characterId: 'char-1',
      });

      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      expect(entry).toBeDefined();
      expect(entry.catalog).toHaveLength(2);
      expect(entry.catalog[0].id).toBe('first-blood');
      expect(entry.catalog[0].unlocked).toBe(true);
      expect(entry.totalCount).toBe(2);
      expect(entry.unlockedCount).toBe(1);
      expect(entry.totalPoints).toBe(10);
      expect(entry.characterName).toBe('Aria');
      expect(useAchievementStore.getState().isLoading).toBe(false);
    });

    it('still populates the catalog when the get summary call fails (list is the source of truth)', async () => {
      callTool
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'list', achievements: sampleCatalog() })
        )
        .mockResolvedValueOnce(wrapResponse({ success: false, actionType: 'get', characterId: 'char-1' }));

      await useAchievementStore.getState().syncAchievements('char-1');

      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      expect(entry.catalog).toHaveLength(2);
      // Totals derived from the catalog as a fallback when get fails.
      expect(entry.totalCount).toBe(2);
      expect(entry.unlockedCount).toBe(1);
    });

    it('sets error and does NOT clobber a populated catalog when the list payload has no embedded block', async () => {
      const seeded = {
        catalog: sampleCatalog(),
        totalCount: 2,
        unlockedCount: 1,
        totalPoints: 10,
        characterName: 'Aria',
      };
      useAchievementStore.setState({ achievementsByCharacter: { 'char-1': seeded as any } });

      callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some markdown with no embedded payload at all.' }],
      });

      await useAchievementStore.getState().syncAchievements('char-1');

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      // The previously-populated catalog was NOT overwritten/cleared.
      expect(s.achievementsByCharacter['char-1'].catalog).toHaveLength(2);
    });

    it('sets error and does NOT clobber a populated catalog when the list payload is success:false', async () => {
      const seeded = {
        catalog: sampleCatalog(),
        totalCount: 2,
        unlockedCount: 1,
        totalPoints: 10,
        characterName: 'Aria',
      };
      useAchievementStore.setState({ achievementsByCharacter: { 'char-1': seeded as any } });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'list', characterId: 'char-1' })
      );

      await useAchievementStore.getState().syncAchievements('char-1');

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.achievementsByCharacter['char-1'].catalog).toHaveLength(2);
    });
  });

  describe('unlock', () => {
    it('calls achievement_manage unlock and marks the catalog entry unlocked from the response', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'unlock',
          characterId: 'char-1',
          achievementId: 'collector',
          name: 'Collector',
          points: 25,
          unlockedAt: '2026-02-02T00:00:00.000Z',
          alreadyUnlocked: false,
        })
      );

      await useAchievementStore.getState().unlock('char-1', 'collector');

      expect(callTool).toHaveBeenCalledWith('achievement_manage', {
        action: 'unlock',
        characterId: 'char-1',
        achievementId: 'collector',
      });

      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      const collector = entry.catalog.find((a) => a.id === 'collector');
      expect(collector?.unlocked).toBe(true);
      expect(collector?.unlockedAt).toBe('2026-02-02T00:00:00.000Z');
      expect(entry.unlockedCount).toBe(2);
      expect(entry.totalPoints).toBe(35);
      expect(useAchievementStore.getState().lastResult?.actionType).toBe('unlock');
    });

    it('does NOT double-count points when alreadyUnlocked is true', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'unlock',
          characterId: 'char-1',
          achievementId: 'first-blood',
          name: 'First Blood',
          points: 10,
          unlockedAt: '2026-01-01T00:00:00.000Z',
          alreadyUnlocked: true,
        })
      );

      await useAchievementStore.getState().unlock('char-1', 'first-blood');

      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      expect(entry.unlockedCount).toBe(1);
      expect(entry.totalPoints).toBe(10);
    });

    it('sets error and does NOT corrupt state on a success:false payload', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'unlock', characterId: 'char-1', achievementId: 'collector' })
      );

      await useAchievementStore.getState().unlock('char-1', 'collector');

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      const collector = s.achievementsByCharacter['char-1'].catalog.find((a) => a.id === 'collector');
      expect(collector?.unlocked).toBe(false);
      expect(s.lastResult).toBeNull();
    });

    it('sets error and does NOT corrupt state on an unparseable payload', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'No embedded payload here.' }] });

      await useAchievementStore.getState().unlock('char-1', 'collector');

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      const collector = s.achievementsByCharacter['char-1'].catalog.find((a) => a.id === 'collector');
      expect(collector?.unlocked).toBe(false);
      expect(s.lastResult).toBeNull();
    });
  });

  describe('progress', () => {
    it('calls achievement_manage progress and updates the catalog entry progress from the response', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'progress',
          characterId: 'char-1',
          achievementId: 'collector',
          name: 'Collector',
          progress: 70,
          target: 100,
          unlocked: false,
          justUnlocked: false,
        })
      );

      await useAchievementStore.getState().progress('char-1', 'collector', 30);

      expect(callTool).toHaveBeenCalledWith('achievement_manage', {
        action: 'progress',
        characterId: 'char-1',
        achievementId: 'collector',
        amount: 30,
      });

      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      const collector = entry.catalog.find((a) => a.id === 'collector');
      expect(collector?.progress).toBe(70);
      expect(collector?.unlocked).toBe(false);
    });

    it('marks the entry unlocked and bumps totals when progress justUnlocked it', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'progress',
          characterId: 'char-1',
          achievementId: 'collector',
          name: 'Collector',
          progress: 100,
          target: 100,
          unlocked: true,
          justUnlocked: true,
        })
      );

      await useAchievementStore.getState().progress('char-1', 'collector');

      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      const collector = entry.catalog.find((a) => a.id === 'collector');
      expect(collector?.unlocked).toBe(true);
      expect(collector?.progress).toBe(100);
      expect(entry.unlockedCount).toBe(2);
      expect(entry.totalPoints).toBe(35);
    });

    it('sets error and does NOT corrupt state on a success:false payload', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'progress', characterId: 'char-1', achievementId: 'collector' })
      );

      await useAchievementStore.getState().progress('char-1', 'collector', 10);

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      const collector = s.achievementsByCharacter['char-1'].catalog.find((a) => a.id === 'collector');
      expect(collector?.progress).toBe(40);
      expect(s.lastResult).toBeNull();
    });
  });

  describe('revoke', () => {
    it('calls achievement_manage revoke and clears the unlocked state from the catalog', async () => {
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog(),
            totalCount: 2,
            unlockedCount: 1,
            totalPoints: 10,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'revoke',
          characterId: 'char-1',
          achievementId: 'first-blood',
          revoked: true,
        })
      );

      await useAchievementStore.getState().revoke('char-1', 'first-blood');

      expect(callTool).toHaveBeenCalledWith('achievement_manage', {
        action: 'revoke',
        characterId: 'char-1',
        achievementId: 'first-blood',
      });

      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      const fb = entry.catalog.find((a) => a.id === 'first-blood');
      expect(fb?.unlocked).toBe(false);
      expect(entry.unlockedCount).toBe(0);
      expect(entry.totalPoints).toBe(0);
    });
  });

  describe('define', () => {
    it('calls achievement_manage define with the right args', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'define',
          achievement: {
            id: 'speedrun',
            name: 'Speedrun',
            description: 'Finish fast.',
            category: 'meta',
            points: 50,
            hidden: false,
          },
        })
      );

      await useAchievementStore.getState().define({
        achievementId: 'speedrun',
        name: 'Speedrun',
        description: 'Finish fast.',
        category: 'meta',
        points: 50,
      });

      expect(callTool).toHaveBeenCalledWith('achievement_manage', {
        action: 'define',
        achievementId: 'speedrun',
        name: 'Speedrun',
        description: 'Finish fast.',
        category: 'meta',
        points: 50,
      });
      expect(useAchievementStore.getState().lastResult?.actionType).toBe('define');
    });

    it('sets error on a success:false define payload', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'define' })
      );

      await useAchievementStore.getState().define({
        achievementId: 'dup',
        name: 'Dup',
        description: 'x',
        category: 'meta',
      });

      expect(useAchievementStore.getState().error).toBeTruthy();
      expect(useAchievementStore.getState().lastResult).toBeNull();
    });
  });

  describe('error handling (callTool rejects, not returns)', () => {
    it('syncAchievements catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce({ code: -32603, message: 'JSON-RPC error: boom' });

      await expect(useAchievementStore.getState().syncAchievements('char-1')).resolves.toBeUndefined();

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
    });

    it('unlock catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      await expect(
        useAchievementStore.getState().unlock('char-1', 'collector')
      ).resolves.toBeUndefined();

      expect(useAchievementStore.getState().error).toBeTruthy();
      expect(useAchievementStore.getState().isLoading).toBe(false);
    });

    it('progress catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      await expect(
        useAchievementStore.getState().progress('char-1', 'collector', 5)
      ).resolves.toBeUndefined();

      expect(useAchievementStore.getState().error).toBeTruthy();
      expect(useAchievementStore.getState().isLoading).toBe(false);
    });
  });

  describe('persist partialize', () => {
    it('persists only ui prefs, never the server-derived achievements data', () => {
      const persistApi = (useAchievementStore as unknown as {
        persist: { getOptions: () => { partialize?: (s: any) => any } };
      }).persist;
      const partialize = persistApi.getOptions().partialize;
      expect(partialize).toBeTypeOf('function');

      const partial = partialize!({
        achievementsByCharacter: { 'char-1': { catalog: sampleCatalog() } },
        selectedCategory: 'combat',
        isLoading: true,
        error: 'x',
        lastResult: { actionType: 'unlock' },
      });

      expect(partial).not.toHaveProperty('achievementsByCharacter');
      expect(partial).not.toHaveProperty('lastResult');
      expect(partial).not.toHaveProperty('isLoading');
      expect(partial.selectedCategory).toBe('combat');
    });
  });
});
