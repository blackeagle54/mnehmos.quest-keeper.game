/**
 * Tests for the deterministic context condenser (Phase 5).
 *
 * The condenser replaces the destructive oldest-first truncator: instead of
 * dropping evicted turns, it summarizes them into ONE compact recap message so
 * narrative continuity survives a long session. Game state is DB-backed and
 * reloaded via tools, so this is purely about preserving narrative for the LLM.
 *
 * Invariants under test:
 *  - under budget => identity (unchanged history)
 *  - over budget  => system[0] preserved verbatim
 *  - over budget  => the most recent N turns kept verbatim (priority info)
 *  - over budget  => exactly ONE synthetic recap inserted right after system
 *  - recap preserves identifiable narrative text from evicted user/assistant turns
 *  - result total estimated tokens <= maxTokens
 *  - deterministic (same input => deep-equal output, twice)
 *  - tool pairing: never split assistant tool_use from its tool_result(s)
 *  - the final/most-recent message is never summarized away
 */
import { describe, it, expect } from 'vitest';
import {
  condenseHistory,
  heuristicStrategy,
  type CondenseOptions,
} from './contextCondenser';
import type { ChatMessage } from './types';

// char/4 estimator — mirrors LLMService.estimateTokens so the unit tests use the
// exact same accounting the production delegate will use.
const estimateTokens = (t: string): number => Math.ceil(t.length / 4);

const opts = (overrides: Partial<CondenseOptions> = {}): CondenseOptions => ({
  maxTokens: 1000,
  recentTurnsToKeep: 6,
  estimateTokens,
  ...overrides,
});

// Total estimated tokens for a history, counting content the same way the
// production trimmer does (stringify non-string content).
const totalTokens = (history: ChatMessage[]): number =>
  history.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(c);
  }, 0);

// A long block of narrative text so a handful of turns blows the budget.
const longText = (label: string, n = 200): string =>
  `${label}: ` + Array.from({ length: n }, (_, i) => `${label}-word${i}`).join(' ');

describe('condenseHistory — budget & identity', () => {
  it('returns history unchanged when already under budget', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Greetings, traveler.' },
    ];

    const result = condenseHistory(history, opts({ maxTokens: 100000 }));

    expect(result).toEqual(history);
  });

  it('keeps result total estimated tokens <= maxTokens when over budget', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      ...Array.from({ length: 20 }, (_, i): ChatMessage => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longText(`turn${i}`),
      })),
    ];

    const maxTokens = 800;
    const result = condenseHistory(history, opts({ maxTokens, recentTurnsToKeep: 4 }));

    expect(totalTokens(result)).toBeLessThanOrEqual(maxTokens);
  });
});

describe('condenseHistory — preservation invariants', () => {
  const makeHistory = (): ChatMessage[] => [
    { role: 'system', content: 'SYSTEM PROMPT: You are the Dungeon Master.' },
    { role: 'user', content: longText('the-tavern-meeting') },
    { role: 'assistant', content: longText('the-bartender-reply') },
    { role: 'user', content: longText('the-sewer-descent') },
    { role: 'assistant', content: longText('the-rat-swarm') },
    { role: 'user', content: longText('the-treasure-room') },
    { role: 'assistant', content: longText('the-dragon-hoard') },
    { role: 'user', content: 'recent-1 What do I see ahead?' },
    { role: 'assistant', content: 'recent-2 A narrow bridge over lava.' },
    { role: 'user', content: 'recent-3 I cross carefully.' },
    { role: 'assistant', content: 'recent-4 You reach the far side.' },
    { role: 'user', content: 'recent-5 final current message.' },
  ];

  it('preserves history[0] system message verbatim', () => {
    const history = makeHistory();
    const result = condenseHistory(history, opts({ maxTokens: 400, recentTurnsToKeep: 4 }));

    expect(result[0]).toEqual(history[0]);
    expect(result[0].role).toBe('system');
  });

  it('keeps the most recent recentTurnsToKeep messages verbatim (priority info)', () => {
    const history = makeHistory();
    const recentTurnsToKeep = 4;
    const result = condenseHistory(history, opts({ maxTokens: 400, recentTurnsToKeep }));

    const expectedRecent = history.slice(history.length - recentTurnsToKeep);
    const actualTail = result.slice(result.length - recentTurnsToKeep);
    expect(actualTail).toEqual(expectedRecent);
  });

  it('never summarizes away the final/most-recent message', () => {
    const history = makeHistory();
    const result = condenseHistory(history, opts({ maxTokens: 300, recentTurnsToKeep: 2 }));

    expect(result[result.length - 1]).toEqual(history[history.length - 1]);
  });

  it('inserts exactly ONE synthetic recap message right after the system message', () => {
    const history = makeHistory();
    const result = condenseHistory(history, opts({ maxTokens: 400, recentTurnsToKeep: 4 }));

    // Recap sits at index 1 (right after system[0]).
    const recap = result[1];
    expect(recap).toBeDefined();
    expect(recap.content).toContain('[Earlier this session');

    // And there is EXACTLY one such recap in the whole result.
    const recapCount = result.filter((m) => m.content.includes('[Earlier this session')).length;
    expect(recapCount).toBe(1);
  });

  it('recap preserves identifiable narrative text from the evicted turns', () => {
    const history = makeHistory();
    const result = condenseHistory(history, opts({ maxTokens: 400, recentTurnsToKeep: 4 }));

    const recap = result[1].content;
    // Deterministic heuristic assertion: labels from evicted user/assistant turns
    // must appear in the digest.
    expect(recap).toContain('the-tavern-meeting');
    expect(recap).toContain('the-dragon-hoard');
  });
});

