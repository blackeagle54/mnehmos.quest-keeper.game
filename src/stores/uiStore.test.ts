import { describe, it, expect } from 'vitest';
import { ALL_TABS, useUIStore } from './uiStore';

describe('uiStore navigable tabs', () => {
  it('ALL_TABS includes every navigable tab incl. the Phase-3 additions (no whitelist drift)', () => {
    // Regression guard: the terminal `/tab` whitelist previously drifted behind
    // newly-added tabs (skills/chains/achievements/reputation were unreachable).
    // ALL_TABS is now the single source for both the ActiveTab type and that
    // whitelist, so every real tab must be present here.
    for (const tab of ['skills', 'chains', 'achievements', 'reputation'] as const) {
      expect(ALL_TABS).toContain(tab);
    }
    expect(ALL_TABS).toContain('settings');
    // No accidental duplicates.
    expect(new Set(ALL_TABS).size).toBe(ALL_TABS.length);
  });

  it('setActiveTab accepts every tab declared in ALL_TABS', () => {
    for (const tab of ALL_TABS) {
      useUIStore.getState().setActiveTab(tab);
      expect(useUIStore.getState().activeTab).toBe(tab);
    }
  });
});
