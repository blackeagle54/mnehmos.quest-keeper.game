/**
 * Tests for partyStore.ts
 * 
 * Testing Zustand store with mock MCP client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// act not used? remove if so.
// afterEach not used? remove if so.

// Mock the MCP client before importing the store
vi.mock('../services/mcpClient', () => ({
  mcpManager: {
    gameStateClient: {
      callTool: vi.fn(),
    },
  },
}));

// Mock gameStateStore to prevent circular dependency issues
vi.mock('./gameStateStore', () => ({
  useGameStateStore: {
    getState: () => ({
      activeCharacterId: null,
      setActiveCharacterId: vi.fn(),
      syncState: vi.fn(),
    }),
  },
}));

import { usePartyStore } from './partyStore';
import type { Party, PartyWithMembers } from './partyStore';
import { mcpManager } from '../services/mcpClient';

// Typed handle on the mocked bridge callTool used by the async-action suites
// below. The inline vi.mock() above replaces mcpClient with a module whose
// gameStateClient.callTool is a vi.fn(); the store reaches it via a lazy
// `await import('../services/mcpClient')`, so this same reference is what the
// store invokes.
const callTool = mcpManager.gameStateClient.callTool as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Envelope helpers — match the EXACT shape extractEmbeddedJson() parses:
//   <!-- {TAG}\n{...json...}\n{TAG} -->
// (see src/utils/mcpUtils.ts). The store's consolidated party_manage /
// character_manage payloads ride in PARTY_MANAGE_JSON / CHARACTER_MANAGE_JSON
// envelopes. Anything off-format yields a null parse, which is the failure
// signal the store's guards key on. Mirrors gameStateStore.test.ts.
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

// party_manage success envelope.
function wrapParty(payload: unknown) {
  return wrapEnvelope('PARTY_MANAGE_JSON', payload);
}

// character_manage success envelope.
function wrapCharacter(payload: unknown) {
  return wrapEnvelope('CHARACTER_MANAGE_JSON', payload);
}

// A response whose text carries NO embedded envelope at all → extract → null.
function plainTextResponse(text = 'No embedded payload here.') {
  return { content: [{ type: 'text', text }] };
}

// A response whose envelope body is malformed JSON → extract → null.
function malformedEnvelope(tag: string) {
  return {
    content: [{ type: 'text', text: `<!-- ${tag}\n{not valid json\n${tag} -->` }],
  };
}

// A non-null party_manage envelope carrying an in-band error payload. This
// resolves the promise (router "succeeded") yet the operation FAILED.
function inBandPartyError(message = 'engine refused') {
  return wrapParty({ error: message });
}

// A fully-populated party used to seed partyDetails so we can observe whether a
// failing mutation clobbers good state. Shape matches PartyWithMembers.
function seededParty(id = 'party-1'): PartyWithMembers {
  return {
    id,
    name: 'The Fellowship',
    status: 'active',
    formation: 'standard',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    positionX: 10,
    positionY: 20,
    currentLocation: 'Rivendell',
    members: [
      {
        id: 'member-1',
        partyId: id,
        characterId: 'char-frodo',
        role: 'leader',
        isActive: true,
        sharePercentage: 100,
        joinedAt: '2024-01-01T00:00:00Z',
        character: {
          id: 'char-frodo',
          name: 'Frodo',
          level: 5,
          class: 'Rogue',
          hp: 30,
          maxHp: 30,
          characterType: 'pc',
        },
      },
    ],
  };
}

// Seed a known-good store snapshot whose mutation we want to characterize.
// Resets rate-limit fields so syncParties() is never skipped.
function seedGoodState(partyId = 'party-1') {
  const detail = seededParty(partyId);
  usePartyStore.setState({
    activePartyId: partyId,
    parties: [
      {
        id: partyId,
        name: detail.name,
        status: detail.status,
        formation: detail.formation,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
      },
    ],
    partyDetails: { [partyId]: detail },
    unassignedCharacters: [
      {
        id: 'char-sam',
        name: 'Sam',
        level: 4,
        class: 'Fighter',
        hp: 28,
        maxHp: 28,
        characterType: 'pc',
      },
    ],
    isLoading: false,
    isSyncing: false,
    lastSyncTime: 0,
    error: null,
  });
}

describe('partyStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    usePartyStore.setState({
      activePartyId: null,
      parties: [],
      partyDetails: {},
      unassignedCharacters: [],
      isLoading: false,
      isSyncing: false,
      lastSyncTime: 0,
      isInitialized: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('has correct initial state', () => {
      const state = usePartyStore.getState();
      
      expect(state.activePartyId).toBeNull();
      expect(state.parties).toEqual([]);
      expect(state.partyDetails).toEqual({});
      expect(state.unassignedCharacters).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.isSyncing).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe('Basic Setters', () => {
    it('setActivePartyId updates activePartyId', () => {
      const { setActivePartyId } = usePartyStore.getState();
      
      setActivePartyId('party-123');
      
      expect(usePartyStore.getState().activePartyId).toBe('party-123');
    });

    it('setActivePartyId can clear activePartyId', () => {
      usePartyStore.setState({ activePartyId: 'party-123' });
      
      const { setActivePartyId } = usePartyStore.getState();
      setActivePartyId(null);
      
      expect(usePartyStore.getState().activePartyId).toBeNull();
    });

    it('setError updates error state', () => {
      const { setError } = usePartyStore.getState();
      
      setError('Something went wrong');
      
      expect(usePartyStore.getState().error).toBe('Something went wrong');
    });

    it('setError can clear error', () => {
      usePartyStore.setState({ error: 'Previous error' });
      
      const { setError } = usePartyStore.getState();
      setError(null);
      
      expect(usePartyStore.getState().error).toBeNull();
    });
  });

  describe('Selectors', () => {
    const mockPartyWithMembers: PartyWithMembers = {
      id: 'party-1',
      name: 'The Fellowship',
      status: 'active',
      formation: 'standard',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      positionX: 50,
      positionY: 75,
      currentLocation: 'Rivendell',
      members: [
        {
          id: 'member-1',
          partyId: 'party-1',
          characterId: 'char-gandalf',
          role: 'leader',
          isActive: false,
          sharePercentage: 100,
          joinedAt: '2024-01-01T00:00:00Z',
          character: {
            id: 'char-gandalf',
            name: 'Gandalf',
            level: 20,
            class: 'Wizard',
            hp: 100,
            maxHp: 100,
            characterType: 'pc',
          },
        },
        {
          id: 'member-2',
          partyId: 'party-1',
          characterId: 'char-frodo',
          role: 'member',
          isActive: true,
          sharePercentage: 100,
          joinedAt: '2024-01-01T00:00:00Z',
          character: {
            id: 'char-frodo',
            name: 'Frodo',
            level: 5,
            class: 'Rogue',
            hp: 30,
            maxHp: 30,
            characterType: 'pc',
          },
        },
      ],
    };

    beforeEach(() => {
      usePartyStore.setState({
        activePartyId: 'party-1',
        partyDetails: { 'party-1': mockPartyWithMembers },
      });
    });

    describe('getActiveParty', () => {
      it('returns active party when activePartyId is set', () => {
        const { getActiveParty } = usePartyStore.getState();
        
        const activeParty = getActiveParty();
        
        expect(activeParty).not.toBeNull();
        expect(activeParty?.name).toBe('The Fellowship');
        expect(activeParty?.members).toHaveLength(2);
      });

      it('returns null when no activePartyId', () => {
        usePartyStore.setState({ activePartyId: null });
        
        const { getActiveParty } = usePartyStore.getState();
        
        expect(getActiveParty()).toBeNull();
      });

      it('returns null when partyDetails not loaded', () => {
        usePartyStore.setState({ partyDetails: {} });
        
        const { getActiveParty } = usePartyStore.getState();
        
        expect(getActiveParty()).toBeNull();
      });
    });

    describe('getActivePartyPosition', () => {
      it('returns position when party has coordinates', () => {
        const { getActivePartyPosition } = usePartyStore.getState();
        
        const position = getActivePartyPosition();
        
        expect(position).not.toBeNull();
        expect(position?.x).toBe(50);
        expect(position?.y).toBe(75);
        expect(position?.locationName).toBe('Rivendell');
      });

      it('returns null when no active party', () => {
        usePartyStore.setState({ activePartyId: null });
        
        const { getActivePartyPosition } = usePartyStore.getState();
        
        expect(getActivePartyPosition()).toBeNull();
      });
    });

    describe('getLeader', () => {
      it('returns member with leader role', () => {
        const { getLeader } = usePartyStore.getState();
        
        const leader = getLeader();
        
        expect(leader).not.toBeNull();
        expect(leader?.character.name).toBe('Gandalf');
        expect(leader?.role).toBe('leader');
      });

      it('returns null when no leader assigned', () => {
        const partyWithoutLeader = {
          ...mockPartyWithMembers,
          members: mockPartyWithMembers.members.map(m => ({ ...m, role: 'member' as const })),
        };
        usePartyStore.setState({ partyDetails: { 'party-1': partyWithoutLeader } });
        
        const { getLeader } = usePartyStore.getState();
        
        expect(getLeader()).toBeNull();
      });
    });

    describe('getActiveCharacterMember', () => {
      it('returns member with isActive=true', () => {
        const { getActiveCharacterMember } = usePartyStore.getState();
        
        const activeMember = getActiveCharacterMember();
        
        expect(activeMember).not.toBeNull();
        expect(activeMember?.character.name).toBe('Frodo');
        expect(activeMember?.isActive).toBe(true);
      });

      it('returns null when no active member', () => {
        const partyWithoutActive = {
          ...mockPartyWithMembers,
          members: mockPartyWithMembers.members.map(m => ({ ...m, isActive: false })),
        };
        usePartyStore.setState({ partyDetails: { 'party-1': partyWithoutActive } });
        
        const { getActiveCharacterMember } = usePartyStore.getState();
        
        expect(getActiveCharacterMember()).toBeNull();
      });
    });
  });

  describe('State Updates', () => {
    it('can update parties list', () => {
      const mockParties: Party[] = [
        {
          id: 'party-1',
          name: 'Fellowship',
          status: 'active',
          formation: 'standard',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'party-2',
          name: 'Bandits',
          status: 'dormant',
          formation: 'loose',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      usePartyStore.setState({ parties: mockParties });
      
      expect(usePartyStore.getState().parties).toHaveLength(2);
      expect(usePartyStore.getState().parties[0].name).toBe('Fellowship');
    });

    it('can update loading states', () => {
      usePartyStore.setState({ isLoading: true, isSyncing: true });
      
      const state = usePartyStore.getState();
      expect(state.isLoading).toBe(true);
      expect(state.isSyncing).toBe(true);
    });

    it('can track sync time', () => {
      const now = Date.now();
      usePartyStore.setState({ lastSyncTime: now });
      
      expect(usePartyStore.getState().lastSyncTime).toBe(now);
    });
  });

  describe('Type Exports', () => {
    it('exports PartyStatus type correctly', () => {
      const statuses: Array<'active' | 'dormant' | 'archived'> = ['active', 'dormant', 'archived'];
      statuses.forEach(status => {
        const party: Partial<Party> = { status };
        expect(['active', 'dormant', 'archived']).toContain(party.status);
      });
    });

    it('exports MemberRole type correctly', () => {
      const roles = ['leader', 'member', 'companion', 'hireling', 'prisoner', 'mount'];
      roles.forEach(role => {
        expect(typeof role).toBe('string');
      });
    });
  });

  // =========================================================================
  // ASYNC BRIDGE-CALLING ACTIONS — characterization tests.
  //
  // These pin the CURRENT behavior of the 16 actions that reach the engine via
  // mcpManager.gameStateClient.callTool. Three disciplines per state-mutating
  // action:
  //   1. tool-name guard   — exact tool name + action arg (consolidation drift)
  //   2. no-clobber        — feed a malformed/empty/in-band-error response and
  //                          assert what happens to existing good state
  //   3. error robustness  — callTool REJECTS (JSON-RPC engine error); action
  //                          must not crash and must leave state sane.
  //
  // Source is NOT modified; bugs are characterized, never fixed.
  // =========================================================================

  describe('createParty (party_manage:create)', () => {
    it('calls party_manage with action=create and the provided fields', async () => {
      // create → (on success) syncParties(list) → syncPartyDetails(get) →
      // syncUnassignedCharacters(get_unassigned). Route every fan-out call.
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'create') return Promise.resolve(wrapParty({ id: 'new-party' }));
        if (args.action === 'list') return Promise.resolve(wrapParty({ parties: [], count: 0 }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'new-party', name: 'X', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      const id = await usePartyStore.getState().createParty('Heroes', 'desc', 'world-9', [
        { characterId: 'char-1', role: 'member' },
      ]);

      expect(id).toBe('new-party');
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'create',
        name: 'Heroes',
        description: 'desc',
        worldId: 'world-9',
        initialMembers: [{ characterId: 'char-1', role: 'member' }],
      });
    });

    it('omits optional fields when not provided', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'create') return Promise.resolve(wrapParty({ id: 'p2' }));
        if (args.action === 'list') return Promise.resolve(wrapParty({ parties: [], count: 0 }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'p2', name: 'X', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      await usePartyStore.getState().createParty('Solo');

      expect(callTool).toHaveBeenCalledWith('party_manage', { action: 'create', name: 'Solo' });
    });

    it('accepts a nested { party: { id } } success shape', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'create') return Promise.resolve(wrapParty({ party: { id: 'nested-id' } }));
        if (args.action === 'list') return Promise.resolve(wrapParty({ parties: [], count: 0 }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'nested-id', name: 'X', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      const id = await usePartyStore.getState().createParty('Nested');
      expect(id).toBe('nested-id');
    });

    it('returns null and sets error on a malformed (no-id) response, leaving activePartyId untouched', async () => {
      seedGoodState('keep-me');
      callTool.mockResolvedValue(malformedEnvelope('PARTY_MANAGE_JSON'));

      const id = await usePartyStore.getState().createParty('Doomed');

      expect(id).toBeNull();
      expect(usePartyStore.getState().error).toBeTruthy();
      // No new party id was adopted; existing active party is preserved.
      expect(usePartyStore.getState().activePartyId).toBe('keep-me');
      expect(usePartyStore.getState().isLoading).toBe(false);
    });

    it('returns null and sets error when callTool REJECTS, without crashing', async () => {
      callTool.mockRejectedValue(new Error('JSON-RPC error -32000: engine down'));

      const id = await usePartyStore.getState().createParty('Boom');

      expect(id).toBeNull();
      expect(usePartyStore.getState().error).toContain('engine down');
      expect(usePartyStore.getState().isLoading).toBe(false);
    });
  });

  describe('updateParty (party_manage:update)', () => {
    it('calls party_manage with action=update, partyId and spread updates', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'update') return Promise.resolve(wrapParty({ id: 'party-1', updated: true }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().updateParty('party-1', { name: 'Renamed', formation: 'wedge' });

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'update',
        partyId: 'party-1',
        name: 'Renamed',
        formation: 'wedge',
      });
    });

    it('returns false and preserves existing partyDetails on a malformed response', async () => {
      seedGoodState('party-1');
      const before = usePartyStore.getState().partyDetails['party-1'];
      callTool.mockResolvedValue(plainTextResponse());

      const ok = await usePartyStore.getState().updateParty('party-1', { name: 'X' });

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBeTruthy();
      // No-clobber: detail object is untouched on failure.
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(before);
    });

    it('returns false on an in-band error payload', async () => {
      seedGoodState('party-1');
      callTool.mockResolvedValue(inBandPartyError('cannot update'));

      const ok = await usePartyStore.getState().updateParty('party-1', { name: 'X' });

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('cannot update');
    });

    it('returns false when callTool REJECTS, without crashing', async () => {
      seedGoodState('party-1');
      callTool.mockRejectedValue(new Error('rpc boom'));

      const ok = await usePartyStore.getState().updateParty('party-1', { name: 'X' });

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('rpc boom');
      expect(usePartyStore.getState().isLoading).toBe(false);
    });
  });

  describe('deleteParty (party_manage:delete)', () => {
    it('calls party_manage with action=delete + partyId and removes the party locally', async () => {
      seedGoodState('party-1');
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'delete') return Promise.resolve(wrapParty({ success: true, deleted: 'party-1' }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().deleteParty('party-1');

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', { action: 'delete', partyId: 'party-1' });
      const state = usePartyStore.getState();
      expect(state.parties.find((p) => p.id === 'party-1')).toBeUndefined();
      expect(state.partyDetails['party-1']).toBeUndefined();
      // active party was the deleted one → cleared.
      expect(state.activePartyId).toBeNull();
    });

    it('NO-CLOBBER: malformed response is treated as failure; party is NOT removed', async () => {
      seedGoodState('party-1');
      callTool.mockResolvedValue(malformedEnvelope('PARTY_MANAGE_JSON'));

      const ok = await usePartyStore.getState().deleteParty('party-1');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBeTruthy();
      // Guarded by assertPartyManageSuccess — local state preserved.
      expect(usePartyStore.getState().parties.find((p) => p.id === 'party-1')).toBeDefined();
      expect(usePartyStore.getState().partyDetails['party-1']).toBeDefined();
      expect(usePartyStore.getState().activePartyId).toBe('party-1');
    });

    it('treats an in-band { success: false } payload as failure', async () => {
      seedGoodState('party-1');
      callTool.mockResolvedValue(wrapParty({ success: false }));

      const ok = await usePartyStore.getState().deleteParty('party-1');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().parties.find((p) => p.id === 'party-1')).toBeDefined();
    });

    it('returns false when callTool REJECTS, leaving state intact', async () => {
      seedGoodState('party-1');
      callTool.mockRejectedValue(new Error('delete rpc boom'));

      const ok = await usePartyStore.getState().deleteParty('party-1');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('delete rpc boom');
      expect(usePartyStore.getState().parties.find((p) => p.id === 'party-1')).toBeDefined();
    });
  });

  describe('addMember (party_manage:add_member)', () => {
    it('calls party_manage with action=add_member, partyId, characterId and role (default member)', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'add_member') return Promise.resolve(wrapParty({ success: true }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().addMember('party-1', 'char-sam');

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'add_member',
        partyId: 'party-1',
        characterId: 'char-sam',
        role: 'member',
      });
    });

    it('forwards an explicit role', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'add_member') return Promise.resolve(wrapParty({ success: true }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      await usePartyStore.getState().addMember('party-1', 'char-sam', 'companion');

      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'add_member',
        partyId: 'party-1',
        characterId: 'char-sam',
        role: 'companion',
      });
    });

    it('NO-CLOBBER: malformed response is a failure; party members + unassigned preserved', async () => {
      seedGoodState('party-1');
      const beforeDetail = usePartyStore.getState().partyDetails['party-1'];
      const beforeUnassigned = usePartyStore.getState().unassignedCharacters;
      callTool.mockResolvedValue(plainTextResponse());

      const ok = await usePartyStore.getState().addMember('party-1', 'char-sam');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBeTruthy();
      // assertPartyManageSuccess throws BEFORE any sync fan-out → no clobber.
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(beforeDetail);
      expect(usePartyStore.getState().unassignedCharacters).toBe(beforeUnassigned);
    });

    it('returns false when callTool REJECTS', async () => {
      seedGoodState('party-1');
      callTool.mockRejectedValue(new Error('add rpc boom'));

      const ok = await usePartyStore.getState().addMember('party-1', 'char-sam');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('add rpc boom');
    });
  });

  describe('removeMember (party_manage:remove_member)', () => {
    it('calls party_manage with action=remove_member, partyId, characterId', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'remove_member') return Promise.resolve(wrapParty({ success: true }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().removeMember('party-1', 'char-frodo');

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'remove_member',
        partyId: 'party-1',
        characterId: 'char-frodo',
      });
    });

    it('NO-CLOBBER: in-band error keeps existing members intact', async () => {
      seedGoodState('party-1');
      const beforeDetail = usePartyStore.getState().partyDetails['party-1'];
      callTool.mockResolvedValue(inBandPartyError('not a member'));

      const ok = await usePartyStore.getState().removeMember('party-1', 'char-frodo');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('not a member');
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(beforeDetail);
    });

    it('returns false when callTool REJECTS', async () => {
      seedGoodState('party-1');
      callTool.mockRejectedValue(new Error('remove rpc boom'));

      const ok = await usePartyStore.getState().removeMember('party-1', 'char-frodo');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('remove rpc boom');
    });
  });

  describe('updateMember (party_manage:update_member)', () => {
    it('calls party_manage with action=update_member, partyId, characterId and spread updates', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'update_member') return Promise.resolve(wrapParty({ success: true }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().updateMember('party-1', 'char-frodo', {
        role: 'companion',
        position: 2,
        notes: 'scout',
      });

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'update_member',
        partyId: 'party-1',
        characterId: 'char-frodo',
        role: 'companion',
        position: 2,
        notes: 'scout',
      });
    });

    it('NO-CLOBBER: malformed response preserves member state', async () => {
      seedGoodState('party-1');
      const beforeDetail = usePartyStore.getState().partyDetails['party-1'];
      callTool.mockResolvedValue(malformedEnvelope('PARTY_MANAGE_JSON'));

      const ok = await usePartyStore.getState().updateMember('party-1', 'char-frodo', { role: 'member' });

      expect(ok).toBe(false);
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(beforeDetail);
    });

    it('returns false when callTool REJECTS', async () => {
      callTool.mockRejectedValue(new Error('updatemember rpc boom'));

      const ok = await usePartyStore.getState().updateMember('party-1', 'char-frodo', { role: 'member' });

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('updatemember rpc boom');
    });
  });

  describe('setLeader (party_manage:set_leader)', () => {
    it('calls party_manage with action=set_leader, partyId, characterId', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'set_leader') return Promise.resolve(wrapParty({ success: true }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().setLeader('party-1', 'char-frodo');

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'set_leader',
        partyId: 'party-1',
        characterId: 'char-frodo',
      });
    });

    it('NO-CLOBBER: malformed response preserves member state', async () => {
      seedGoodState('party-1');
      const beforeDetail = usePartyStore.getState().partyDetails['party-1'];
      callTool.mockResolvedValue(plainTextResponse());

      const ok = await usePartyStore.getState().setLeader('party-1', 'char-frodo');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(beforeDetail);
    });

    it('returns false when callTool REJECTS', async () => {
      callTool.mockRejectedValue(new Error('setleader rpc boom'));

      const ok = await usePartyStore.getState().setLeader('party-1', 'char-frodo');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('setleader rpc boom');
    });
  });

  describe('setActiveCharacter (party_manage:set_active)', () => {
    it('calls party_manage with action=set_active, partyId, characterId', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'set_active') return Promise.resolve(wrapParty({ success: true }));
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().setActiveCharacter('party-1', 'char-frodo');

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'set_active',
        partyId: 'party-1',
        characterId: 'char-frodo',
      });
    });

    it('NO-CLOBBER: malformed response does NOT switch POV / clobber member state', async () => {
      seedGoodState('party-1');
      const beforeDetail = usePartyStore.getState().partyDetails['party-1'];
      callTool.mockResolvedValue(malformedEnvelope('PARTY_MANAGE_JSON'));

      const ok = await usePartyStore.getState().setActiveCharacter('party-1', 'char-sam');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBeTruthy();
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(beforeDetail);
    });

    it('returns false when callTool REJECTS', async () => {
      callTool.mockRejectedValue(new Error('setactive rpc boom'));

      const ok = await usePartyStore.getState().setActiveCharacter('party-1', 'char-frodo');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('setactive rpc boom');
    });
  });

  describe('deleteCharacter (character_manage:delete)', () => {
    it('calls character_manage with action=delete + characterId', async () => {
      callTool.mockImplementation((name: string, args: any) => {
        if (name === 'character_manage' && args.action === 'delete') {
          return Promise.resolve(wrapCharacter({ success: true, deleted: 'char-x' }));
        }
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().deleteCharacter('char-x');

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('character_manage', { action: 'delete', characterId: 'char-x' });
    });

    it('NO-CLOBBER: malformed character_manage response is a failure; unassigned + details preserved', async () => {
      seedGoodState('party-1');
      const beforeDetail = usePartyStore.getState().partyDetails['party-1'];
      const beforeUnassigned = usePartyStore.getState().unassignedCharacters;
      callTool.mockResolvedValue(malformedEnvelope('CHARACTER_MANAGE_JSON'));

      const ok = await usePartyStore.getState().deleteCharacter('char-x');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBeTruthy();
      // assertManageSuccess throws before any refresh → no clobber.
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(beforeDetail);
      expect(usePartyStore.getState().unassignedCharacters).toBe(beforeUnassigned);
    });

    it('returns false when callTool REJECTS', async () => {
      callTool.mockRejectedValue(new Error('delchar rpc boom'));

      const ok = await usePartyStore.getState().deleteCharacter('char-x');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('delchar rpc boom');
    });
  });

  describe('updateCharacter (character_manage:update)', () => {
    it('calls character_manage with action=update, characterId and spread updates', async () => {
      callTool.mockImplementation((name: string, args: any) => {
        if (name === 'character_manage' && args.action === 'update') {
          return Promise.resolve(wrapCharacter({ success: true, id: 'char-x' }));
        }
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'party-1', name: 'X', members: [] }));
        return Promise.resolve(plainTextResponse());
      });
      usePartyStore.setState({ activePartyId: 'party-1' });

      const ok = await usePartyStore.getState().updateCharacter('char-x', { hp: 12, level: 4 });

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('character_manage', {
        action: 'update',
        characterId: 'char-x',
        hp: 12,
        level: 4,
      });
    });

    it('NO-CLOBBER: malformed response is a failure; party details preserved', async () => {
      seedGoodState('party-1');
      const beforeDetail = usePartyStore.getState().partyDetails['party-1'];
      callTool.mockResolvedValue(plainTextResponse());

      const ok = await usePartyStore.getState().updateCharacter('char-frodo', { hp: 1 });

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBeTruthy();
      expect(usePartyStore.getState().partyDetails['party-1']).toBe(beforeDetail);
    });

    it('returns false when callTool REJECTS', async () => {
      callTool.mockRejectedValue(new Error('updchar rpc boom'));

      const ok = await usePartyStore.getState().updateCharacter('char-x', { hp: 1 });

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('updchar rpc boom');
    });
  });

  describe('moveParty (party_manage:move)', () => {
    it('calls party_manage with action=move and the target coordinates, then updates local position', async () => {
      seedGoodState('party-1');
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'move') return Promise.resolve(wrapParty({ success: true }));
        // syncPartyDetails refresh — return the party WITHOUT new coords so we
        // can observe the optimistic local update applied by moveParty itself.
        if (args.action === 'get') return Promise.resolve(plainTextResponse());
        return Promise.resolve(plainTextResponse());
      });

      const ok = await usePartyStore.getState().moveParty('party-1', 42, 99, 'Mordor', 'poi-7');

      expect(ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'move',
        partyId: 'party-1',
        targetX: 42,
        targetY: 99,
        locationName: 'Mordor',
        poiId: 'poi-7',
      });
      // Optimistic local position update (syncPartyDetails get returned no parseable body).
      const detail = usePartyStore.getState().partyDetails['party-1'];
      expect(detail.positionX).toBe(42);
      expect(detail.positionY).toBe(99);
      expect(detail.currentLocation).toBe('Mordor');
      expect(detail.currentPOI).toBe('poi-7');
    });

    it('NO-CLOBBER: missing success flag is a failure; position is NOT updated', async () => {
      seedGoodState('party-1');
      callTool.mockResolvedValue(wrapParty({ moved: 'yes' })); // no `success: true`

      const ok = await usePartyStore.getState().moveParty('party-1', 42, 99, 'Mordor');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBeTruthy();
      const detail = usePartyStore.getState().partyDetails['party-1'];
      // Seeded coords (10,20 / Rivendell) untouched.
      expect(detail.positionX).toBe(10);
      expect(detail.positionY).toBe(20);
      expect(detail.currentLocation).toBe('Rivendell');
    });

    it('surfaces an in-band error message', async () => {
      seedGoodState('party-1');
      callTool.mockResolvedValue(wrapParty({ error: 'blocked terrain' }));

      const ok = await usePartyStore.getState().moveParty('party-1', 1, 1, 'Wall');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('blocked terrain');
    });

    it('returns false when callTool REJECTS, leaving position intact', async () => {
      seedGoodState('party-1');
      callTool.mockRejectedValue(new Error('move rpc boom'));

      const ok = await usePartyStore.getState().moveParty('party-1', 1, 1, 'Wall');

      expect(ok).toBe(false);
      expect(usePartyStore.getState().error).toBe('move rpc boom');
      expect(usePartyStore.getState().partyDetails['party-1'].positionX).toBe(10);
    });
  });

  describe('getPartyPosition (party_manage:get_position)', () => {
    it('calls party_manage with action=get_position + partyId and maps the position', async () => {
      callTool.mockResolvedValue(
        wrapParty({ partyId: 'party-1', partyName: 'X', position: { x: 5, y: 6, locationName: 'Bree', poiId: 'inn' } })
      );

      const pos = await usePartyStore.getState().getPartyPosition('party-1');

      expect(callTool).toHaveBeenCalledWith('party_manage', { action: 'get_position', partyId: 'party-1' });
      expect(pos).toEqual({ x: 5, y: 6, locationName: 'Bree', poiId: 'inn' });
    });

    it('defaults locationName to Unknown when absent', async () => {
      callTool.mockResolvedValue(wrapParty({ position: { x: 0, y: 0 } }));

      const pos = await usePartyStore.getState().getPartyPosition('party-1');

      expect(pos).toEqual({ x: 0, y: 0, locationName: 'Unknown', poiId: undefined });
    });

    it('returns null when position.x is missing', async () => {
      callTool.mockResolvedValue(wrapParty({ position: { y: 6, locationName: 'Bree' } }));

      const pos = await usePartyStore.getState().getPartyPosition('party-1');
      expect(pos).toBeNull();
    });

    it('returns null on a malformed response (no throw)', async () => {
      callTool.mockResolvedValue(plainTextResponse());
      const pos = await usePartyStore.getState().getPartyPosition('party-1');
      expect(pos).toBeNull();
    });

    it('returns null (does not throw) when callTool REJECTS', async () => {
      callTool.mockRejectedValue(new Error('pos rpc boom'));
      const pos = await usePartyStore.getState().getPartyPosition('party-1');
      expect(pos).toBeNull();
    });
  });

  describe('getPartyContext (party_manage:get_context)', () => {
    it('calls party_manage with action=get_context, partyId and default verbosity=standard', async () => {
      callTool.mockResolvedValue(
        wrapParty({
          party: { id: 'party-1', name: 'Fellowship' },
          members: [{ name: 'Frodo', role: 'leader', class: 'Rogue', level: 5, hp: '30/30', characterId: 'c1' }],
          leader: { name: 'Frodo' },
          activeCharacter: { id: 'c1', name: 'Frodo' },
          summary: 'A weary band.',
        })
      );

      const ctx = await usePartyStore.getState().getPartyContext('party-1');

      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'get_context',
        partyId: 'party-1',
        verbosity: 'standard',
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.partyName).toBe('Fellowship');
      expect(ctx?.memberCount).toBe(1);
      expect(ctx?.leader).toBe('Frodo');
      expect(ctx?.activeCharacter).toBe('Frodo');
      expect(ctx?.members[0].isActive).toBe(true);
    });

    it('forwards an explicit verbosity', async () => {
      callTool.mockResolvedValue(wrapParty({ party: { id: 'party-1', name: 'X' }, members: [] }));

      await usePartyStore.getState().getPartyContext('party-1', 'detailed');

      expect(callTool).toHaveBeenCalledWith('party_manage', {
        action: 'get_context',
        partyId: 'party-1',
        verbosity: 'detailed',
      });
    });

    it('returns null on a malformed response', async () => {
      callTool.mockResolvedValue(plainTextResponse());
      const ctx = await usePartyStore.getState().getPartyContext('party-1');
      expect(ctx).toBeNull();
    });

    it('returns null (does not throw) when callTool REJECTS', async () => {
      callTool.mockRejectedValue(new Error('ctx rpc boom'));
      const ctx = await usePartyStore.getState().getPartyContext('party-1');
      expect(ctx).toBeNull();
    });
  });

  describe('syncParties (party_manage:list)', () => {
    it('calls party_manage with action=list and loads parties on success', async () => {
      callTool.mockImplementation((_name: string, args: any) => {
        if (args.action === 'list') {
          return Promise.resolve(
            wrapParty({ parties: [{ id: 'p1', name: 'Alpha', status: 'active' }], count: 1 })
          );
        }
        if (args.action === 'get') return Promise.resolve(wrapParty({ id: 'p1', name: 'Alpha', members: [] }));
        if (args.action === 'get_unassigned') return Promise.resolve(wrapParty({ characters: [], count: 0 }));
        return Promise.resolve(plainTextResponse());
      });

      await usePartyStore.getState().syncParties();

      expect(callTool).toHaveBeenCalledWith('party_manage', { action: 'list' });
      const state = usePartyStore.getState();
      expect(state.parties).toHaveLength(1);
      expect(state.parties[0].name).toBe('Alpha');
      // No active party was set → picks the active-status party.
      expect(state.activePartyId).toBe('p1');
    });

    it('NO-CLOBBER: malformed list response preserves existing parties and sets error', async () => {
      seedGoodState('party-1');
      const before = usePartyStore.getState().parties;
      callTool.mockResolvedValue(plainTextResponse());

      await usePartyStore.getState().syncParties();

      expect(usePartyStore.getState().parties).toBe(before);
      expect(usePartyStore.getState().error).toBeTruthy();
    });

    it('NO-CLOBBER: in-band error preserves existing parties', async () => {
      seedGoodState('party-1');
      const before = usePartyStore.getState().parties;
      callTool.mockResolvedValue(inBandPartyError('list failed'));

      await usePartyStore.getState().syncParties();

      expect(usePartyStore.getState().parties).toBe(before);
      expect(usePartyStore.getState().error).toBe('list failed');
    });

    it('is skipped (no callTool) while rate-limited', async () => {
      usePartyStore.setState({ isSyncing: false, lastSyncTime: Date.now() });
      await usePartyStore.getState().syncParties();
      expect(callTool).not.toHaveBeenCalled();
    });

    it('sets error (no crash) when callTool REJECTS', async () => {
      usePartyStore.setState({ isSyncing: false, lastSyncTime: 0 });
      callTool.mockRejectedValue(new Error('list rpc boom'));

      await usePartyStore.getState().syncParties();

      expect(usePartyStore.getState().error).toBe('list rpc boom');
      expect(usePartyStore.getState().isSyncing).toBe(false);
    });
  });

  describe('syncPartyDetails (party_manage:get)', () => {
    it('calls party_manage with action=get + partyId and stores parsed members', async () => {
      callTool.mockResolvedValue(
        wrapParty({
          id: 'party-1',
          name: 'Fellowship',
          members: [
            {
              id: 'm1',
              characterId: 'char-frodo',
              role: 'leader',
              isActive: true,
              character: { id: 'char-frodo', name: 'Frodo', level: 5, class: 'Rogue', hp: 30, maxHp: 30 },
            },
          ],
        })
      );

      await usePartyStore.getState().syncPartyDetails('party-1');

      expect(callTool).toHaveBeenCalledWith('party_manage', { action: 'get', partyId: 'party-1' });
      const detail = usePartyStore.getState().partyDetails['party-1'];
      expect(detail).toBeDefined();
      expect(detail.members).toHaveLength(1);
      expect(detail.members[0].character.name).toBe('Frodo');
    });

    it('NO-CLOBBER: malformed response leaves existing details untouched', async () => {
      seedGoodState('party-1');
      const before = usePartyStore.getState().partyDetails['party-1'];
      callTool.mockResolvedValue(plainTextResponse());

      await usePartyStore.getState().syncPartyDetails('party-1');

      expect(usePartyStore.getState().partyDetails['party-1']).toBe(before);
    });

    it('does not throw when callTool REJECTS (swallows error, no error state)', async () => {
      seedGoodState('party-1');
      callTool.mockRejectedValue(new Error('get rpc boom'));

      await expect(usePartyStore.getState().syncPartyDetails('party-1')).resolves.toBeUndefined();
      // syncPartyDetails only console.errors; it does NOT set store.error.
      expect(usePartyStore.getState().partyDetails['party-1']).toBeDefined();
    });
  });

  describe('syncUnassignedCharacters (party_manage:get_unassigned)', () => {
    it('calls party_manage with action=get_unassigned and stores parsed characters', async () => {
      callTool.mockResolvedValue(
        wrapParty({ characters: [{ id: 'char-sam', name: 'Sam', level: 4, class: 'Fighter', hp: 28, maxHp: 28 }], count: 1 })
      );

      await usePartyStore.getState().syncUnassignedCharacters();

      expect(callTool).toHaveBeenCalledWith('party_manage', { action: 'get_unassigned' });
      const chars = usePartyStore.getState().unassignedCharacters;
      expect(chars).toHaveLength(1);
      expect(chars[0].name).toBe('Sam');
    });

    it('NO-CLOBBER: malformed response preserves existing unassigned characters', async () => {
      seedGoodState('party-1');
      const before = usePartyStore.getState().unassignedCharacters;
      callTool.mockResolvedValue(plainTextResponse());

      await usePartyStore.getState().syncUnassignedCharacters();

      expect(usePartyStore.getState().unassignedCharacters).toBe(before);
    });

    it('NO-CLOBBER: in-band error preserves existing unassigned characters', async () => {
      seedGoodState('party-1');
      const before = usePartyStore.getState().unassignedCharacters;
      callTool.mockResolvedValue(inBandPartyError('unassigned failed'));

      await usePartyStore.getState().syncUnassignedCharacters();

      expect(usePartyStore.getState().unassignedCharacters).toBe(before);
    });

    it('does not throw when callTool REJECTS', async () => {
      seedGoodState('party-1');
      const before = usePartyStore.getState().unassignedCharacters;
      callTool.mockRejectedValue(new Error('unassigned rpc boom'));

      await expect(usePartyStore.getState().syncUnassignedCharacters()).resolves.toBeUndefined();
      expect(usePartyStore.getState().unassignedCharacters).toBe(before);
    });
  });
});
