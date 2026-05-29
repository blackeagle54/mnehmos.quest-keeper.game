/**
 * Deterministic context condenser (Phase 5).
 *
 * Upgrades conversation token-budget enforcement from a destructive oldest-first
 * truncator into a condenser that SUMMARIZES evicted oldest turns into ONE compact
 * recap instead of dropping them. This is FRONTEND-ONLY narrative continuity: the
 * engine never stores the chat transcript and game state is DB-backed (reloaded via
 * tools), so the recap is explicitly NON-AUTHORITATIVE — the model must trust
 * DB-reloaded state over the recap (mechanical honesty).
 *
 * Design notes:
 *  - PURE / deterministic: same input => same output. No Date.now / Math.random.
 *  - Pluggable: `CondenseStrategy.summarize` is the seam an LLM-based summarizer can
 *    slot into later; `heuristicStrategy` is the deterministic default.
 *  - Recap role is **'user'**, not 'system'. AnthropicProvider strips ALL `role:'system'`
 *    messages out of the `messages` array (only the first becomes `body.system`), and
 *    GeminiProvider maps system->user; a mid-conversation system recap would be silently
 *    dropped by Anthropic. A 'user'-role recap survives every provider's mapping. The
 *    recap text is clearly labelled as a non-authoritative summary so its role is
 *    self-evident to the model.
 *  - TOOL PAIRING INVARIANT: an assistant `toolCalls` (tool_use) message and its
 *    matching `role:'tool'` result(s) (linked by toolCallId) are treated as ONE atomic
 *    unit. We either keep both verbatim or summarize both into the recap — never split
 *    them. Anthropic hard-errors on an orphaned tool_result or tool_use.
 */
import type { ChatMessage } from './types';

export interface CondenseOptions {
  /** Hard token ceiling for the returned history (recap counts toward this). */
  maxTokens: number;
  /** Most-recent messages always kept verbatim (priority info). */
  recentTurnsToKeep: number;
  /** Token estimator (production uses char/4). */
  estimateTokens: (t: string) => number;
}

/**
 * Pluggable summarization seam. The default is `heuristicStrategy` (deterministic);
 * an LLM-based strategy can be supplied later without touching the algorithm.
 */
export interface CondenseStrategy {
  summarize(evicted: ChatMessage[]): string;
}

/** Stable prefix that marks the synthetic recap message (asserted by tests). */
export const RECAP_PREFIX = '[Earlier this session';

/**
 * Normalize a message's content to a string for measurement / digesting.
 * NB: `JSON.stringify(undefined)` returns the primitive `undefined` (not a string),
 * so null/undefined content MUST be guarded here or downstream `.length`/`.trim()`
 * throws — e.g. an assistant turn that is a pure tool-call has no prose content.
 */
function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content) ?? '';
}

/** Estimate tokens for a single message's content the way the trimmer accounts for it. */
function messageTokens(msg: ChatMessage, estimateTokens: (t: string) => number): number {
  return estimateTokens(contentToText(msg.content));
}

/** Total estimated tokens for a list of messages. */
function totalTokens(history: ChatMessage[], estimateTokens: (t: string) => number): number {
  return history.reduce((sum, m) => sum + messageTokens(m, estimateTokens), 0);
}

/**
 * Collapse a single message into one compact, deterministic line of narrative.
 * Verbose tool payloads are stripped/collapsed; user/assistant prose is kept but
 * length-capped so a single huge turn can't dominate the recap.
 */
function digestMessage(msg: ChatMessage): string | null {
  // Tool results: collapse to a noise-free marker. The full payload was already
  // processed by the engine and lives in the DB — it has no narrative value here.
  if (msg.role === 'tool') {
    return null;
  }

  // Assistant tool-call messages: collapse to the tool names invoked (intent), not
  // the raw arguments. Keep any accompanying narrative text the assistant emitted.
  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const names = msg.toolCalls
      .map((tc) => tc.name)
      .filter(Boolean)
      .join(', ');
    const text = contentToText(msg.content).trim();
    const action = names ? `(used: ${names})` : '';
    const line = [text, action].filter(Boolean).join(' ').trim();
    return line || null;
  }

  // Plain user / assistant / (in-conversation) system narrative.
  const text = contentToText(msg.content).trim();
  if (!text) return null;

  // Cap a single turn so one verbose message can't swamp the digest. Kept short so
  // EVERY evicted turn stays represented in a bounded recap (narrative continuity
  // beats verbatim depth here — the DB holds the authoritative detail).
  const MAX_LINE_CHARS = 120;
  const capped = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + '…' : text;

  const speaker = msg.role === 'assistant' ? 'DM' : msg.role === 'user' ? 'Player' : msg.role;
  return `${speaker}: ${capped}`;
}

