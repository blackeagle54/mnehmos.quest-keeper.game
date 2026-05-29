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
      pending: 0,
      requestVersionByCharacter: {},
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

    it('does NOT clobber state when a revoke payload omits the revoked field (malformed)', async () => {
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

      // Malformed: achievementId present but no boolean `revoked`. Sibling mutators
      // (unlock/progress) are pessimistic (=== true); revoke must be too, so a
      // missing field is rejected by the shape guard rather than optimistically
      // marking the achievement revoked.
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'revoke',
          characterId: 'char-1',
          achievementId: 'first-blood',
        })
      );

      await useAchievementStore.getState().revoke('char-1', 'first-blood');

      // Rejected at the guard → no follow-up reconcile sync (list/get) fired.
      expect(callTool).toHaveBeenCalledTimes(1);
      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      const fb = entry.catalog.find((a) => a.id === 'first-blood');
      // State left intact: still unlocked, counts unchanged, error surfaced.
      expect(fb?.unlocked).toBe(true);
      expect(entry.unlockedCount).toBe(1);
      expect(entry.totalPoints).toBe(10);
      expect(useAchievementStore.getState().error).toBeTruthy();
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

  // ---------------------------------------------------------------------------
  // Finding 4: in-flight pending counter (isLoading derived), not a shared bool.
  // ---------------------------------------------------------------------------
  describe('in-flight counter (isLoading derived from pending)', () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    it('keeps isLoading true until BOTH overlapping calls resolve', async () => {
      // Two overlapping unlocks for DIFFERENT, locally-present, locked
      // achievements take the fast-patch path (no reconcile sync). A naive
      // per-action `isLoading=false` in finally would flip it false after the
      // FIRST resolves while the SECOND is still pending — the counter must keep
      // it true until BOTH settle.
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: [
              { id: 'a-1', name: 'A1', description: '', category: 'combat', points: 5, unlocked: false },
              { id: 'a-2', name: 'A2', description: '', category: 'combat', points: 5, unlocked: false },
            ],
            totalCount: 2,
            unlockedCount: 0,
            totalPoints: 0,
            characterName: 'Aria',
          } as any,
        },
      });

      const first = deferred<unknown>();
      const second = deferred<unknown>();
      callTool.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const p1 = useAchievementStore.getState().unlock('char-1', 'a-1');
      const p2 = useAchievementStore.getState().unlock('char-1', 'a-2');

      expect(useAchievementStore.getState().pending).toBe(2);
      expect(useAchievementStore.getState().isLoading).toBe(true);

      first.resolve(
        wrapResponse({ success: true, actionType: 'unlock', characterId: 'char-1', achievementId: 'a-1', points: 5 })
      );
      await p1;

      // One still pending — isLoading must remain true.
      expect(useAchievementStore.getState().pending).toBe(1);
      expect(useAchievementStore.getState().isLoading).toBe(true);

      second.resolve(
        wrapResponse({ success: true, actionType: 'unlock', characterId: 'char-1', achievementId: 'a-2', points: 5 })
      );
      await p2;

      expect(useAchievementStore.getState().pending).toBe(0);
      expect(useAchievementStore.getState().isLoading).toBe(false);
    });

    it('never drives pending below zero', async () => {
      callTool.mockResolvedValue(
        wrapResponse({ success: true, actionType: 'list', achievements: sampleCatalog() })
      );
      await useAchievementStore.getState().syncAchievements('char-1');
      expect(useAchievementStore.getState().pending).toBe(0);
      expect(useAchievementStore.getState().isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Finding 5: payload guard must validate actionType, not just trust an
  // envelope. A wrong-action / partial payload must be treated as a failure and
  // must NOT clobber populated state.
  // ---------------------------------------------------------------------------
  describe('actionType payload validation (success:true but wrong shape)', () => {
    function seedPopulated() {
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
    }

    it('treats a list call that returns a get-shaped payload as a failure and does NOT wipe the catalog', async () => {
      seedPopulated();
      // success:true but actionType is 'get' (wrong) and there is no achievements
      // array — defaulting to [] would clobber the populated catalog.
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'get',
          characterId: 'char-1',
          totalCount: 2,
          unlockedCount: 1,
          totalPoints: 10,
        })
      );

      await useAchievementStore.getState().syncAchievements('char-1');

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.achievementsByCharacter['char-1'].catalog).toHaveLength(2);
    });

    it('treats a list call with a success:true payload that lacks the achievements array as a failure', async () => {
      seedPopulated();
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'list', characterId: 'char-1' })
      );

      await useAchievementStore.getState().syncAchievements('char-1');

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.achievementsByCharacter['char-1'].catalog).toHaveLength(2);
    });

    it('treats an unlock call that returns a progress-shaped payload as a failure (no state mutation)', async () => {
      seedPopulated();
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'progress',
          characterId: 'char-1',
          achievementId: 'collector',
        })
      );

      await useAchievementStore.getState().unlock('char-1', 'collector');

      const s = useAchievementStore.getState();
      expect(s.error).toBeTruthy();
      const collector = s.achievementsByCharacter['char-1'].catalog.find((a) => a.id === 'collector');
      expect(collector?.unlocked).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Finding 6: stale sync completions must not overwrite fresher state.
  // ---------------------------------------------------------------------------
  describe('stale sync completion (per-character request version)', () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    // Flush microtasks + a macrotask so a parked async action gets PAST its
    // lazy `import('../services/mcpClient')` before the next one is fired. Two
    // dynamic imports racing in the same tick can intermittently resolve to the
    // un-mocked module under vitest, so we serialize past the import boundary.
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('drops an older sync that resolves AFTER a newer sync (newer state wins)', async () => {
      // Sync A (older) is parked at its `list` await. Sync B (newer) then runs to
      // completion, writing fresh state (unlocked:true / unlockedCount:1). Only
      // afterwards does A's `list` resolve with STALE data (unlocked:false). A's
      // terminal write must be DROPPED because the per-character request version
      // moved on — the newer state has to win.
      const aList = deferred<unknown>();
      callTool.mockReturnValueOnce(aList.promise); // A.list — held open

      const pA = useAchievementStore.getState().syncAchievements('char-1'); // older
      await flush(); // A passes its import and parks at the list await

      // Now queue B's responses and fire it; A's import already resolved so B's
      // does not race it.
      callTool
        .mockResolvedValueOnce(
          wrapResponse({
            success: true,
            actionType: 'list',
            achievements: [
              { id: 'first-blood', name: 'First Blood', description: '', category: 'combat', points: 10, unlocked: true },
            ],
          })
        ) // B.list — fresh
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', totalCount: 1, unlockedCount: 1, totalPoints: 10 })
        ) // B.get — fresh
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', totalCount: 1, unlockedCount: 0, totalPoints: 0 })
        ); // A.get — stale (consumed after A.list resolves)

      const pB = useAchievementStore.getState().syncAchievements('char-1'); // newer
      await pB;
      await flush();

      // Sanity: the newer sync has landed.
      let entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      expect(entry.catalog[0].unlocked).toBe(true);
      expect(entry.unlockedCount).toBe(1);

      // Release the OLDER sync's list with stale (locked) data; it then fetches
      // its get and reaches its terminal write — which must be dropped.
      aList.resolve(
        wrapResponse({
          success: true,
          actionType: 'list',
          achievements: [
            { id: 'first-blood', name: 'First Blood', description: '', category: 'combat', points: 10, unlocked: false },
          ],
        })
      );
      await pA;

      // The newer state must still win — the stale older completion was dropped.
      entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      expect(entry.catalog[0].unlocked).toBe(true);
      expect(entry.unlockedCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Finding 7: mutations reconcile to engine truth on edge cases.
  // ---------------------------------------------------------------------------
  describe('reconcile to engine truth (mutations)', () => {
    function seedPopulated() {
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
    }

    it('unlock of an achievement absent from the local cache triggers a reconcile sync', async () => {
      seedPopulated();
      // 1) unlock response (achievement not in local catalog)
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'unlock',
          characterId: 'char-1',
          achievementId: 'ghost', // not in sampleCatalog
          points: 5,
          alreadyUnlocked: false,
        })
      );
      // 2) reconcile: list then get
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'list',
          achievements: [
            ...sampleCatalog(),
            { id: 'ghost', name: 'Ghost', description: '', category: 'meta', points: 5, unlocked: true },
          ],
        })
      );
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', totalCount: 3, unlockedCount: 2, totalPoints: 15 })
      );

      await useAchievementStore.getState().unlock('char-1', 'ghost');

      // A reconcile sync ran: list + get were called after the unlock.
      const listCalls = callTool.mock.calls.filter(
        (c) => c[0] === 'achievement_manage' && (c[1] as any).action === 'list'
      );
      expect(listCalls.length).toBe(1);
      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      expect(entry.catalog.find((a) => a.id === 'ghost')?.unlocked).toBe(true);
      expect(entry.unlockedCount).toBe(2);
    });

    it('unlock that returns alreadyUnlocked:true for a locally-locked entry reconciles via sync', async () => {
      seedPopulated();
      // collector is locally locked, but the engine says it was ALREADY unlocked
      // -> local state is stale, reconcile instead of a fast-path patch.
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'unlock',
          characterId: 'char-1',
          achievementId: 'collector',
          points: 25,
          alreadyUnlocked: true,
        })
      );
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'list',
          achievements: sampleCatalog().map((a) =>
            a.id === 'collector' ? { ...a, unlocked: true } : a
          ),
        })
      );
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', totalCount: 2, unlockedCount: 2, totalPoints: 35 })
      );

      await useAchievementStore.getState().unlock('char-1', 'collector');

      const listCalls = callTool.mock.calls.filter(
        (c) => c[0] === 'achievement_manage' && (c[1] as any).action === 'list'
      );
      expect(listCalls.length).toBe(1);
      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      expect(entry.catalog.find((a) => a.id === 'collector')?.unlocked).toBe(true);
      expect(entry.unlockedCount).toBe(2);
    });

    it('revoke that returns revoked:false reconciles via sync instead of patching', async () => {
      seedPopulated();
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'revoke',
          characterId: 'char-1',
          achievementId: 'first-blood',
          revoked: false,
        })
      );
      // reconcile list + get (engine still has it unlocked)
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'list', achievements: sampleCatalog() })
      );
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', totalCount: 2, unlockedCount: 1, totalPoints: 10 })
      );

      await useAchievementStore.getState().revoke('char-1', 'first-blood');

      const listCalls = callTool.mock.calls.filter(
        (c) => c[0] === 'achievement_manage' && (c[1] as any).action === 'list'
      );
      expect(listCalls.length).toBe(1);
      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      // Engine still reports first-blood unlocked -> local state matches engine.
      expect(entry.catalog.find((a) => a.id === 'first-blood')?.unlocked).toBe(true);
      expect(entry.unlockedCount).toBe(1);
    });

    it('progress reporting justUnlocked:true on an already-unlocked local entry reconciles via sync', async () => {
      // Seed with collector ALREADY unlocked locally.
      useAchievementStore.setState({
        achievementsByCharacter: {
          'char-1': {
            catalog: sampleCatalog().map((a) =>
              a.id === 'collector' ? { ...a, unlocked: true, progress: 100 } : a
            ),
            totalCount: 2,
            unlockedCount: 2,
            totalPoints: 35,
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
          progress: 100,
          target: 100,
          unlocked: true,
          justUnlocked: true, // conflicts with the local already-unlocked entry
        })
      );
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'list',
          achievements: sampleCatalog().map((a) =>
            a.id === 'collector' ? { ...a, unlocked: true, progress: 100 } : a
          ),
        })
      );
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', totalCount: 2, unlockedCount: 2, totalPoints: 35 })
      );

      await useAchievementStore.getState().progress('char-1', 'collector');

      const listCalls = callTool.mock.calls.filter(
        (c) => c[0] === 'achievement_manage' && (c[1] as any).action === 'list'
      );
      expect(listCalls.length).toBe(1);
      const entry = useAchievementStore.getState().achievementsByCharacter['char-1'];
      // Must NOT double-count: still 2 unlocked / 35 points after reconcile.
      expect(entry.unlockedCount).toBe(2);
      expect(entry.totalPoints).toBe(35);
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
