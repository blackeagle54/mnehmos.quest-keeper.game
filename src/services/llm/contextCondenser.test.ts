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
  messageTokens,
  RECAP_PREFIX,
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
    const c = typeof m.content === 'string' ? m.content : (JSON.stringify(m.content) ?? '');
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
    expect(recap.content).toContain(RECAP_PREFIX);

    // And there is EXACTLY one such recap in the whole result.
    const recapCount = result.filter(
      (m) => typeof m.content === 'string' && m.content.includes(RECAP_PREFIX)
    ).length;
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

describe('messageTokens — tool-call payload accounting', () => {
  // A pure assistant tool-use turn (empty prose, big toolCalls arguments) must NOT
  // count as ~0 tokens, otherwise the under-budget fast-path and tail budgeting
  // underestimate the real prompt size. The tool-call arguments are part of the
  // wire payload the provider sends, so they must be measured.
  it('counts an empty-content assistant message with a large toolCalls blob as > 0 tokens', () => {
    const bigArgs = { blob: 'y'.repeat(4000) };
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'big-1', name: 'do_thing', arguments: bigArgs }],
    };

    // > 0 (it must NOT be ~0), and large enough to reflect the 4000-char blob.
    expect(messageTokens(msg, estimateTokens)).toBeGreaterThan(500);
  });

  it('counts the toolCallId of a tool message toward its size', () => {
    const msg: ChatMessage = { role: 'tool', content: '', toolCallId: 'call-xyz' };
    expect(messageTokens(msg, estimateTokens)).toBeGreaterThan(0);
  });

  it('condenses a history of empty-prose tool-use turns rather than passing the under-budget fast-path', () => {
    const maxTokens = 200;
    const bigArgs = { blob: 'z'.repeat(2000) };
    // Each pure tool-use turn carries empty prose but a heavy toolCalls payload.
    // If toolCalls were ignored, totalTokens would read ~0 and the fast-path would
    // return the history unchanged (over the real budget). It must condense instead.
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      ...Array.from({ length: 10 }, (_, i): ChatMessage[] => [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `tc-${i}`, name: 'scan', arguments: bigArgs }],
        },
        { role: 'tool', content: 'ok', toolCallId: `tc-${i}` },
      ]).flat(),
      { role: 'user', content: 'final message' },
    ];

    const result = condenseHistory(history, opts({ maxTokens, recentTurnsToKeep: 2 }));

    // It must have actually condensed (dropped/summarized turns), not returned as-is.
    expect(result.length).toBeLessThan(history.length);
  });
});

describe('condenseHistory — estimator-aware recap truncation', () => {
  // The truncation helper must respect WHATEVER estimateTokens is supplied, not the
  // hardcoded char/4 heuristic. Use a 1-char-per-token estimator (text.length) and a
  // matching totalTokens so the budget is exercised under a non-char/4 estimator.
  const idEstimate = (t: string): number => t.length;
  const idTotal = (history: ChatMessage[]): number =>
    history.reduce((sum, m) => {
      const parts = [typeof m.content === 'string' ? m.content : (JSON.stringify(m.content) ?? '')];
      if (m.toolCalls?.length) parts.push(JSON.stringify(m.toolCalls) ?? '');
      if (m.role === 'tool' && m.toolCallId) parts.push(m.toolCallId);
      return sum + idEstimate(parts.join('\n'));
    }, 0);

  it('respects a non-char/4 estimator when truncating the recap', () => {
    // 1 token == 1 char here. With a tight budget the recap MUST be clipped using the
    // supplied estimator (not budget*4), so the whole result still fits.
    const maxTokens = 400;
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      ...Array.from({ length: 10 }, (_, i): ChatMessage => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longText(`scene${i}`),
      })),
      { role: 'user', content: 'recent question?' },
      { role: 'assistant', content: 'recent answer.' },
      { role: 'user', content: 'final message' },
    ];

    const result = condenseHistory(
      history,
      opts({ maxTokens, recentTurnsToKeep: 3, estimateTokens: idEstimate })
    );

    expect(idTotal(result)).toBeLessThanOrEqual(maxTokens);
  });
});

describe('condenseHistory — robustness / edge cases', () => {
  it('does not throw when a message has undefined content (a pure tool-call turn)', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      ...Array.from({ length: 12 }, (_, i): ChatMessage => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longText(`turn${i}`),
      })),
      // assistant turn with NO prose — only a tool call, so content is undefined.
      // JSON.stringify(undefined) === undefined (primitive), so token accounting
      // must not blow up on it.
      {
        role: 'assistant',
        content: undefined as unknown as string,
        toolCalls: [{ id: 'x1', name: 'look', arguments: {} }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'x1' },
      { role: 'user', content: 'final message' },
    ];

    expect(() =>
      condenseHistory(history, opts({ maxTokens: 400, recentTurnsToKeep: 2 }))
    ).not.toThrow();
  });

  it('never mutates the final/current message even when it alone exceeds maxTokens', () => {
    const maxTokens = 200;
    const finalContent = 'x'.repeat(maxTokens * 4 * 3);
    const finalMsg: ChatMessage = { role: 'user', content: finalContent };
    const history: ChatMessage[] = [
      { role: 'system', content: 'DM' },
      { role: 'user', content: longText('old-1') },
      { role: 'assistant', content: longText('old-2') },
      // The final (always-kept) message ALONE far exceeds the whole budget.
      finalMsg,
    ];

    const result = condenseHistory(history, opts({ maxTokens, recentTurnsToKeep: 1 }));

    // CRITICAL: never silently rewrite the user's active/final prompt. The final
    // message must be present VERBATIM (byte-for-byte), never truncated/mutated.
    expect(result[result.length - 1]).toEqual(finalMsg);
    expect(result[result.length - 1].content).toBe(finalContent);

    // The recap is the lossy, synthetic thing — it is dropped/truncated to reclaim
    // space, so there must be NO recap left when the final message alone blows the
    // whole budget.
    const recapCount = result.filter(
      (m) => typeof m.content === 'string' && m.content.includes(RECAP_PREFIX)
    ).length;
    expect(recapCount).toBe(0);

    // Accepted trade-off: a single REAL message larger than maxTokens means the
    // result may remain over budget — the user's words are never edited.
    expect(totalTokens(result)).toBeGreaterThan(maxTokens);
  });

  it('truncates only the synthetic recap (never a real message) to reclaim budget', () => {
    // System + protected tail fit under budget, but the recap of evicted turns pushes
    // it over. Only the recap may be clipped; the real tail messages stay verbatim.
    const maxTokens = 220;
    const tail: ChatMessage[] = [
      { role: 'user', content: 'recent-a short question' },
      { role: 'assistant', content: 'recent-b short answer' },
      { role: 'user', content: 'final short message' },
    ];
    const history: ChatMessage[] = [
      { role: 'system', content: 'You are the DM.' },
      ...Array.from({ length: 8 }, (_, i): ChatMessage => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longText(`evicted${i}`),
      })),
      ...tail,
    ];

    const result = condenseHistory(history, opts({ maxTokens, recentTurnsToKeep: 3 }));

    // Real tail messages survive verbatim — none of them is mutated.
    const actualTail = result.slice(result.length - tail.length);
    expect(actualTail).toEqual(tail);
    // And the whole result fits the budget (the recap absorbed the clipping).
    expect(totalTokens(result)).toBeLessThanOrEqual(maxTokens);
  });
});
