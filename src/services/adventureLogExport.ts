/**
 * Markdown adventure-log export (Phase 5).
 *
 * PURE FRONTEND: renders a human-readable Markdown adventure log from the
 * active campaign's chat transcript plus lightweight game-state summaries that
 * are already in-store. No engine / MCP calls are made here — this is a render
 * of current state, not a fetch.
 *
 * Design notes:
 *  - `buildAdventureLogMarkdown` is PURE and DETERMINISTIC. The "generated at"
 *    timestamp is INJECTED (never Date.now()), so the same input always yields
 *    byte-identical output and is trivially testable.
 *  - `exportAdventureLogToFile` is the impure boundary: it reads the stores,
 *    reads the clock once (or accepts an injected `now`), calls the pure
 *    renderer, and performs the file I/O.
 */
import type { Message } from '../stores/chatStore';

// --- Public option/summary shapes --------------------------------------------

/** A party member as rendered into the summary section. */
export interface AdventureLogPartyMember {
  name: string;
  class?: string;
  level?: number;
}

/** A quest as rendered into the summary section. */
export interface AdventureLogQuest {
  name: string;
  status?: string;
}

export interface BuildAdventureLogOptions {
  /** Campaign / session display name used in the title. */
  sessionName: string;
  /** Chat transcript to render (in chronological order). */
  messages: Message[];
  /**
   * Generation timestamp (ms epoch), INJECTED for determinism.
   * Never read the clock inside the pure renderer.
   */
  generatedAt: number;
  /** Optional party roster for the summary section. */
  party?: AdventureLogPartyMember[];
  /** Optional quest list for the summary section. */
  quests?: AdventureLogQuest[];
}

// --- Pure rendering helpers ---------------------------------------------------

const PLAYER_LABEL = '**Player:**';
const DM_LABEL = '**DM:**';

/**
 * Map a message sender to its transcript label. Unknown/system senders map to
 * a neutral "System" label and are only emitted when they carry real content.
 */
function labelForSender(sender: Message['sender']): string {
  switch (sender) {
    case 'user':
      return PLAYER_LABEL;
    case 'ai':
      return DM_LABEL;
    default:
      return '**System:**';
  }
}

/**
 * Decide whether a message contributes a transcript block. Tool-call messages
 * and empty/system noise are collapsed out so the log reads like prose rather
 * than a debug dump.
 */
function isRenderableTurn(m: Message): boolean {
  if (m.isToolCall) return false; // collapse raw tool calls
  if (m.type === 'error') return false; // engine/UI errors are not story
  const content = (m.content ?? '').trim();
  return content.length > 0;
}

/**
 * Render a single message's content as a transcript block. Content is emitted
 * as-is (Markdown-friendly); we only trim surrounding whitespace so blocks are
 * uniformly spaced.
 */
function renderTurn(m: Message): string {
  const label = labelForSender(m.sender);
  const content = (m.content ?? '').trim();
  return `${label}\n\n${content}`;
}

/** Slugify a campaign name into a filesystem-safe filename stem. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumerics -> single dash
    .replace(/^-+|-+$/g, ''); // trim leading/trailing dashes
  return slug || 'adventure-log';
}

// --- Pure document builder ----------------------------------------------------

/**
 * Render a complete Markdown adventure log. Pure & deterministic: identical
 * options (including `generatedAt`) always produce identical output.
 */
