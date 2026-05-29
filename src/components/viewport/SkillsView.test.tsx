/**
 * Tests for SkillsView.
 *
 * Mocks the stores (CombatHUD.test.tsx pattern) so we can drive render state
 * without a live bridge. Asserts the five skill bars render and that an empty /
 * loading state doesn't crash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// --- Store mocks (must precede component import) -----------------------------

const syncSkills = vi.fn();

let skillStoreState: any = {
  skillsByCharacter: {
    'char-1': {
      combat: { xp: 100, level: 2 },
      magic: { xp: 0, level: 1 },
      crafting: { xp: 1154, level: 10 },
      gathering: { xp: 0, level: 1 },
      social: { xp: 13034431, level: 99 },
    },
  },
  isLoading: false,
  error: null,
  syncSkills,
  getSkills: (id: string) => skillStoreState.skillsByCharacter[id] ?? null,
};

vi.mock('../../stores/skillStore', () => ({
  useSkillStore: vi.fn((selector: any) => selector(skillStoreState)),
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

import { SkillsView } from './SkillsView';

describe('SkillsView', () => {
  beforeEach(() => {
    syncSkills.mockClear();
    gameStateState = { activeCharacterId: 'char-1' };
    skillStoreState = {
      skillsByCharacter: {
        'char-1': {
          combat: { xp: 100, level: 2 },
          magic: { xp: 0, level: 1 },
          crafting: { xp: 1154, level: 10 },
          gathering: { xp: 0, level: 1 },
          social: { xp: 13034431, level: 99 },
        },
      },
      isLoading: false,
      error: null,
      syncSkills,
      getSkills: (id: string) => skillStoreState.skillsByCharacter[id] ?? null,
    };
  });

  it('renders all five skill names', () => {
    render(<SkillsView />);
    expect(screen.getByText(/combat/i)).toBeInTheDocument();
    expect(screen.getByText(/magic/i)).toBeInTheDocument();
    expect(screen.getByText(/crafting/i)).toBeInTheDocument();
    expect(screen.getByText(/gathering/i)).toBeInTheDocument();
    expect(screen.getByText(/social/i)).toBeInTheDocument();
  });

  it('renders a progress bar element per skill', () => {
    const { container } = render(<SkillsView />);
    const bars = container.querySelectorAll('[data-testid="skill-bar"]');
    expect(bars).toHaveLength(5);
  });

  it('shows each skill level', () => {
    render(<SkillsView />);
    // combat level 2 and crafting level 10 and social level 99 should appear
    expect(screen.getByText(/LVL\s*2/i)).toBeInTheDocument();
    expect(screen.getByText(/LVL\s*10/i)).toBeInTheDocument();
    expect(screen.getByText(/LVL\s*99/i)).toBeInTheDocument();
  });

  it('calls syncSkills on mount with the active character id', () => {
    render(<SkillsView />);
    expect(syncSkills).toHaveBeenCalledWith('char-1');
  });

  it('renders an empty state without crashing when no active character', () => {
    gameStateState = { activeCharacterId: null };
    skillStoreState.skillsByCharacter = {};
    expect(() => render(<SkillsView />)).not.toThrow();
  });

  it('renders a loading state without crashing', () => {
    skillStoreState = { ...skillStoreState, isLoading: true, skillsByCharacter: {} };
    expect(() => render(<SkillsView />)).not.toThrow();
  });
});
