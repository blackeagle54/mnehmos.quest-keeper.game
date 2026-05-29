/**
 * Tests for AchievementsView.
 *
 * Mocks the stores (SkillsView.test.tsx pattern) so we can drive render state
 * without a live bridge. Asserts unlocked + locked cards render, points and
 * progress show, the category filter narrows the list, totals header renders,
 * and empty/loading/error/no-character states don't crash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// --- Store mocks (must precede component import) -----------------------------

const syncAchievements = vi.fn();
const setSelectedCategory = vi.fn();

function freshCatalog() {
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
    {
      id: 'secret',
      name: '???',
      description: 'Hidden until found.',
      category: 'secret',
      points: 100,
      hidden: true,
      unlocked: false,
    },
  ];
}

function freshEntry() {
  return {
    catalog: freshCatalog(),
    totalCount: 3,
    unlockedCount: 1,
    totalPoints: 10,
    characterName: 'Aria',
  };
}

let achievementStoreState: any;
function resetAchievementState() {
  achievementStoreState = {
    achievementsByCharacter: { 'char-1': freshEntry() },
    selectedCategory: null,
    isLoading: false,
    error: null,
    syncAchievements,
    setSelectedCategory,
  };
}

vi.mock('../../stores/achievementStore', () => ({
  useAchievementStore: vi.fn((selector: any) => selector(achievementStoreState)),
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

import { AchievementsView } from './AchievementsView';

describe('AchievementsView', () => {
  beforeEach(() => {
    syncAchievements.mockClear();
    setSelectedCategory.mockClear();
    gameStateState = { activeCharacterId: 'char-1' };
    resetAchievementState();
  });

  it('calls syncAchievements on mount with the active character id', () => {
    render(<AchievementsView />);
    expect(syncAchievements).toHaveBeenCalledWith('char-1');
  });

  it('renders an unlocked achievement and a locked achievement', () => {
    render(<AchievementsView />);
    expect(screen.getByText('First Blood')).toBeInTheDocument();
    expect(screen.getByText('Collector')).toBeInTheDocument();

    const cards = screen.getAllByTestId('achievement-card');
    expect(cards.length).toBe(3);

    const unlocked = screen.getAllByTestId('achievement-card-unlocked');
    const locked = screen.getAllByTestId('achievement-card-locked');
    expect(unlocked).toHaveLength(1);
    expect(locked).toHaveLength(2);
  });

  it('shows points for achievements', () => {
    render(<AchievementsView />);
    expect(screen.getByText(/10\s*PTS/i)).toBeInTheDocument();
    expect(screen.getByText(/25\s*PTS/i)).toBeInTheDocument();
  });

  it('renders a progress bar for an incremental, in-progress achievement', () => {
    render(<AchievementsView />);
    const bars = screen.getAllByTestId('achievement-progress');
    // Only the incremental "Collector" (progress/target) gets a bar.
    expect(bars).toHaveLength(1);
    expect(screen.getByText(/40\s*\/\s*100/)).toBeInTheDocument();
  });

  it('renders a totals header with unlocked/total counts and total points', () => {
    render(<AchievementsView />);
    const totals = screen.getByTestId('achievement-totals');
    expect(totals).toBeInTheDocument();
    expect(totals).toHaveTextContent(/1\s*\/\s*3/);
    expect(totals).toHaveTextContent(/10/);
  });

  it('renders a hidden+locked achievement as a generic ??? card', () => {
    render(<AchievementsView />);
    // The hidden, still-locked achievement renders its masked name.
    expect(screen.getByText('???')).toBeInTheDocument();
  });

  it('filters the list by category when a filter is chosen', () => {
    achievementStoreState.selectedCategory = 'combat';
    render(<AchievementsView />);
    // Only the combat achievement remains visible.
    expect(screen.getByText('First Blood')).toBeInTheDocument();
    expect(screen.queryByText('Collector')).not.toBeInTheDocument();
  });

  it('invokes setSelectedCategory when a category control is clicked', () => {
    render(<AchievementsView />);
    const combatBtn = screen.getByTestId('achievement-filter-combat');
    fireEvent.click(combatBtn);
    expect(setSelectedCategory).toHaveBeenCalledWith('combat');
  });

  it('renders an empty state without crashing when no active character', () => {
    gameStateState = { activeCharacterId: null };
    achievementStoreState.achievementsByCharacter = {};
    expect(() => render(<AchievementsView />)).not.toThrow();
    expect(screen.getByText(/NO CHARACTER SELECTED/i)).toBeInTheDocument();
  });

  it('renders a loading state without crashing', () => {
    achievementStoreState = {
      ...achievementStoreState,
      isLoading: true,
      achievementsByCharacter: {},
    };
    expect(() => render(<AchievementsView />)).not.toThrow();
  });

  it('renders an error banner without crashing', () => {
    achievementStoreState = { ...achievementStoreState, error: 'Failed to load achievements' };
    render(<AchievementsView />);
    expect(screen.getByText(/Failed to load achievements/i)).toBeInTheDocument();
  });

  it('renders an empty catalog state without crashing', () => {
    achievementStoreState.achievementsByCharacter = {
      'char-1': { catalog: [], totalCount: 0, unlockedCount: 0, totalPoints: 0, characterName: 'Aria' },
    };
    expect(() => render(<AchievementsView />)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Finding 1: a hidden + locked (masked) achievement must NOT leak its progress
  // — even when it carries a target — via the progress bar / numbers.
  // ---------------------------------------------------------------------------
  it('does NOT render a progress bar or numbers for a hidden+locked achievement that has a target', () => {
    achievementStoreState.achievementsByCharacter = {
      'char-1': {
        catalog: [
          {
            id: 'secret-incremental',
            name: 'Secret Hoarder',
            description: 'Hidden incremental.',
            category: 'secret',
            points: 100,
            target: 50,
            progress: 30, // would leak "30 / 50" if not masked
            hidden: true,
            unlocked: false,
          },
        ],
        totalCount: 1,
        unlockedCount: 0,
        totalPoints: 0,
        characterName: 'Aria',
      },
    };

    render(<AchievementsView />);

    // No progress bar element and no progress numbers for the masked card.
    expect(screen.queryByTestId('achievement-progress')).not.toBeInTheDocument();
    expect(screen.queryByText(/30\s*\/\s*50/)).not.toBeInTheDocument();
    // It still renders as a masked mystery card.
    expect(screen.getByText('???')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Finding 2: a persisted selectedCategory that no longer exists in the catalog
  // must NOT leave a silent blank grid — show a category-empty message instead,
  // distinct from the catalog-empty message.
  // ---------------------------------------------------------------------------
  it('falls back to showing all achievements (no blank grid) when the persisted filter is stale', () => {
    // The catalog has categories combat/exploration/secret, but a stale persisted
    // filter points at a category that no longer exists in this catalog. The view
    // must NOT silently render a blank grid — the stale filter resolves to "all".
    achievementStoreState.selectedCategory = 'deprecated-category';

    render(<AchievementsView />);

    // Full catalog renders rather than an unexplained blank grid.
    expect(screen.getAllByTestId('achievement-card')).toHaveLength(3);
    expect(screen.getByText('First Blood')).toBeInTheDocument();
    expect(screen.getByText('Collector')).toBeInTheDocument();
    // Neither empty-state message shows, because cards are visible.
    expect(screen.queryByText(/No achievements defined yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No achievements in this category/i)).not.toBeInTheDocument();
    // The "All" control reflects the effective (resolved) filter being active.
    expect(screen.getByTestId('achievement-filter-all').className).toMatch(/bg-terminal-green/);
  });

  it('shows the catalog-empty message (not the category message) when the catalog is genuinely empty', () => {
    achievementStoreState.achievementsByCharacter = {
      'char-1': { catalog: [], totalCount: 0, unlockedCount: 0, totalPoints: 0, characterName: 'Aria' },
    };

    render(<AchievementsView />);

    expect(screen.getByText(/No achievements defined yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/No achievements in this category/i)).not.toBeInTheDocument();
  });

  it('applies a valid (non-stale) category filter and renders only its cards', () => {
    achievementStoreState.selectedCategory = 'exploration';
    render(<AchievementsView />);
    // Only the exploration achievement (Collector) is visible.
    expect(screen.getByText('Collector')).toBeInTheDocument();
    expect(screen.queryByText('First Blood')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('achievement-card')).toHaveLength(1);
    // Neither empty-state message shows.
    expect(screen.queryByText(/No achievements defined yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No achievements in this category/i)).not.toBeInTheDocument();
  });
});