export function buildAdventureLogMarkdown(
  opts: BuildAdventureLogOptions
): string {
  const { sessionName, messages, generatedAt, party, quests } = opts;

  const lines: string[] = [];

  // Title + metadata.
  lines.push(`# ${sessionName} — Adventure Log`);
  lines.push('');
  lines.push(`_Generated: ${new Date(generatedAt).toISOString()}_`);
  lines.push('');

  // Optional summary section (party + active quests).
  const hasParty = Array.isArray(party) && party.length > 0;
  const activeQuests = (quests ?? []).filter(
    (q) => (q.status ?? 'active').toLowerCase() === 'active'
  );
  const hasQuests = activeQuests.length > 0;

  if (hasParty || hasQuests) {
    lines.push('## Summary');
    lines.push('');

    if (hasParty) {
      lines.push('### Party');
      lines.push('');
      for (const member of party!) {
        const bits: string[] = [];
        if (member.level !== undefined) bits.push(`Level ${member.level}`);
        if (member.class) bits.push(member.class);
        const suffix = bits.length > 0 ? ` — ${bits.join(' ')}` : '';
        lines.push(`- **${member.name}**${suffix}`);
      }
      lines.push('');
    }

    if (hasQuests) {
      lines.push('### Active Quests');
      lines.push('');
      for (const quest of activeQuests) {
        lines.push(`- ${quest.name}`);
      }
      lines.push('');
    }
  }

  // Transcript.
  lines.push('## Transcript');
  lines.push('');

  const turns = messages.filter(isRenderableTurn);
  if (turns.length === 0) {
    lines.push('_No transcript yet._');
  } else {
    const blocks = turns.map(renderTurn);
    lines.push(blocks.join('\n\n---\n\n'));
  }
  lines.push('');

  return lines.join('\n');
}

// --- Impure export boundary ---------------------------------------------------

/**
 * Gather the active campaign's transcript + summaries from the stores, render
 * the Markdown log, and write it under `<appDataDir>/exports/<slug>.md`.
 *
 * @param name Optional override for the campaign/file name (defaults to the
 *             active session's name).
 * @param now  Optional injected timestamp (ms epoch). Defaults to Date.now()
 *             read ONCE here at the boundary — never inside the pure renderer.
 * @returns The absolute path of the written file.
 * @throws  If there is no active session (so the UI can show an error state).
 */
export async function exportAdventureLogToFile(
  name?: string,
  now: number = Date.now()
): Promise<string> {
  // Lazy store imports keep this module tree-shakeable and test-mockable.
  const { useSessionStore } = await import('../stores/sessionStore');
  const { useChatStore } = await import('../stores/chatStore');
  const { useGameStateStore } = await import('../stores/gameStateStore');
  const { usePartyStore } = await import('../stores/partyStore');

  const activeSession = useSessionStore.getState().getActiveSession();
  if (!activeSession) {
    throw new Error('No active campaign session to export.');
  }

  const sessionName = name?.trim() || activeSession.name || 'Adventure Log';

  // Messages: prefer the campaign's linked chat session; fall back to current.
  const chat = useChatStore.getState();
  let messages: Message[] = [];
  if (activeSession.chatSessionId) {
    const linked = chat.sessions.find(
      (s) => s.id === activeSession.chatSessionId
    );
    messages = linked?.messages ?? [];
  }
  if (messages.length === 0) {
    messages = chat.getMessages();
  }

  // Party summary from in-store active party.
  const activeParty = usePartyStore.getState().getActiveParty();
  const party: AdventureLogPartyMember[] | undefined = activeParty?.members?.map(
    (m) => ({
      name: m.character.name,
      class: m.character.class,
      level: m.character.level,
    })
  );

  // Quest summary from in-store game state.
  const quests: AdventureLogQuest[] | undefined = useGameStateStore
    .getState()
    .quests?.map((q) => ({ name: q.name || q.title, status: q.status }));

  const markdown = buildAdventureLogMarkdown({
    sessionName,
    messages,
    generatedAt: now,
    party,
    quests,
  });

  // I/O: write under <appDataDir>/exports/<slug>.md (mirrors mcpClient pattern).
  const { appDataDir } = await import('@tauri-apps/api/path');
  const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');

  const dir = await appDataDir();
  const exportsDir = `${dir}/exports`;
  await mkdir(exportsDir, { recursive: true });

  const filePath = `${exportsDir}/${slugify(sessionName)}.md`;
  await writeTextFile(filePath, markdown);

  return filePath;
}
