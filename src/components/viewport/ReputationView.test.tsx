/**
 * Tests for ReputationView.
 *
 * Mocks the stores (AchievementsView.test.tsx pattern) so we can drive render
 * state without a live bridge. Asserts factions render with standing badges and
 * rep bars, the value shows, the totals/factionCount header renders, an
 * untracked faction defaults to Neutral/0, and empty/loading/error/no-character
 * states don't crash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// --- Store mocks (must precede component import) -----------------------------

const syncReputation = vi.fn();

function freshFactions() {
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
    {
      // Untracked faction: no per-character entry -> Neutral / 0.
      id: 'untracked-order',
      name: 'Untracked Order',
      description: 'Unknown to you.',
      value: 0,
      standing: 'Neutral',
    },
  ];
}

function freshEntry() {
  return {
    factions: freshFactions(),
    factionCount: 3,
    characterName: 'Aria',
  };
}

let reputationStoreState: any;
function resetReputationState() {
  reputationStoreState = {
    reputationByCharacter: { 'char-1': freshEntry() },
    selectedFaction: null,
    isLoading: false,
    error: null,
    syncReputation,
  };
}

vi.mock('../../stores/reputationStore', () => ({
  useReputationStore: vi.fn((selector: any) => selector(reputationStoreState)),
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

import { ReputationView } from './ReputationView';

describe('ReputationView', () => {
  beforeEach(() => {
    syncReputation.mockClear();
    gameStateState = { activeCharacterId: 'char-1' };
    resetReputationState();
  });

  it('calls syncReputation on mount with the active character id', () => {
    render(<ReputationView />);
    expect(syncReputation).toHaveBeenCalledWith('char-1');
  });

  it('renders each faction by name', () => {
    render(<ReputationView />);
    expect(screen.getByText('Merchants Guild')).toBeInTheDocument();
    expect(screen.getByText("Thieves' Den")).toBeInTheDocument();
    expect(screen.getByText('Untracked Order')).toBeInTheDocument();

    const cards = screen.getAllByTestId('faction-card');
    expect(cards.length).toBe(3);
  });

  it('renders a standing badge for each faction', () => {
    render(<ReputationView />);
    const badges = screen.getAllByTestId('faction-standing');
    expect(badges.length).toBe(3);
    expect(screen.getByText('Honored')).toBeInTheDocument();
    expect(screen.getByText('Hostile')).toBeInTheDocument();
  });

  it('renders a rep bar for each faction', () => {
    render(<ReputationView />);
    const bars = screen.getAllByTestId('faction-bar');
    expect(bars.length).toBe(3);
  });

  it('shows the numeric value for each faction', () => {
    render(<ReputationView />);
    expect(screen.getByText(/350/)).toBeInTheDocument();
    expect(screen.getByText(/-200/)).toBeInTheDocument();
  });

  it('renders a totals header with the factionCount', () => {
    render(<ReputationView />);
    const totals = screen.getByTestId('reputation-totals');
    expect(totals).toBeInTheDocument();
    expect(totals).toHaveTextContent(/3/);
  });

  it('renders an untracked faction as Neutral / 0', () => {
    render(<ReputationView />);
    const card = screen.getByText('Untracked Order').closest('[data-testid="faction-card"]');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('Neutral');
    expect(card).toHaveTextContent('0');
  });

  it('renders an empty state without crashing when no active character', () => {
    gameStateState = { activeCharacterId: null };
    reputationStoreState.reputationByCharacter = {};
    expect(() => render(<ReputationView />)).not.toThrow();
    expect(screen.getByText(/NO CHARACTER SELECTED/i)).toBeInTheDocument();
  });

  it('renders a loading state without crashing', () => {
    reputationStoreState = {
      ...reputationStoreState,
      isLoading: true,
      reputationByCharacter: {},
    };
    expect(() => render(<ReputationView />)).not.toThrow();
  });

  it('renders an error banner without crashing', () => {
    reputationStoreState = { ...reputationStoreState, error: 'Failed to load reputation' };
    render(<ReputationView />);
    expect(screen.getByText(/Failed to load reputation/i)).toBeInTheDocument();
  });

  it('renders an empty faction list state without crashing', () => {
    reputationStoreState.reputationByCharacter = {
      'char-1': { factions: [], factionCount: 0, characterName: 'Aria' },
    };
    expect(() => render(<ReputationView />)).not.toThrow();
    expect(screen.getByText(/No factions defined yet/i)).toBeInTheDocument();
  });

  it('defaults a faction missing value/standing annotations to Neutral / 0 in the UI', () => {
    // Even if the store hands a faction with no value/standing (untracked), the
    // view must render Neutral / 0 rather than crashing or showing blanks.
    reputationStoreState.reputationByCharacter = {
      'char-1': {
        factions: [
          { id: 'bare', name: 'Bare Faction', description: 'No annotations.' },
        ],
        factionCount: 1,
        characterName: 'Aria',
      },
    };

    render(<ReputationView />);

    const card = screen.getByText('Bare Faction').closest('[data-testid="faction-card"]');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('Neutral');
    expect(card).toHaveTextContent('0');
  });
});
