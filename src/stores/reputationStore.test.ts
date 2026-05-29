/**
 * Tests for reputationStore.ts
 *
 * Zustand persist store for the Reputation/Factions system. Talks to the engine
 * via the single mcpManager bridge (reputation_manage tool). Mock the bridge
 * BEFORE importing the store so the lazy `import('../services/mcpClient')`
 * resolves to the mock. Mirrors achievementStore.test.ts coverage exactly:
 *   - sync populates the faction list + counts
 *   - success:false / unparseable payloads set error and DO NOT clobber state
 *   - callTool rejections are caught (never thrown into a React render)
 *   - adjust/set update state from the response payload
 *   - wrong-actionType payloads are treated as failures (no clobber)
 *   - overlapping calls keep isLoading true until ALL settle
 *   - a stale sync completion is dropped (per-character request version)
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

import { useReputationStore, standingFromValue } from './reputationStore';
import { mcpManager } from '../services/mcpClient';

const callTool = mcpManager.gameStateClient.callTool as ReturnType<typeof vi.fn>;

// The engine wraps the JSON payload in markdown + an embedded comment block
// (RichFormatter.embedJson(parsed, 'REPUTATION_MANAGE') -> token
// 'REPUTATION_MANAGE_JSON'). Shape responses the way the live tool returns them
// so the store's extraction path is exercised.
function wrapResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Some markdown\n<!-- REPUTATION_MANAGE_JSON\n${JSON.stringify(payload)}\nREPUTATION_MANAGE_JSON -->\n`,
      },
    ],
  };
}

// list_factions (with characterId) is the catalog source of truth — each entry
// is annotated with the character's value/standing.
function sampleFactions() {
  return [
    {
      id: 'merchants-guild',
      name: 'Merchants Guild',
      description: 'Coin runs the city.',
      value: 350,
      standing: 'Honored',
    },
    {
      id: 'thieves-den',
      name: "Thieves' Den",
      description: 'Shadows and knives.',
      value: -200,
      standing: 'Hostile',
    },
  ];
}

function sampleGet() {
  return {
    success: true,
    actionType: 'get',
    characterId: 'char-1',
    characterName: 'Aria',
    reputations: [
      { id: 'merchants-guild', name: 'Merchants Guild', value: 350, standing: 'Honored' },
      { id: 'thieves-den', name: "Thieves' Den", value: -200, standing: 'Hostile' },
    ],
    factionCount: 2,
  };
}

describe('reputationStore', () => {
  beforeEach(() => {
    useReputationStore.setState({
      reputationByCharacter: {},
      selectedFaction: null,
      pending: 0,
      requestVersionByCharacter: {},
      isLoading: false,
      error: null,
      lastResult: null,
    });
    // mockReset (not clearAllMocks) so a prior test's mockResolvedValue
    // implementation can't leak into the next test — clearAllMocks only wipes
    // call history, leaving implementations intact.
    callTool.mockReset();
  });

  // ---------------------------------------------------------------------------
  // standingFromValue: the FROZEN tier ladder (clamped [-1000, 1000]).
  // ---------------------------------------------------------------------------
  describe('standingFromValue', () => {
    it('maps values to the frozen standing tiers', () => {
      expect(standingFromValue(1000)).toBe('Exalted');
      expect(standingFromValue(1500)).toBe('Exalted'); // clamped above 1000
      expect(standingFromValue(600)).toBe('Revered');
      expect(standingFromValue(300)).toBe('Honored');
      expect(standingFromValue(100)).toBe('Friendly');
      expect(standingFromValue(0)).toBe('Neutral');
      expect(standingFromValue(99)).toBe('Neutral');
      // Boundary check: -100 satisfies `>= -100` -> Unfriendly (per FROZEN tiers).
      expect(standingFromValue(-1)).toBe('Unfriendly');
      expect(standingFromValue(-100)).toBe('Unfriendly');
      expect(standingFromValue(-101)).toBe('Hostile');
      expect(standingFromValue(-500)).toBe('Hostile');
      expect(standingFromValue(-501)).toBe('Hated');
      expect(standingFromValue(-2000)).toBe('Hated'); // clamped below -1000
    });
  });

  describe('initial state', () => {
    it('has the expected defaults', () => {
      const s = useReputationStore.getState();
      expect(s.reputationByCharacter).toEqual({});
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
    });
  });

  describe('syncReputation', () => {
    it('calls reputation_manage list_factions (with characterId) then get, and populates the factions + count', async () => {
      callTool
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'list_factions', factions: sampleFactions() })
        )
        .mockResolvedValueOnce(wrapResponse(sampleGet()));

      await useReputationStore.getState().syncReputation('char-1');

      expect(callTool).toHaveBeenNthCalledWith(1, 'reputation_manage', {
        action: 'list_factions',
        characterId: 'char-1',
      });
      expect(callTool).toHaveBeenNthCalledWith(2, 'reputation_manage', {
        action: 'get',
        characterId: 'char-1',
      });

      const entry = useReputationStore.getState().reputationByCharacter['char-1'];
      expect(entry).toBeDefined();
      expect(entry.factions).toHaveLength(2);
      expect(entry.factions[0].id).toBe('merchants-guild');
      expect(entry.factions[0].value).toBe(350);
      expect(entry.factions[0].standing).toBe('Honored');
      expect(entry.factionCount).toBe(2);
      expect(entry.characterName).toBe('Aria');
      expect(useReputationStore.getState().isLoading).toBe(false);
    });

    it('still populates the factions when the get call fails (list_factions is the source of truth)', async () => {
      callTool
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'list_factions', factions: sampleFactions() })
        )
        .mockResolvedValueOnce(
          wrapResponse({
            success: false,
            actionType: 'get',
            characterId: 'char-1',
            // These fields must NOT be applied from a failed payload.
            factionCount: 999,
            characterName: 'SHOULD_NOT_APPLY',
          })
        );

      await useReputationStore.getState().syncReputation('char-1');

      const entry = useReputationStore.getState().reputationByCharacter['char-1'];
      expect(entry.factions).toHaveLength(2);
      // factionCount derived from the list as a fallback when get fails — NOT the
      // failed payload's 999.
      expect(entry.factionCount).toBe(2);
      // A failed get must not partially apply its fields.
      expect(entry.characterName).toBeUndefined();
    });

    it('defaults a faction with no per-character entry to Neutral / 0', async () => {
      callTool
        .mockResolvedValueOnce(
          wrapResponse({
            success: true,
            actionType: 'list_factions',
            // No value/standing annotation -> untracked faction.
            factions: [{ id: 'untracked', name: 'Untracked Order', description: 'Unknown to you.' }],
          })
        )
        .mockResolvedValueOnce(wrapResponse({ success: false, actionType: 'get' }));

      await useReputationStore.getState().syncReputation('char-1');

      const entry = useReputationStore.getState().reputationByCharacter['char-1'];
      const f = entry.factions.find((x) => x.id === 'untracked');
      expect(f?.value).toBe(0);
      expect(f?.standing).toBe('Neutral');
    });

    it('sets error and does NOT clobber populated factions when the list payload has no embedded block', async () => {
      const seeded = {
        factions: sampleFactions(),
        factionCount: 2,
        characterName: 'Aria',
      };
      useReputationStore.setState({ reputationByCharacter: { 'char-1': seeded as any } });

      callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some markdown with no embedded payload at all.' }],
      });

      await useReputationStore.getState().syncReputation('char-1');

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.reputationByCharacter['char-1'].factions).toHaveLength(2);
    });

    it('sets error and does NOT clobber populated factions when the list payload is success:false', async () => {
      const seeded = {
        factions: sampleFactions(),
        factionCount: 2,
        characterName: 'Aria',
      };
      useReputationStore.setState({ reputationByCharacter: { 'char-1': seeded as any } });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'list_factions', characterId: 'char-1' })
      );

      await useReputationStore.getState().syncReputation('char-1');

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.reputationByCharacter['char-1'].factions).toHaveLength(2);
    });
  });

  describe('adjust', () => {
    it('calls reputation_manage adjust and patches the faction value/standing from the response', async () => {
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: sampleFactions(),
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'adjust',
          characterId: 'char-1',
          factionId: 'merchants-guild',
          name: 'Merchants Guild',
          oldValue: 350,
          newValue: 650,
          oldStanding: 'Honored',
          newStanding: 'Revered',
          standingChanged: true,
        })
      );

      await useReputationStore.getState().adjust('char-1', 'merchants-guild', 300);

      expect(callTool).toHaveBeenCalledWith('reputation_manage', {
        action: 'adjust',
        characterId: 'char-1',
        factionId: 'merchants-guild',
        amount: 300,
      });

      const entry = useReputationStore.getState().reputationByCharacter['char-1'];
      const f = entry.factions.find((x) => x.id === 'merchants-guild');
      expect(f?.value).toBe(650);
      expect(f?.standing).toBe('Revered');
      expect(useReputationStore.getState().lastResult?.actionType).toBe('adjust');
    });

    it('sets error and does NOT corrupt state on a success:false payload', async () => {
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: sampleFactions(),
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'adjust', characterId: 'char-1', factionId: 'merchants-guild' })
      );

      await useReputationStore.getState().adjust('char-1', 'merchants-guild', 50);

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      const f = s.reputationByCharacter['char-1'].factions.find((x) => x.id === 'merchants-guild');
      expect(f?.value).toBe(350);
      expect(s.lastResult).toBeNull();
    });

    it('sets error and does NOT corrupt state on an unparseable payload', async () => {
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: sampleFactions(),
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'No embedded payload here.' }] });

      await useReputationStore.getState().adjust('char-1', 'merchants-guild', 50);

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      const f = s.reputationByCharacter['char-1'].factions.find((x) => x.id === 'merchants-guild');
      expect(f?.value).toBe(350);
      expect(s.lastResult).toBeNull();
    });

    it('reconciles via a full sync when adjusting a faction absent from the local cache', async () => {
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: sampleFactions(),
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });

      // 1) adjust response for a faction not in the local cache
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'adjust',
          characterId: 'char-1',
          factionId: 'ghost-faction',
          name: 'Ghost Faction',
          oldValue: 0,
          newValue: 120,
          oldStanding: 'Neutral',
          newStanding: 'Friendly',
          standingChanged: true,
        })
      );
      // 2) reconcile: list_factions then get
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'list_factions',
          factions: [
            ...sampleFactions(),
            { id: 'ghost-faction', name: 'Ghost Faction', description: '', value: 120, standing: 'Friendly' },
          ],
        })
      );
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', characterName: 'Aria', reputations: [], factionCount: 3 })
      );

      await useReputationStore.getState().adjust('char-1', 'ghost-faction', 120);

      const listCalls = callTool.mock.calls.filter(
        (c) => c[0] === 'reputation_manage' && (c[1] as any).action === 'list_factions'
      );
      expect(listCalls.length).toBe(1);
      const entry = useReputationStore.getState().reputationByCharacter['char-1'];
      expect(entry.factions.find((x) => x.id === 'ghost-faction')?.value).toBe(120);
      expect(entry.factionCount).toBe(3);
    });
  });

  describe('set', () => {
    it('calls reputation_manage set and writes the faction value/standing from the response', async () => {
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: sampleFactions(),
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'set',
          characterId: 'char-1',
          factionId: 'thieves-den',
          name: "Thieves' Den",
          value: 700,
          standing: 'Revered',
        })
      );

      await useReputationStore.getState().set('char-1', 'thieves-den', 700);

      expect(callTool).toHaveBeenCalledWith('reputation_manage', {
        action: 'set',
        characterId: 'char-1',
        factionId: 'thieves-den',
        value: 700,
      });

      const entry = useReputationStore.getState().reputationByCharacter['char-1'];
      const f = entry.factions.find((x) => x.id === 'thieves-den');
      expect(f?.value).toBe(700);
      expect(f?.standing).toBe('Revered');
    });

    it('sets error and does NOT corrupt state on a success:false set payload', async () => {
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: sampleFactions(),
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });

      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'set', characterId: 'char-1', factionId: 'thieves-den' })
      );

      await useReputationStore.getState().set('char-1', 'thieves-den', 700);

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      const f = s.reputationByCharacter['char-1'].factions.find((x) => x.id === 'thieves-den');
      expect(f?.value).toBe(-200);
      expect(s.lastResult).toBeNull();
    });
  });

  describe('defineFaction', () => {
    it('calls reputation_manage define_faction with the right args', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'define_faction',
          faction: { id: 'new-order', name: 'New Order', description: 'Freshly forged.' },
        })
      );

      await useReputationStore.getState().defineFaction({
        factionId: 'new-order',
        name: 'New Order',
        description: 'Freshly forged.',
      });

      expect(callTool).toHaveBeenCalledWith('reputation_manage', {
        action: 'define_faction',
        factionId: 'new-order',
        name: 'New Order',
        description: 'Freshly forged.',
      });
      expect(useReputationStore.getState().lastResult?.actionType).toBe('define_faction');
    });

    it('sets error on a success:false define_faction payload', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'define_faction' })
      );

      await useReputationStore.getState().defineFaction({
        factionId: 'dup',
        name: 'Dup',
      });

      expect(useReputationStore.getState().error).toBeTruthy();
      expect(useReputationStore.getState().lastResult).toBeNull();
    });
  });

  describe('check', () => {
    it('calls reputation_manage check and returns the engine met/shortfall result', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'check',
          characterId: 'char-1',
          factionId: 'merchants-guild',
          name: 'Merchants Guild',
          currentValue: 350,
          currentStanding: 'Honored',
          requiredValue: 600,
          met: false,
          shortfall: 250,
        })
      );

      const result = await useReputationStore.getState().check('char-1', 'merchants-guild', 600);

      expect(callTool).toHaveBeenCalledWith('reputation_manage', {
        action: 'check',
        characterId: 'char-1',
        factionId: 'merchants-guild',
        value: 600,
      });
      expect(result?.met).toBe(false);
      expect(result?.shortfall).toBe(250);
      expect(useReputationStore.getState().lastResult?.actionType).toBe('check');
    });

    it('sets error and returns null on a success:false check payload', async () => {
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: false, actionType: 'check', characterId: 'char-1', factionId: 'merchants-guild' })
      );

      const result = await useReputationStore.getState().check('char-1', 'merchants-guild', 600);

      expect(result).toBeNull();
      expect(useReputationStore.getState().error).toBeTruthy();
    });
  });

  describe('error handling (callTool rejects, not returns)', () => {
    it('syncReputation catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce({ code: -32603, message: 'JSON-RPC error: boom' });

      await expect(useReputationStore.getState().syncReputation('char-1')).resolves.toBeUndefined();

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
    });

    it('adjust catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      await expect(
        useReputationStore.getState().adjust('char-1', 'merchants-guild', 10)
      ).resolves.toBeUndefined();

      expect(useReputationStore.getState().error).toBeTruthy();
      expect(useReputationStore.getState().isLoading).toBe(false);
    });

    it('check catches a rejection and resolves to null without throwing', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      await expect(
        useReputationStore.getState().check('char-1', 'merchants-guild', 600)
      ).resolves.toBeNull();

      expect(useReputationStore.getState().error).toBeTruthy();
      expect(useReputationStore.getState().isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // in-flight pending counter (isLoading derived), not a shared bool.
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
      // Two overlapping adjusts for DIFFERENT, locally-present factions take the
      // fast-patch path (no reconcile sync). A naive per-action isLoading=false in
      // finally would flip it false after the FIRST resolves while the SECOND is
      // still pending — the counter must keep it true until BOTH settle.
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: [
              { id: 'f-1', name: 'F1', description: '', value: 0, standing: 'Neutral' },
              { id: 'f-2', name: 'F2', description: '', value: 0, standing: 'Neutral' },
            ],
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });

      const first = deferred<unknown>();
      const second = deferred<unknown>();
      callTool.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const p1 = useReputationStore.getState().adjust('char-1', 'f-1', 50);
      const p2 = useReputationStore.getState().adjust('char-1', 'f-2', 50);

      expect(useReputationStore.getState().pending).toBe(2);
      expect(useReputationStore.getState().isLoading).toBe(true);

      first.resolve(
        wrapResponse({
          success: true,
          actionType: 'adjust',
          characterId: 'char-1',
          factionId: 'f-1',
          name: 'F1',
          oldValue: 0,
          newValue: 50,
          oldStanding: 'Neutral',
          newStanding: 'Neutral',
          standingChanged: false,
        })
      );
      await p1;

      // One still pending — isLoading must remain true.
      expect(useReputationStore.getState().pending).toBe(1);
      expect(useReputationStore.getState().isLoading).toBe(true);

      second.resolve(
        wrapResponse({
          success: true,
          actionType: 'adjust',
          characterId: 'char-1',
          factionId: 'f-2',
          name: 'F2',
          oldValue: 0,
          newValue: 50,
          oldStanding: 'Neutral',
          newStanding: 'Neutral',
          standingChanged: false,
        })
      );
      await p2;

      expect(useReputationStore.getState().pending).toBe(0);
      expect(useReputationStore.getState().isLoading).toBe(false);
    });

    it('never drives pending below zero', async () => {
      callTool.mockResolvedValue(
        wrapResponse({ success: true, actionType: 'list_factions', factions: sampleFactions() })
      );
      await useReputationStore.getState().syncReputation('char-1');
      expect(useReputationStore.getState().pending).toBe(0);
      expect(useReputationStore.getState().isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // payload guard must validate actionType, not just trust an envelope. A
  // wrong-action / partial payload must be treated as a failure and must NOT
  // clobber populated state.
  // ---------------------------------------------------------------------------
  describe('actionType payload validation (success:true but wrong shape)', () => {
    function seedPopulated() {
      useReputationStore.setState({
        reputationByCharacter: {
          'char-1': {
            factions: sampleFactions(),
            factionCount: 2,
            characterName: 'Aria',
          } as any,
        },
      });
    }

    it('treats a list_factions call that returns a get-shaped payload as a failure and does NOT wipe the factions', async () => {
      seedPopulated();
      // success:true but actionType is 'get' (wrong) and there is no factions
      // array — defaulting to [] would clobber the populated list.
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'get',
          characterId: 'char-1',
          reputations: [],
          factionCount: 0,
        })
      );

      await useReputationStore.getState().syncReputation('char-1');

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.reputationByCharacter['char-1'].factions).toHaveLength(2);
    });

    it('treats a list_factions call with a success:true payload that lacks the factions array as a failure', async () => {
      seedPopulated();
      callTool.mockResolvedValueOnce(
        wrapResponse({ success: true, actionType: 'list_factions', characterId: 'char-1' })
      );

      await useReputationStore.getState().syncReputation('char-1');

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.reputationByCharacter['char-1'].factions).toHaveLength(2);
    });

    it('treats an adjust call that returns a set-shaped payload as a failure (no state mutation)', async () => {
      seedPopulated();
      callTool.mockResolvedValueOnce(
        wrapResponse({
          success: true,
          actionType: 'set',
          characterId: 'char-1',
          factionId: 'merchants-guild',
          value: 999,
          standing: 'Exalted',
        })
      );

      await useReputationStore.getState().adjust('char-1', 'merchants-guild', 50);

      const s = useReputationStore.getState();
      expect(s.error).toBeTruthy();
      const f = s.reputationByCharacter['char-1'].factions.find((x) => x.id === 'merchants-guild');
      expect(f?.value).toBe(350);
    });
  });

  // ---------------------------------------------------------------------------
  // stale sync completions must not overwrite fresher state.
  // ---------------------------------------------------------------------------
  describe('stale sync completion (per-character request version)', () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    // Flush microtasks + a macrotask so a parked async action gets PAST its lazy
    // `import('../services/mcpClient')` before the next one is fired. Two dynamic
    // imports racing in the same tick can intermittently resolve to the un-mocked
    // module under vitest, so we serialize past the import boundary.
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('drops an older sync that resolves AFTER a newer sync (newer state wins)', async () => {
      // Sync A (older) is parked at its list_factions await. Sync B (newer) then
      // runs to completion, writing fresh state (value:500). Only afterwards does
      // A's list_factions resolve with STALE data (value:100). A's terminal write
      // must be DROPPED because the per-character request version moved on.
      const aList = deferred<unknown>();
      callTool.mockReturnValueOnce(aList.promise); // A.list_factions — held open

      const pA = useReputationStore.getState().syncReputation('char-1'); // older
      await flush(); // A passes its import and parks at the list await

      callTool
        .mockResolvedValueOnce(
          wrapResponse({
            success: true,
            actionType: 'list_factions',
            factions: [
              { id: 'merchants-guild', name: 'Merchants Guild', description: '', value: 500, standing: 'Honored' },
            ],
          })
        ) // B.list_factions — fresh
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', characterName: 'Aria', reputations: [], factionCount: 1 })
        ) // B.get — fresh
        .mockResolvedValueOnce(
          wrapResponse({ success: true, actionType: 'get', characterId: 'char-1', characterName: 'Aria', reputations: [], factionCount: 1 })
        ); // A.get — stale (consumed after A.list resolves)

      const pB = useReputationStore.getState().syncReputation('char-1'); // newer
      await pB;
      await flush();

      // Sanity: the newer sync has landed.
      let entry = useReputationStore.getState().reputationByCharacter['char-1'];
      expect(entry.factions[0].value).toBe(500);

      // Release the OLDER sync's list with stale data; it reaches its terminal
      // write — which must be dropped.
      aList.resolve(
        wrapResponse({
          success: true,
          actionType: 'list_factions',
          factions: [
            { id: 'merchants-guild', name: 'Merchants Guild', description: '', value: 100, standing: 'Friendly' },
          ],
        })
      );
      await pA;

      // The newer state must still win — the stale older completion was dropped.
      entry = useReputationStore.getState().reputationByCharacter['char-1'];
      expect(entry.factions[0].value).toBe(500);
    });
  });

  describe('persist partialize', () => {
    it('persists only ui prefs, never the server-derived reputation data', () => {
      const persistApi = (useReputationStore as unknown as {
        persist: { getOptions: () => { partialize?: (s: any) => any } };
      }).persist;
      const partialize = persistApi.getOptions().partialize;
      expect(partialize).toBeTypeOf('function');

      const partial = partialize!({
        reputationByCharacter: { 'char-1': { factions: sampleFactions() } },
        selectedFaction: 'merchants-guild',
        isLoading: true,
        error: 'x',
        lastResult: { actionType: 'adjust' },
      });

      expect(partial).not.toHaveProperty('reputationByCharacter');
      expect(partial).not.toHaveProperty('lastResult');
      expect(partial).not.toHaveProperty('isLoading');
      expect(partial.selectedFaction).toBe('merchants-guild');
    });
  });
});
