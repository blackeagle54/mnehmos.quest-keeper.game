/**
 * Tests for LLMService post-tool-call state synchronization (handleBatchToolSync).
 *
 * Finding 3 (CodeRabbit PR#6): `achievement_manage` was added to GAME_STATE_TOOLS,
 * but that path only calls useGameStateStore.syncState() and never refreshes the
 * achievementStore. handleBatchToolSync must instead detect achievement_manage and
 * call achievementStore.syncAchievements(activeCharacterId), resolving the active
 * character id from useGameStateStore (the same source the rest of LLMService uses).
 *
 * handleBatchToolSync is private; we invoke it via a typed cast. It dynamically
 * imports the stores, so we mock those modules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the stores that handleBatchToolSync dynamically imports ------------

const syncState = vi.fn().mockResolvedValue(undefined);
const syncCombatState = vi.fn().mockResolvedValue(undefined);
const syncAchievements = vi.fn().mockResolvedValue(undefined);

let activeCharacterId: string | null = 'char-1';

vi.mock('../../stores/gameStateStore', () => ({
  useGameStateStore: {
    getState: () => ({ activeCharacterId, syncState }),
  },
}));

vi.mock('../../stores/combatStore', () => ({
  useCombatStore: {
    getState: () => ({ syncCombatState }),
  },
}));

vi.mock('../../stores/achievementStore', () => ({
  useAchievementStore: {
    getState: () => ({ syncAchievements }),
  },
}));

// The settings store is imported at module load by LLMService — mock minimally.
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      selectedProvider: 'openai',
      apiKeys: { openai: 'k' },
      getSelectedModel: () => 'gpt-x',
    }),
  },
}));

// mcpClient is imported at module load — mock the bridge surface.
vi.mock('../mcpClient', () => ({
  mcpManager: { gameStateClient: { callTool: vi.fn(), listTools: vi.fn() } },
}));

import { llmService } from './LLMService';

// Typed access to the private batch-sync routine.
const runSync = (toolNames: string[]): Promise<void> =>
  (llmService as unknown as { handleBatchToolSync: (n: string[]) => Promise<void> }).handleBatchToolSync(
    toolNames
  );

describe('LLMService.handleBatchToolSync — achievement sync (finding 3)', () => {
  beforeEach(() => {
    syncState.mockClear();
    syncCombatState.mockClear();
    syncAchievements.mockClear();
    activeCharacterId = 'char-1';
  });

  it('triggers an achievement sync for the active character when achievement_manage was used', async () => {
    await runSync(['achievement_manage']);
    expect(syncAchievements).toHaveBeenCalledWith('char-1');
  });

  it('does NOT route achievement_manage through the generic gameState syncState path', async () => {
    // achievement_manage must be handled by the dedicated achievement branch, not
    // by a redundant gameState sync (which would not refresh the achievementStore).
    await runSync(['achievement_manage']);
    expect(syncState).not.toHaveBeenCalled();
  });

  it('skips the achievement sync when there is no active character', async () => {
    activeCharacterId = null;
    await runSync(['achievement_manage']);
    expect(syncAchievements).not.toHaveBeenCalled();
  });

  it('still triggers a gameState sync for a genuine game-state tool', async () => {
    await runSync(['update_character']);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(syncAchievements).not.toHaveBeenCalled();
  });

  it('syncs both game state and achievements when a mix of tools is used', async () => {
    await runSync(['update_character', 'achievement_manage']);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(syncAchievements).toHaveBeenCalledWith('char-1');
  });
});
