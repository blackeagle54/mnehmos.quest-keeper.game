/**
 * Tests for QuestChainView.
 *
 * Mocks the stores (SkillsView.test.tsx pattern) so we can drive render state
 * without a live bridge. Asserts chain quest nodes + their unlock states render
 * and that clicking a branch choice button triggers selectBranch with the
 * SOURCE questId (not the chainId).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// --- Store mocks (must precede component import) -----------------------------

const loadChain = vi.fn();
const listChains = vi.fn();
const selectBranch = vi.fn();

function sampleGraph() {
  return {
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
        status: 'completed',
        unlockState: 'completed',
        prerequisites: ['q-a'],
        skillRequirements: [],
        nextQuests: [],
        branches: [
          { choiceId: 'good', label: 'Side with the rebels', questId: 'q-c' },
          { choiceId: 'evil', label: 'Side with the empire', questId: 'q-d' },
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

let chainStoreState: any;

vi.mock('../../stores/questChainStore', () => ({
  useQuestChainStore: vi.fn((selector: any) => selector(chainStoreState)),
}));

let gameStateState: any = { activeCharacterId: 'char-1' };
vi.mock('../../stores/gameStateStore', () => ({
  useGameStateStore: vi.fn((selector: any) => selector(gameStateState)),
}));

vi.mock('../../stores/partyStore', () => ({
  usePartyStore: vi.fn((selector: any) =>
    selector({ getActiveCharacterMember: () => null })
  ),
}));

import { QuestChainView } from './QuestChainView';

describe('QuestChainView', () => {
  beforeEach(() => {
    loadChain.mockClear();
    listChains.mockClear();
    selectBranch.mockClear();
    gameStateState = { activeCharacterId: 'char-1' };
    chainStoreState = {
      chainsByCharacter: { 'char-1': { 'storyline-1': sampleGraph() } },
      chainList: [{ chainId: 'storyline-1', questCount: 3, completedCount: 2 }],
      selectedChainId: null,
      isLoading: false,
      error: null,
      lastResult: null,
      listChains,
      loadChain,
      selectBranch,
      setSelectedChainId: vi.fn(),
    };
  });

  it('renders each chain quest node by name', () => {
    render(<QuestChainView />);
    expect(screen.getByText(/The Beginning/i)).toBeInTheDocument();
    expect(screen.getByText(/The Crossroads/i)).toBeInTheDocument();
    expect(screen.getByText(/The High Road/i)).toBeInTheDocument();
  });

  it('renders the unlock-state badge for each node', () => {
    const { container } = render(<QuestChainView />);
    const nodes = container.querySelectorAll('[data-testid="chain-quest-node"]');
    expect(nodes).toHaveLength(3);
    // completed + locked badges should be visible somewhere.
    expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/locked/i)).toBeInTheDocument();
  });

  it('renders branch choice buttons for a completed quest that has branches', () => {
    render(<QuestChainView />);
    expect(screen.getByText(/Side with the rebels/i)).toBeInTheDocument();
    expect(screen.getByText(/Side with the empire/i)).toBeInTheDocument();
  });

  it('clicking a branch button calls selectBranch with the SOURCE questId, choiceId, characterId', () => {
    render(<QuestChainView />);
    fireEvent.click(screen.getByText(/Side with the rebels/i));
    // Must pass the source (branching) quest id q-b, not the chainId.
    expect(selectBranch).toHaveBeenCalledWith('q-b', 'good', 'char-1');
  });

  it('triggers a chain sync (listChains + loadChain) on mount', () => {
    render(<QuestChainView />);
    expect(listChains).toHaveBeenCalled();
  });

  it('renders an empty state without crashing when no active character', () => {
    gameStateState = { activeCharacterId: null };
    chainStoreState.chainsByCharacter = {};
    expect(() => render(<QuestChainView />)).not.toThrow();
  });

  it('renders an error banner when the store has an error', () => {
    chainStoreState = { ...chainStoreState, error: 'No chain found' };
    render(<QuestChainView />);
    expect(screen.getByText(/No chain found/i)).toBeInTheDocument();
  });

  it('renders a loading state without crashing', () => {
    chainStoreState = { ...chainStoreState, isLoading: true, chainsByCharacter: {} };
    expect(() => render(<QuestChainView />)).not.toThrow();
  });

  it('shows "Requires:" gating text ONLY for locked quests', () => {
    const graph = sampleGraph() as any;
    // Locked node with a skill gate -> must show Requires.
    graph.quests[2].skillRequirements = [{ skill: 'Lockpicking', level: 5 }];
    // Available (NOT locked) node with a skill gate -> must NOT show Requires.
    graph.quests[0].unlockState = 'available';
    graph.quests[0].skillRequirements = [{ skill: 'Diplomacy', level: 3 }];
    chainStoreState.chainsByCharacter = { 'char-1': { 'storyline-1': graph } };

    render(<QuestChainView />);

    // The locked quest surfaces its gate.
    expect(screen.getByText(/Lockpicking Lv5/i)).toBeInTheDocument();
    // The non-locked quest does NOT, so its (now-moot) requirement is hidden.
    expect(screen.queryByText(/Diplomacy Lv3/i)).not.toBeInTheDocument();
  });

  it('renders chainId-less graphs with unique keys (no key collision)', () => {
    // Two graphs without a chainId would have collided on the old shared
    // 'singleton' key; with the index/quest-id fallback they render distinctly.
    const g1 = sampleGraph();
    const g2 = sampleGraph();
    delete (g1 as any).chainId;
    delete (g2 as any).chainId;
    g2.quests = g2.quests.map((q) => ({ ...q, id: `${q.id}-2`, name: `${q.name} II` }));
    chainStoreState.chainsByCharacter = {
      'char-1': { 'graph-1': g1, 'graph-2': g2 },
    };

    const { container } = render(<QuestChainView />);
    expect(container.querySelectorAll('[data-testid="chain-section"]')).toHaveLength(2);
    expect(screen.getByText('The Beginning')).toBeInTheDocument();
    expect(screen.getByText('The Beginning II')).toBeInTheDocument();
  });
});