describe('condenseHistory — determinism', () => {
  it('produces deep-equal output across two calls on the same input', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      ...Array.from({ length: 16 }, (_, i): ChatMessage => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longText(`event${i}`),
      })),
    ];

    const a = condenseHistory(history, opts({ maxTokens: 600, recentTurnsToKeep: 4 }));
    const b = condenseHistory(history, opts({ maxTokens: 600, recentTurnsToKeep: 4 }));

    expect(a).toEqual(b);
  });
});

describe('condenseHistory — tool pairing invariant', () => {
  // A tool_use (assistant.toolCalls) and its tool_result(s) (role:'tool' with the
  // matching toolCallId) must stay paired or be summarized together. Anthropic
  // hard-errors on an orphaned tool_result or tool_use.
  const makeToolHistory = (): ChatMessage[] => [
    { role: 'system', content: 'You are the DM.' },
    { role: 'user', content: longText('opening-scene') },
    { role: 'assistant', content: longText('describe-scene') },
    // --- tool pair buried in the evictable middle ---
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-abc', name: 'roll_dice', arguments: { sides: 20 } }],
    },
    { role: 'tool', content: longText('dice-result-payload'), toolCallId: 'call-abc' },
    // --- more middle narrative ---
    { role: 'user', content: longText('after-the-roll') },
    { role: 'assistant', content: longText('consequences') },
    // --- recent verbatim tail ---
    { role: 'user', content: 'recent What now?' },
    { role: 'assistant', content: 'You press onward.' },
    { role: 'user', content: 'final message' },
  ];

  // Collect every assistant tool_use id and every tool_result toolCallId.
  const pairingValid = (history: ChatMessage[]): boolean => {
    const toolUseIds = new Set<string>();
    for (const m of history) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.id) toolUseIds.add(tc.id);
        }
      }
    }
    const toolResultIds = new Set<string>();
    for (const m of history) {
      if (m.role === 'tool' && m.toolCallId) {
        toolResultIds.add(m.toolCallId);
      }
    }
    // No orphaned tool_result (a tool_result without its tool_use).
    for (const id of toolResultIds) {
      if (!toolUseIds.has(id)) return false;
    }
    // No orphaned tool_use (a tool_use without its tool_result).
    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) return false;
    }
    return true;
  };

  it('never leaves an orphaned tool_result or tool_use after condensing', () => {
    const history = makeToolHistory();
    expect(pairingValid(history)).toBe(true); // sanity: input is valid

    const result = condenseHistory(history, opts({ maxTokens: 300, recentTurnsToKeep: 3 }));

    expect(pairingValid(result)).toBe(true);
  });

  it('keeps a tool pair atomic: either both verbatim or both summarized', () => {
    const history = makeToolHistory();
    const result = condenseHistory(history, opts({ maxTokens: 300, recentTurnsToKeep: 3 }));

    const hasToolUse = result.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'call-abc')
    );
    const hasToolResult = result.some((m) => m.role === 'tool' && m.toolCallId === 'call-abc');

    // Either both survive verbatim, or neither does (summarized together).
    expect(hasToolUse).toBe(hasToolResult);
  });
});

describe('heuristicStrategy', () => {
  it('is pure: same evicted input yields identical summary', () => {
    const evicted: ChatMessage[] = [
      { role: 'user', content: 'I open the door.' },
      { role: 'assistant', content: 'The door creaks open to reveal a dark hall.' },
    ];

    expect(heuristicStrategy.summarize(evicted)).toBe(heuristicStrategy.summarize(evicted));
  });

  it('collapses verbose tool noise but keeps user/assistant narrative', () => {
    const evicted: ChatMessage[] = [
      { role: 'user', content: 'I attack the goblin.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'execute_combat_action', arguments: { x: 1 } }],
      },
      { role: 'tool', content: '{"hugely":"verbose","payload":"' + 'x'.repeat(5000) + '"}', toolCallId: 'c1' },
      { role: 'assistant', content: 'Your blade strikes true; the goblin falls.' },
    ];

    const summary = heuristicStrategy.summarize(evicted);

    expect(summary).toContain('I attack the goblin.');
    expect(summary).toContain('the goblin falls');
    // The 5000-char verbose tool payload must NOT be carried verbatim.
    expect(summary).not.toContain('x'.repeat(5000));
  });
});
