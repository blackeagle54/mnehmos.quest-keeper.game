/**
 * Characterization tests for gameStateStore.ts
 *
 * gameStateStore is the central game-state store (~982 lines). Its high-value
 * surface is the async bridge-calling actions — syncState and the character /
 * world load paths — which parse engine responses through extractEmbeddedJson()
 * and stitch the results into store state. These tests PIN the CURRENT behavior
 * (characterization, not redesign): in particular the "no-clobber on transient
 * failure" contract, the exact consolidated tool names + action args, and the
 * fact that callTool REJECTS (does not return) on a JSON-RPC engine error.
 *
 * Mock the mcpManager bridge BEFORE importing the store so the store's lazy
 * `await import('../services/mcpClient')` inside syncState resolves to the mock
 * (same pattern as skillStore.test.ts / partyStore.test.ts / combatStore.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/mcpClient', () => ({
  mcpManager: {
    gameStateClient: {
      callTool: vi.fn(),
    },
  },
}));

import { useGameStateStore } from './gameStateStore';
import type { CharacterStats, WorldState, Quest, InventoryItem, Note } from './gameStateStore';
import { mcpManager } from '../services/mcpClient';

const callTool = mcpManager.gameStateClient.callTool as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Envelope helpers — match the EXACT shape extractEmbeddedJson() parses:
//   <!-- {TAG}\n{...json...}\n{TAG} -->
// (see src/utils/mcpUtils.ts). Anything off-format yields a null parse, which
// is the failure signal the store's no-clobber guards key on.
// ---------------------------------------------------------------------------
function wrapEnvelope(tag: string, payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Some markdown\n<!-- ${tag}\n${JSON.stringify(payload)}\n${tag} -->\n`,
      },
    ],
  };
}

// A response whose text carries NO embedded envelope at all → extract returns null.
function plainTextResponse(text = 'No embedded payload here.') {
  return { content: [{ type: 'text', text }] };
}

// A response whose envelope body is malformed JSON → extract returns null.
function malformedEnvelope(tag: string) {
  return {
    content: [{ type: 'text', text: `<!-- ${tag}\n{not valid json\n${tag} -->` }],
  };
}

const INITIAL_WORLD: WorldState = {
  time: 'Unknown',
  location: 'Unknown',
  weather: 'Unknown',
  date: 'Unknown',
  environment: {},
  npcs: {},
  events: {},
};

function resetStore(overrides: Partial<ReturnType<typeof useGameStateStore.getState>> = {}) {
  useGameStateStore.setState(
    {
      inventory: [],
      inventoryCache: {},
      worlds: [],
      world: { ...INITIAL_WORLD },
      notes: [],
      quests: [],
      activeCharacter: null,
      activeCharacterId: null,
      activeWorldId: null,
      party: [],
      isSyncing: false,
      // Far in the past so the 2s rate-limit never blocks a sync.
      lastSyncTime: 0,
      selectionLocked: false,
      ...overrides,
    },
    // Replace=false: keep the action functions that live on the store.
    false
  );
}

// Minimal raw rpg-mcp character JSON (shape consumed by parseCharacterFromJson).
function rawChar(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    level: 3,
    class: 'Wizard',
    hp: 18,
    maxHp: 24,
    stats: { str: 8, dex: 14, con: 12, int: 16, wis: 13, cha: 10 },
    ...extra,
  };
}

function makeCharacterStats(id: string, name: string): CharacterStats {
  return {
    id,
    name,
    level: 3,
    class: 'Wizard',
    hp: { current: 18, max: 24 },
    xp: { current: 0, max: 100 },
    stats: { str: 8, dex: 14, con: 12, int: 16, wis: 13, cha: 10 },
    equipment: { armor: 'None', weapons: [], other: [] },
  };
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

// ===========================================================================
// Plain setters — light smoke coverage only (these are not the risk surface).
// ===========================================================================
describe('gameStateStore — plain setters (smoke)', () => {
  it('has the expected initial state', () => {
    const s = useGameStateStore.getState();
    expect(s.inventory).toEqual([]);
    expect(s.party).toEqual([]);
    expect(s.quests).toEqual([]);
    expect(s.activeCharacter).toBeNull();
    expect(s.activeCharacterId).toBeNull();
    expect(s.activeWorldId).toBeNull();
    expect(s.world.location).toBe('Unknown');
    expect(s.selectionLocked).toBe(false);
  });

  it('setInventory replaces inventory and caches it under the active character id', () => {
    resetStore({ activeCharacterId: 'char-1' });
    const items: InventoryItem[] = [
      { id: 'i1', name: 'Torch', description: '', quantity: 2, type: 'misc' },
    ];
    useGameStateStore.getState().setInventory(items);
    expect(useGameStateStore.getState().inventory).toEqual(items);
    expect(useGameStateStore.getState().inventoryCache['char-1']).toEqual(items);
  });

  it('setWorldState / setQuests / setNotes replace their slices', () => {
    const world: WorldState = { ...INITIAL_WORLD, location: 'Bree' };
    const quests: Quest[] = [
      { id: 'q1', title: 'A', name: 'A', description: '', status: 'active', objectives: [], rewards: {} },
    ];
    const notes: Note[] = [{ id: 'n1', title: 't', content: 'c', author: 'player', timestamp: 1 }];
    const s = useGameStateStore.getState();
    s.setWorldState(world);
    s.setQuests(quests);
    s.setNotes(notes);
    expect(useGameStateStore.getState().world.location).toBe('Bree');
    expect(useGameStateStore.getState().quests).toEqual(quests);
    expect(useGameStateStore.getState().notes).toEqual(notes);
  });

  it('setActiveCharacterId pulls the matching party member, locks by default, and uses cached inventory', () => {
    const char = makeCharacterStats('char-1', 'Gandalf');
    const cached: InventoryItem[] = [{ id: 'i1', name: 'Staff', description: '', quantity: 1, type: 'weapon' }];
    resetStore({ party: [char], inventoryCache: { 'char-1': cached } });

    useGameStateStore.getState().setActiveCharacterId('char-1');

    const s = useGameStateStore.getState();
    expect(s.activeCharacterId).toBe('char-1');
    expect(s.activeCharacter?.name).toBe('Gandalf');
    expect(s.inventory).toEqual(cached); // uses cache, not stale state
    expect(s.selectionLocked).toBe(true); // lock defaults to true
  });

  it('setActiveCharacterId without a cache hit clears inventory to [] (no ghosting)', () => {
    resetStore({ party: [makeCharacterStats('char-1', 'Gandalf')], inventory: [{ id: 'old', name: 'Stale', description: '', quantity: 1, type: 'misc' }] });
    useGameStateStore.getState().setActiveCharacterId('char-1');
    expect(useGameStateStore.getState().inventory).toEqual([]);
  });

  it('setActiveCharacterId(id, false) does not lock the selection', () => {
    resetStore({ party: [makeCharacterStats('char-1', 'Gandalf')] });
    useGameStateStore.getState().setActiveCharacterId('char-1', false);
    expect(useGameStateStore.getState().selectionLocked).toBe(false);
  });

  it('setActiveWorldId locks by default and unlockSelection clears the lock', () => {
    useGameStateStore.getState().setActiveWorldId('world-1');
    expect(useGameStateStore.getState().activeWorldId).toBe('world-1');
    expect(useGameStateStore.getState().selectionLocked).toBe(true);
    useGameStateStore.getState().unlockSelection();
    expect(useGameStateStore.getState().selectionLocked).toBe(false);
  });

  it('addNote / updateNote / deleteNote mutate the deprecated notes slice', () => {
    const note: Note = { id: 'n1', title: 't', content: 'hello', author: 'player', timestamp: 1 };
    const s = useGameStateStore.getState();
    s.addNote(note);
    expect(useGameStateStore.getState().notes).toHaveLength(1);
    s.updateNote('n1', 'updated');
    expect(useGameStateStore.getState().notes[0].content).toBe('updated');
    s.deleteNote('n1');
    expect(useGameStateStore.getState().notes).toEqual([]);
  });
});

// ===========================================================================
// syncState — concurrency / rate-limit guards
// ===========================================================================
describe('gameStateStore — syncState guards', () => {
  it('is a no-op while a sync is already in progress', async () => {
    resetStore({ isSyncing: true });
    await useGameStateStore.getState().syncState();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('is rate-limited to once / 2s when not forced', async () => {
    resetStore({ lastSyncTime: Date.now() }); // just synced
    await useGameStateStore.getState().syncState(false);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('force=true bypasses the rate limit', async () => {
    resetStore({ lastSyncTime: Date.now() });
    // No active char and an empty roster keeps the flow short.
    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    expect(callTool).toHaveBeenCalledWith('character_manage', { action: 'list' });
    expect(useGameStateStore.getState().isSyncing).toBe(false);
  });
});

// ===========================================================================
// syncState — character load path
// ===========================================================================
describe('gameStateStore — syncState character load', () => {
  it('lists characters via the CONSOLIDATED character_manage tool with action:list', async () => {
    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    // Regression guard: a future rename to a stale tool name must fail loudly.
    expect(callTool).toHaveBeenCalledWith('character_manage', { action: 'list' });
  });

  it('populates party + auto-selects the first character when none is active', async () => {
    callTool.mockImplementation(async (name: string, args: any) => {
      if (name === 'character_manage' && args.action === 'list') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', {
          characters: [rawChar('char-1', 'Gandalf'), rawChar('char-2', 'Frodo')],
          count: 2,
        });
      }
      if (name === 'character_manage' && args.action === 'get') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', rawChar('char-1', 'Gandalf'));
      }
      if (name === 'inventory_manage') return wrapEnvelope('INVENTORY_MANAGE_JSON', { inventory: [] });
      if (name === 'quest_manage') return wrapEnvelope('QUEST_MANAGE_JSON', { quests: [] });
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    const s = useGameStateStore.getState();
    expect(s.party.map((c) => c.name)).toEqual(['Gandalf', 'Frodo']);
    expect(s.activeCharacterId).toBe('char-1');
    expect(s.activeCharacter?.name).toBe('Gandalf');
  });

  it('keeps the existing valid selection rather than auto-switching', async () => {
    resetStore({ activeCharacterId: 'char-2' });
    callTool.mockImplementation(async (name: string, args: any) => {
      if (name === 'character_manage' && args.action === 'list') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', {
          characters: [rawChar('char-1', 'Gandalf'), rawChar('char-2', 'Frodo')],
          count: 2,
        });
      }
      if (name === 'character_manage' && args.action === 'get') {
        // Detail get for the active char (char-2).
        return wrapEnvelope('CHARACTER_MANAGE_JSON', rawChar('char-2', 'Frodo'));
      }
      if (name === 'inventory_manage') return wrapEnvelope('INVENTORY_MANAGE_JSON', { inventory: [] });
      if (name === 'quest_manage') return wrapEnvelope('QUEST_MANAGE_JSON', { quests: [] });
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    expect(useGameStateStore.getState().activeCharacterId).toBe('char-2');
    expect(useGameStateStore.getState().activeCharacter?.name).toBe('Frodo');
  });

  it('batch-fetches character detail/inventory/quests with the consolidated tool names + action args', async () => {
    resetStore({ activeCharacterId: 'char-1' });
    const seen: Array<[string, any]> = [];
    callTool.mockImplementation(async (name: string, args: any) => {
      seen.push([name, args]);
      if (name === 'character_manage' && args.action === 'list') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [rawChar('char-1', 'Gandalf')], count: 1 });
      }
      if (name === 'character_manage' && args.action === 'get') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', rawChar('char-1', 'Gandalf'));
      }
      if (name === 'inventory_manage') {
        return wrapEnvelope('INVENTORY_MANAGE_JSON', {
          inventory: [{ name: 'Longsword', quantity: 1, type: 'weapon', equipped: true }],
        });
      }
      if (name === 'quest_manage') {
        return wrapEnvelope('QUEST_MANAGE_JSON', {
          quests: [{ id: 'q1', title: 'Find the Ring', status: 'active', objectives: [] }],
        });
      }
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    // The store batches the detail fetch with these exact consolidated names + args.
    expect(seen).toContainEqual(['character_manage', { action: 'get', characterId: 'char-1' }]);
    expect(seen).toContainEqual(['inventory_manage', { action: 'get_detailed', characterId: 'char-1' }]);
    expect(seen).toContainEqual(['quest_manage', { action: 'get_log', characterId: 'char-1' }]);

    const s = useGameStateStore.getState();
    expect(s.inventory.map((i) => i.name)).toContain('Longsword');
    expect(s.quests.map((q) => q.title)).toContain('Find the Ring');
  });

  it('remaps the consolidated inventory shape (inventory[] not items[]) into parsed items', async () => {
    resetStore({ activeCharacterId: 'char-1' });
    callTool.mockImplementation(async (name: string, args: any) => {
      if (name === 'character_manage' && args.action === 'list') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [rawChar('char-1', 'Gandalf')], count: 1 });
      }
      if (name === 'character_manage' && args.action === 'get') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', rawChar('char-1', 'Gandalf'));
      }
      if (name === 'inventory_manage') {
        // Consolidated payload exposes items under `inventory`, not `items`.
        return wrapEnvelope('INVENTORY_MANAGE_JSON', {
          inventory: [
            { name: 'Healing Potion', quantity: 3, type: 'consumable' },
            { name: 'Gold Pieces', quantity: 50, type: 'currency' },
          ],
        });
      }
      if (name === 'quest_manage') return wrapEnvelope('QUEST_MANAGE_JSON', { quests: [] });
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    const inv = useGameStateStore.getState().inventory;
    expect(inv.map((i) => i.name)).toEqual(['Healing Potion', 'Gold Pieces']);
    // Currency derived from inventory items lands on the active character.
    expect(useGameStateStore.getState().activeCharacter?.currencies?.gold).toBe(50);
  });
});

// ===========================================================================
// syncState — NO-CLOBBER characterization (the known bug class)
// extractEmbeddedJson returns null (does NOT throw) on a bad/empty/malformed
// envelope. These pin what the store does to GOOD existing state on a
// transient parse failure.
// ===========================================================================
describe('gameStateStore — syncState no-clobber on transient failure', () => {
  it('PRESERVES party/activeCharacter when character_manage/list returns a non-envelope payload', async () => {
    const existing = [makeCharacterStats('char-1', 'Gandalf')];
    resetStore({ party: existing, activeCharacter: existing[0], activeCharacterId: 'char-1' });

    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') return plainTextResponse('Engine emitted prose, no envelope.');
      // After the list throw, activeCharId is still 'char-1' so the detail batch runs;
      // return nulls there so nothing else clobbers.
      if (name === 'inventory_manage') return plainTextResponse();
      if (name === 'quest_manage') return plainTextResponse();
      if (name === 'world_manage') return plainTextResponse();
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    const s = useGameStateStore.getState();
    // GOOD behavior: existing roster + selection survive the transient list failure.
    expect(s.party.map((c) => c.name)).toEqual(['Gandalf']);
    expect(s.activeCharacterId).toBe('char-1');
    expect(s.activeCharacter?.name).toBe('Gandalf');
  });

  it('PRESERVES party when character_manage/list returns a malformed-JSON envelope', async () => {
    const existing = [makeCharacterStats('char-1', 'Gandalf')];
    resetStore({ party: existing, activeCharacter: existing[0], activeCharacterId: 'char-1' });

    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') return malformedEnvelope('CHARACTER_MANAGE_JSON');
      if (name === 'inventory_manage') return plainTextResponse();
      if (name === 'quest_manage') return plainTextResponse();
      if (name === 'world_manage') return plainTextResponse();
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);
    expect(useGameStateStore.getState().party.map((c) => c.name)).toEqual(['Gandalf']);
    expect(useGameStateStore.getState().activeCharacterId).toBe('char-1');
  });

  it('PRESERVES existing inventory/quests when the detail batch returns non-envelope payloads', async () => {
    const existingInv: InventoryItem[] = [{ id: 'i1', name: 'Heirloom Blade', description: '', quantity: 1, type: 'weapon' }];
    const existingQuests: Quest[] = [
      { id: 'q1', title: 'Old Quest', name: 'Old Quest', description: '', status: 'active', objectives: [], rewards: {} },
    ];
    const existing = [makeCharacterStats('char-1', 'Gandalf')];
    resetStore({
      party: existing,
      activeCharacter: existing[0],
      activeCharacterId: 'char-1',
      inventory: existingInv,
      quests: existingQuests,
    });

    callTool.mockImplementation(async (name: string, args: any) => {
      if (name === 'character_manage' && args.action === 'list') {
        return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [rawChar('char-1', 'Gandalf')], count: 1 });
      }
      // All detail fetches come back without parseable envelopes (transient failure).
      return plainTextResponse('engine hiccup');
    });

    await useGameStateStore.getState().syncState(true);

    const s = useGameStateStore.getState();
    // The guarded `if (inventoryData)` / `if (questData)` blocks never fire, so
    // existing inventory + quests are PRESERVED rather than clobbered to [].
    expect(s.inventory.map((i) => i.name)).toEqual(['Heirloom Blade']);
    expect(s.quests.map((q) => q.title)).toEqual(['Old Quest']);
  });

  it('PRESERVES worlds/world/activeWorldId when world_manage/list returns a non-envelope payload', async () => {
    const existingWorld: WorldState = { ...INITIAL_WORLD, location: 'Rivendell', weather: 'Clear' };
    resetStore({
      worlds: [{ id: 'world-1', name: 'Middle-earth' }],
      world: existingWorld,
      activeWorldId: 'world-1',
    });

    callTool.mockImplementation(async (name: string) => {
      // No active character, so character block clears char-side state and skips detail batch.
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage') return plainTextResponse('world list prose, no envelope');
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    const s = useGameStateStore.getState();
    // GOOD behavior: the world block throws past the `set({ worlds })`, so prior
    // worlds/world/activeWorldId survive the transient list failure.
    expect(s.worlds).toEqual([{ id: 'world-1', name: 'Middle-earth' }]);
    expect(s.world.location).toBe('Rivendell');
    expect(s.activeWorldId).toBe('world-1');
  });

  it('[known behavior] CLOBBERS char-side state to empty on a LEGITIMATELY empty roster (valid envelope, count:0)', async () => {
    // This is the inverse of no-clobber: a *valid* empty-roster envelope is NOT a
    // failure, so the store intentionally resets party/activeCharacter/activeCharacterId.
    const existing = [makeCharacterStats('char-1', 'Gandalf')];
    resetStore({ party: existing, activeCharacter: existing[0], activeCharacterId: 'char-1' });

    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    const s = useGameStateStore.getState();
    expect(s.party).toEqual([]);
    expect(s.activeCharacter).toBeNull();
    expect(s.activeCharacterId).toBeNull();
  });
});

// ===========================================================================
// syncState — world load path (list + get / get_state fallback)
// ===========================================================================
describe('gameStateStore — syncState world load', () => {
  it('lists worlds and fetches detail via the CONSOLIDATED world_manage tool (list + get)', async () => {
    const seen: Array<[string, any]> = [];
    callTool.mockImplementation(async (name: string, args: any) => {
      seen.push([name, args]);
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage' && args.action === 'list') {
        return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [{ id: 'world-1', name: 'Middle-earth' }] });
      }
      if (name === 'world_manage' && args.action === 'get') {
        return wrapEnvelope('WORLD_MANAGE_JSON', {
          world: { id: 'world-1', name: 'Middle-earth', weather: 'Stormy', time: 'Dusk' },
        });
      }
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    // Regression guards on tool name + action args.
    expect(seen).toContainEqual(['world_manage', { action: 'list' }]);
    expect(seen).toContainEqual(['world_manage', { action: 'get', id: 'world-1' }]);

    const s = useGameStateStore.getState();
    expect(s.activeWorldId).toBe('world-1');
    expect(s.world.location).toBe('Middle-earth');
    expect(s.world.weather).toBe('Stormy');
  });

  it('falls back to world_manage/get_state (flat shape) when /get returns no world', async () => {
    const seen: Array<[string, any]> = [];
    callTool.mockImplementation(async (name: string, args: any) => {
      seen.push([name, args]);
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage' && args.action === 'list') {
        return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [{ id: 'world-1', name: 'Middle-earth' }] });
      }
      if (name === 'world_manage' && args.action === 'get') {
        // /get yields an envelope without a `.world` field → store throws and falls back.
        return wrapEnvelope('WORLD_MANAGE_JSON', { error: 'not found' });
      }
      if (name === 'world_manage' && args.action === 'get_state') {
        // get_state is FLAT (name/weather at top level).
        return wrapEnvelope('WORLD_MANAGE_JSON', { name: 'Mordor', weather: 'Ash', time: 'Night' });
      }
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    expect(seen).toContainEqual(['world_manage', { action: 'get_state', worldId: 'world-1' }]);
    const s = useGameStateStore.getState();
    expect(s.world.location).toBe('Mordor');
    expect(s.world.weather).toBe('Ash');
  });

  it('keeps a locked world selection instead of auto-switching to worlds[0]', async () => {
    resetStore({ activeWorldId: 'world-2', selectionLocked: true });
    callTool.mockImplementation(async (name: string, args: any) => {
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage' && args.action === 'list') {
        return wrapEnvelope('WORLD_MANAGE_JSON', {
          worlds: [{ id: 'world-1', name: 'Shire' }, { id: 'world-2', name: 'Gondor' }],
        });
      }
      if (name === 'world_manage' && args.action === 'get') {
        // Detail get must be for the locked world (world-2).
        expect(args.id).toBe('world-2');
        return wrapEnvelope('WORLD_MANAGE_JSON', { world: { id: 'world-2', name: 'Gondor' } });
      }
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);

    expect(useGameStateStore.getState().activeWorldId).toBe('world-2');
    expect(useGameStateStore.getState().world.location).toBe('Gondor');
  });
});

// ===========================================================================
// syncState — engine-error robustness (callTool REJECTS, per the bridge contract)
// ===========================================================================
describe('gameStateStore — syncState handles a rejecting callTool', () => {
  it('does not throw and leaves state sane when character_manage/list rejects (JSON-RPC error)', async () => {
    const existing = [makeCharacterStats('char-1', 'Gandalf')];
    resetStore({ party: existing, activeCharacter: existing[0], activeCharacterId: 'char-1' });

    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') throw { code: -32603, message: 'JSON-RPC error: boom' };
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    // A rejection must be caught inside syncState — a thrown promise into a React
    // effect would crash render.
    await expect(useGameStateStore.getState().syncState(true)).resolves.toBeUndefined();

    const s = useGameStateStore.getState();
    expect(s.isSyncing).toBe(false); // finally{} always clears the flag
    // The list-call rejection is caught locally → existing roster preserved.
    expect(s.party.map((c) => c.name)).toEqual(['Gandalf']);
    expect(s.activeCharacterId).toBe('char-1');
  });

  it('does not throw and clears isSyncing when world_manage rejects', async () => {
    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage') throw new Error('network down');
      return plainTextResponse();
    });

    await expect(useGameStateStore.getState().syncState(true)).resolves.toBeUndefined();
    expect(useGameStateStore.getState().isSyncing).toBe(false);
  });

  it('clears the selection lock after a successful sync', async () => {
    resetStore({ selectionLocked: true });
    callTool.mockImplementation(async (name: string) => {
      if (name === 'character_manage') return wrapEnvelope('CHARACTER_MANAGE_JSON', { characters: [], count: 0 });
      if (name === 'world_manage') return wrapEnvelope('WORLD_MANAGE_JSON', { worlds: [] });
      return plainTextResponse();
    });

    await useGameStateStore.getState().syncState(true);
    expect(useGameStateStore.getState().selectionLocked).toBe(false);
  });
});
