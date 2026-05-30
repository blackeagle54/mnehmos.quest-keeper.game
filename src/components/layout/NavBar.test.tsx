/**
 * Tests for NavBar.
 *
 * The nav collapses to a w-16 rail on narrow viewports where the label is
 * `hidden md:block` — only the icon renders. So every destination needs a
 * DISTINCT glyph; two tabs sharing one icon are indistinguishable when collapsed.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../stores/uiStore', () => ({
  useUIStore: () => ({
    activeTab: 'adventure',
    setActiveTab: vi.fn(),
    setPendingCommand: vi.fn(),
  }),
}));

import { NavBar } from './NavBar';

// The icon is the first <span> inside a NavItem button; the label span follows.
const iconOf = (btn: HTMLElement) => btn.querySelector('span')?.textContent ?? '';

describe('NavBar', () => {
  it('gives Workflows a non-empty icon that is DISTINCT from Settings', () => {
    render(<NavBar />);
    const workflows = screen.getByTitle('Workflows');
    const settings = screen.getByTitle('Settings');

    expect(iconOf(workflows)).not.toBe('');
    // Collapsed rail shows icon-only — a shared glyph makes the two tabs ambiguous.
    expect(iconOf(workflows)).not.toBe(iconOf(settings));
  });

  it('renders no two nav destinations with the same icon (collapsed-rail disambiguation)', () => {
    render(<NavBar />);
    const labels = [
      'Adventure', 'Combat', 'Character', 'World Map', 'Journal',
      'Skills', 'Chains', 'Achievements', 'Reputation', 'Workflows', 'Settings',
    ];
    const icons = labels.map((l) => iconOf(screen.getByTitle(l)));
    expect(new Set(icons).size).toBe(icons.length);
  });
});