/**
 * Default deterministic strategy. Builds a compact recap by digesting each evicted
 * user/assistant turn into one line, dropping tool noise, and de-duplicating
 * consecutive identical lines. Pure: same input => identical output.
 */
export const heuristicStrategy: CondenseStrategy = {
  summarize(evicted: ChatMessage[]): string {
    const lines: string[] = [];
    let prev: string | null = null;
    for (const msg of evicted) {
      const line = digestMessage(msg);
      if (line && line !== prev) {
        lines.push(line);
        prev = line;
      }
    }
    const body = lines.join(' | ');
    return `${RECAP_PREFIX} (non-authoritative summary — trust live engine/DB state over this recap): ${body}]`;
  },
};

/**
 * An atomic unit of history: usually a single message, but an assistant tool_use
 * message is bundled with its following tool_result(s) so the pair can never split.
 */
interface HistoryUnit {
  messages: ChatMessage[];
  tokens: number;
}

/**
 * Partition non-system messages into atomic units, bundling each assistant
 * `toolCalls` message with the tool-result messages that answer it.
 */
function buildUnits(
  messages: ChatMessage[],
  estimateTokens: (t: string) => number
): HistoryUnit[] {
  const units: HistoryUnit[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Pull in the contiguous run of tool-result messages that follow. Anthropic
      // requires the tool_result(s) to immediately follow the tool_use, so a
      // contiguous sweep captures the matching results.
      const expectedIds = new Set(msg.toolCalls.map((tc) => tc.id).filter(Boolean) as string[]);
      const bundle: ChatMessage[] = [msg];
      let j = i + 1;
      while (
        j < messages.length &&
        messages[j].role === 'tool' &&
        (messages[j].toolCallId === undefined || expectedIds.has(messages[j].toolCallId as string))
      ) {
        bundle.push(messages[j]);
        j++;
      }
      units.push({ messages: bundle, tokens: totalTokens(bundle, estimateTokens) });
      i = j;
    } else {
      units.push({ messages: [msg], tokens: messageTokens(msg, estimateTokens) });
      i++;
    }
  }
  return units;
}

/**
 * Condense a chat history to fit `maxTokens`, summarizing evicted oldest turns into
 * ONE recap message instead of dropping them. Pure / deterministic.
 *
 * Algorithm:
 *  1. Under budget => return history unchanged (referential identity).
 *  2. Preserve history[0] verbatim if it's a system message.
 *  3. Always keep the most-recent `recentTurnsToKeep` messages verbatim (expanded so a
 *     tool pair is never split, and the final message is always included).
 *  4. Summarize the evictable middle/oldest units into ONE recap inserted right after
 *     the system message. Atomic tool units are summarized whole.
 *  5. If the protected tail itself overflows the budget, evict its OLDER units into the
 *     recap too (never the final unit — invariant #9), then deterministically truncate
 *     the recap so the whole result fits; the recap counts toward the budget.
 */
