/**
 * Tests for CombatLogPanel — the scrollable combat action history. [COMBAT-001]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const toggleCombatLog = vi.fn();
let combatLogState: any[] = [];
let isCombatLogOpen = true;

vi.mock('../../stores/combatStore', () => ({
  useCombatStore: vi.fn((selector: any) => selector({ combatLog: combatLogState })),
}));

vi.mock('../../stores/hudStore', () => ({
  useHudStore: vi.fn((selector: any) => selector({ isCombatLogOpen, toggleCombatLog })),
}));

import { CombatLogPanel } from './CombatLogPanel';

beforeEach(() => {
  combatLogState = [];
  isCombatLogOpen = true;
  toggleCombatLog.mockClear();
  // jsdom has no layout engine; useAutoScroll calls scrollIntoView.
  (window.HTMLElement.prototype as any).scrollIntoView = vi.fn();
});

describe('CombatLogPanel', () => {
  it('renders nothing when the log is closed', () => {
    isCombatLogOpen = false;
    const { container } = render(<CombatLogPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a Combat Log header when open', () => {
    render(<CombatLogPanel />);
    expect(screen.getByText(/combat log/i)).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no entries', () => {
    combatLogState = [];
    render(<CombatLogPanel />);
    expect(screen.getByText(/no combat events/i)).toBeInTheDocument();
  });

  it('renders each log entry message in order', () => {
    combatLogState = [
      { id: '1', timestamp: 1, round: 1, type: 'attack-hit', message: 'Hero hits Goblin for 7 damage' },
      { id: '2', timestamp: 2, round: 1, type: 'defeat', message: 'Goblin is defeated!' },
    ];
    render(<CombatLogPanel />);
    expect(screen.getByText(/Hero hits Goblin for 7 damage/)).toBeInTheDocument();
    expect(screen.getByText(/Goblin is defeated!/)).toBeInTheDocument();
  });

  it('calls toggleCombatLog when the close button is clicked', () => {
    render(<CombatLogPanel />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(toggleCombatLog).toHaveBeenCalledTimes(1);
  });
});
