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
const syncReputation = vi.fn().mockResolvedValue(undefined);

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

vi.mock('../../stores/reputationStore', () => ({
  useReputationStore: {
    getState: () => ({ syncReputation }),
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
import type { ChatMessage } from './types';

// Typed access to the private batch-sync routine.
const runSync = (toolNames: string[]): Promise<void> =>
  (llmService as unknown as { handleBatchToolSync: (n: string[]) => Promise<void> }).handleBatchToolSync(
    toolNames
  );

// Typed access to the private budget enforcer (now backed by condenseHistory).
const trimHistory = (history: ChatMessage[], maxTokens?: number): ChatMessage[] =>
  (
    llmService as unknown as {
      trimHistory: (h: ChatMessage[], m?: number) => ChatMessage[];
    }
  ).trimHistory(history, maxTokens);

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

describe('LLMService.handleBatchToolSync — reputation sync', () => {
  // Mirrors the achievement sync branch: reputation_manage must NOT route through
  // the generic gameState syncState path (which never refreshes reputationStore);
  // it gets its own reputationStore.syncReputation(activeCharacterId) branch.
  beforeEach(() => {
    syncState.mockClear();
    syncCombatState.mockClear();
    syncAchievements.mockClear();
    syncReputation.mockClear();
    activeCharacterId = 'char-1';
  });

  it('triggers a reputation sync for the active character when reputation_manage was used', async () => {
    await runSync(['reputation_manage']);
    expect(syncReputation).toHaveBeenCalledWith('char-1');
  });

  it('does NOT route reputation_manage through the generic gameState syncState path', async () => {
    await runSync(['reputation_manage']);
    expect(syncState).not.toHaveBeenCalled();
  });

  it('skips the reputation sync when there is no active character', async () => {
    activeCharacterId = null;
    await runSync(['reputation_manage']);
    expect(syncReputation).not.toHaveBeenCalled();
  });

  it('still triggers a gameState sync for a genuine game-state tool', async () => {
    await runSync(['update_character']);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(syncReputation).not.toHaveBeenCalled();
  });

  it('syncs both game state and reputation when a mix of tools is used', async () => {
    await runSync(['update_character', 'reputation_manage']);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(syncReputation).toHaveBeenCalledWith('char-1');
  });
});

describe('LLMService.trimHistory — context condensing (Phase 5)', () => {
  // trimHistory now delegates to condenseHistory: an over-budget history must come
  // back CONDENSED (one recap, under budget) rather than hard-truncated with the old
  // '[...truncated due to token limit]' marker.
  const longTurn = (label: string): string =>
    `${label}: ` + Array.from({ length: 300 }, (_, i) => `${label}-w${i}`).join(' ');

  const overBudgetHistory = (): ChatMessage[] => [
    { role: 'system', content: 'You are the Dungeon Master.' },
    { role: 'user', content: longTurn('arrived-at-the-gates') },
    { role: 'assistant', content: longTurn('the-guard-challenges-you') },
    { role: 'user', content: longTurn('bribed-the-guard') },
    { role: 'assistant', content: longTurn('entered-the-keep') },
    { role: 'user', content: longTurn('found-the-throne-room') },
    { role: 'assistant', content: longTurn('the-usurper-king-speaks') },
    { role: 'user', content: 'I draw my sword.' },
    { role: 'assistant', content: 'Steel rings out across the hall.' },
    { role: 'user', content: 'What does the king do?' },
  ];

  const estTokens = (history: ChatMessage[]): number =>
    history.reduce((sum, m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + Math.ceil(c.length / 4);
    }, 0);

  it('condenses an over-budget history under budget with a recap (not hard truncation)', () => {
    const history = overBudgetHistory();
    const maxTokens = 2000;

    // Sanity: the fixture really does exceed the budget.
    expect(estTokens(history)).toBeGreaterThan(maxTokens);

    const result = trimHistory(history, maxTokens);

    // Under budget.
    expect(estTokens(result)).toBeLessThanOrEqual(maxTokens);

    // A recap is present (condensed, not dropped).
    const recap = result.find((m) => m.content.includes('[Earlier this session'));
    expect(recap).toBeDefined();

    // System preserved verbatim at the head, and the most-recent message survives.
    expect(result[0]).toEqual(history[0]);
    expect(result[result.length - 1]).toEqual(history[history.length - 1]);

    // It must NOT use the old destructive truncation marker.
    const usedOldTruncation = result.some((m) =>
      m.content.includes('[...truncated due to token limit]')
    );
    expect(usedOldTruncation).toBe(false);
  });

  it('returns an under-budget history unchanged', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      { role: 'user', content: 'Hello.' },
      { role: 'assistant', content: 'Welcome, adventurer.' },
    ];
    expect(trimHistory(history, 100000)).toEqual(history);
  });
});