export function condenseHistory(
  history: ChatMessage[],
  opts: CondenseOptions,
  strategy: CondenseStrategy = heuristicStrategy
): ChatMessage[] {
  const { maxTokens, recentTurnsToKeep, estimateTokens } = opts;

  // 1. Under budget => identity.
  if (totalTokens(history, estimateTokens) <= maxTokens) {
    return history;
  }

  // 2. Preserve a leading system message verbatim.
  const hasSystem = history.length > 0 && history[0].role === 'system';
  const systemMsg = hasSystem ? history[0] : null;
  const nonSystem = hasSystem ? history.slice(1) : history.slice();

  // Partition the non-system body into atomic units (tool pairs bundled).
  const units = buildUnits(nonSystem, estimateTokens);

  // 3. Determine the protected recent tail by message count, then expand to whole
  //    units so a tool pair is never split. The final message is always in the tail.
  //    `keptUnitCount` = number of trailing units kept verbatim.
  let keptMessages = 0;
  let keptUnitCount = 0;
  for (let u = units.length - 1; u >= 0; u--) {
    if (keptMessages >= recentTurnsToKeep && keptUnitCount >= 1) break;
    keptMessages += units[u].messages.length;
    keptUnitCount++;
  }
  // Cap: never "keep" the entire body as tail if there is nothing to evict — but if
  // every unit is in the tail there is nothing to summarize, which is fine.
  keptUnitCount = Math.min(keptUnitCount, units.length);

  // 4 + 5. Pick how many trailing units to keep verbatim. Normally that's the protected
  //    tail (`keptUnitCount`). But if the verbatim tail itself overflows the budget, we
  //    shrink it from the OLD end — moving older tail units into the recap — until the
  //    verbatim portion fits (leaving room for at least a clipped recap). We never evict
  //    the final unit: it holds the most-recent message (invariant #9). The recap is
  //    then truncated to whatever budget remains.
  const systemTokens = systemMsg ? messageTokens(systemMsg, estimateTokens) : 0;

  // Reserve a little headroom so a non-empty recap can always be attached when there is
  // evicted content; this keeps the recap useful rather than starved to nothing.
  const RECAP_HEADROOM_TOKENS = 32;

  let keepCount = keptUnitCount; // trailing units kept verbatim
  const tailTokensFor = (count: number): number =>
    units.slice(units.length - count).reduce((s, u) => s + u.tokens, 0);

  // Shrink the verbatim tail (never below 1 unit) until system + tail leaves headroom.
  while (
    keepCount > 1 &&
    systemTokens + tailTokensFor(keepCount) + RECAP_HEADROOM_TOKENS > maxTokens
  ) {
    keepCount--;
  }

  const evictUpTo = Math.max(0, units.length - keepCount);
  const evictedMessages = units.slice(0, evictUpTo).flatMap((u) => u.messages);
  const keptUnits = units.slice(evictUpTo);
  const tailTokens = keptUnits.reduce((s, u) => s + u.tokens, 0);

  const out: ChatMessage[] = [];
  if (systemMsg) out.push(systemMsg);

  if (evictedMessages.length > 0) {
    let recap = strategy.summarize(evictedMessages);
    // Budget left for the recap. estimateTokens is char/4-style; convert the token
    // budget back to a char budget and hard-cap the recap so the whole result fits.
    const recapTokenBudget = maxTokens - systemTokens - tailTokens;
    if (recapTokenBudget <= 0) {
      // No room for any recap once priority info is accounted for — drop it.
      recap = '';
    } else if (estimateTokens(recap) > recapTokenBudget) {
      recap = truncateToTokenBudget(recap, recapTokenBudget, estimateTokens);
    }
    if (recap) {
      out.push({ role: 'user', content: recap });
    }
  }

  for (const unit of keptUnits) {
    out.push(...unit.messages);
  }

  // Last-resort safeguard: a single KEPT message (e.g. the final turn, which is
  // never evicted — invariant #9) can itself exceed the budget, so priority-info
  // preservation alone can't guarantee the fit. Hard-truncate the largest
  // STRING-content message until the whole result fits, mirroring the old
  // truncator. Structured/tool content is left intact so tool pairing stays
  // provider-valid. Bounded by a safety counter (each pass shrinks one message).
  let safety = out.length + 1;
  while (totalTokens(out, estimateTokens) > maxTokens && safety-- > 0) {
    let idx = -1;
    let largest = 0;
    for (let k = 0; k < out.length; k++) {
      if (out[k].role === 'system') continue;
      if (typeof out[k].content !== 'string') continue;
      const t = messageTokens(out[k], estimateTokens);
      if (t > largest) {
        largest = t;
        idx = k;
      }
    }
    if (idx < 0) break; // nothing safely sliceable (only system/structured left)
    const overTokens = totalTokens(out, estimateTokens) - maxTokens;
    const content = out[idx].content as string;
    const newLen = Math.max(0, content.length - (overTokens * 4 + 16));
    out[idx] = { ...out[idx], content: content.slice(0, newLen) + '…[truncated]' };
  }

  return out;
}

/**
 * Deterministically shrink `text` so its estimated tokens fit `tokenBudget`.
 * Reserves room for a clear truncation marker and the recap's closing bracket so the
 * result still reads as a (clipped) non-authoritative recap.
 */
function truncateToTokenBudget(
  text: string,
  tokenBudget: number,
  estimateTokens: (t: string) => number
): string {
  const suffix = '…]';
  // Binary-search-free deterministic clamp: start from the char budget the estimator
  // implies, then back off until it fits (handles non-linear estimators safely).
  let charBudget = Math.max(0, tokenBudget * 4 - suffix.length);
  let candidate = text.slice(0, charBudget) + suffix;
  while (charBudget > 0 && estimateTokens(candidate) > tokenBudget) {
    charBudget = Math.floor(charBudget * 0.9);
    candidate = text.slice(0, charBudget) + suffix;
  }
  return charBudget > 0 ? candidate : '';
}
