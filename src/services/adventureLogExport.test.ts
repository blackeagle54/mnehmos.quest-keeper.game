/**
 * Tests for the Markdown adventure-log export slice (Phase 5).
 *
 * `buildAdventureLogMarkdown` is a PURE/deterministic renderer: same input +
 * the same injected timestamp must always produce byte-identical output. It
 * never calls Date.now()/Math.random() (the timestamp is passed in).
 *
 * `exportAdventureLogToFile` gathers the active session's messages + state
 * summaries from the stores, renders the markdown, and writes it under
 * `<appDataDir>/exports/<slug>.md`. It must surface an absent active session
 * as a thrown/rejected error WITHOUT writing a file, so the UI layer can show
 * an error state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../stores/chatStore';

// --- Tauri fs/path mocks (must precede the module-under-test import) ----------

const mkdir = vi.fn(async (_path: string, _opts?: unknown) => {});
const writeTextFile = vi.fn(async (_path: string, _contents: string) => {});
const appDataDir = vi.fn(async () => '/mock/app/data');

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: (...args: unknown[]) => mkdir(...(args as [string, unknown])),
  writeTextFile: (...args: unknown[]) =>
    writeTextFile(...(args as [string, string])),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: (...args: unknown[]) => appDataDir(...(args as [])),
}));

// --- Store mocks --------------------------------------------------------------

let chatState: any;
let sessionState: any;
let gameStateState: any;
let partyState: any;

vi.mock('../stores/chatStore', () => ({
  useChatStore: { getState: () => chatState },
}));

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: { getState: () => sessionState },
}));

vi.mock('../stores/gameStateStore', () => ({
  useGameStateStore: { getState: () => gameStateState },
}));

vi.mock('../stores/partyStore', () => ({
  usePartyStore: { getState: () => partyState },
}));

import {
  buildAdventureLogMarkdown,
  exportAdventureLogToFile,
} from './adventureLogExport';

// --- Fixtures -----------------------------------------------------------------

function msg(partial: Partial<Message>): Message {
  return {
    id: partial.id ?? 'm1',
    sender: partial.sender ?? 'user',
    content: partial.content ?? '',
    timestamp: partial.timestamp ?? 0,
    ...partial,
  };
}

const FIXED_TS = 1700000000000; // 2023-11-14T22:13:20.000Z (deterministic)

describe('buildAdventureLogMarkdown', () => {
  it('renders a title from the session name', () => {
    const md = buildAdventureLogMarkdown({
      sessionName: 'The Sunless Citadel',
      messages: [],
      generatedAt: FIXED_TS,
    });
    expect(md).toContain('# The Sunless Citadel — Adventure Log');
  });

  it('renders a deterministic metadata line from the injected timestamp', () => {
    const md = buildAdventureLogMarkdown({
      sessionName: 'Campaign',
      messages: [],
      generatedAt: FIXED_TS,
    });
    // ISO timestamp of FIXED_TS, injected (NOT Date.now()).
    expect(md).toContain(new Date(FIXED_TS).toISOString());
  });

  it('is deterministic: same input + timestamp => identical output', () => {
    const opts = {
      sessionName: 'Campaign',
      messages: [
        msg({ id: 'a', sender: 'user' as const, content: 'I open the door.' }),
        msg({ id: 'b', sender: 'ai' as const, content: 'It creaks open.' }),
      ],
      generatedAt: FIXED_TS,
    };
    expect(buildAdventureLogMarkdown(opts)).toBe(buildAdventureLogMarkdown(opts));
  });

  it('maps user -> **Player:** and ai -> **DM:** labels in the transcript', () => {
    const md = buildAdventureLogMarkdown({
      sessionName: 'Campaign',
      messages: [
        msg({ id: 'a', sender: 'user', content: 'I draw my sword.' }),
        msg({ id: 'b', sender: 'ai', content: 'The goblin snarls.' }),
      ],
      generatedAt: FIXED_TS,
    });
    expect(md).toContain('**Player:**');
    expect(md).toContain('I draw my sword.');
    expect(md).toContain('**DM:**');
    expect(md).toContain('The goblin snarls.');
  });

  it('handles an empty transcript without throwing', () => {
    const md = buildAdventureLogMarkdown({
      sessionName: 'Empty Run',
      messages: [],
      generatedAt: FIXED_TS,
    });
    expect(typeof md).toBe('string');
    expect(md).toContain('# Empty Run — Adventure Log');
    // Communicates emptiness rather than rendering an empty transcript.
    expect(md.toLowerCase()).toContain('no transcript');
  });

  it('includes a party summary section when party members are provided', () => {
    const md = buildAdventureLogMarkdown({
      sessionName: 'Campaign',
      messages: [],
      generatedAt: FIXED_TS,
      party: [
        { name: 'Aria', class: 'Wizard', level: 5 },
        { name: 'Borin', class: 'Fighter', level: 4 },
      ],
    });
    expect(md).toContain('Aria');
    expect(md).toContain('Wizard');
    expect(md).toContain('Borin');
  });

  it('includes active quests in the summary when provided', () => {
    const md = buildAdventureLogMarkdown({
      sessionName: 'Campaign',
      messages: [],
      generatedAt: FIXED_TS,
      quests: [
        { name: 'Find the Amulet', status: 'active' },
        { name: 'Old Done Quest', status: 'completed' },
      ],
    });
    expect(md).toContain('Find the Amulet');
  });

  it('omits or collapses tool-call / system messages (no raw tool noise)', () => {
    const md = buildAdventureLogMarkdown({
      sessionName: 'Campaign',
      messages: [
        msg({ id: 'a', sender: 'user', content: 'I attack.' }),
        msg({
          id: 'tool',
          sender: 'ai',
          content: '',
          isToolCall: true,
          toolName: 'roll_dice',
          toolArguments: { sides: 20 },
          toolResponse: '17',
        }),
        msg({ id: 'b', sender: 'ai', content: 'You hit!' }),
      ],
      generatedAt: FIXED_TS,
    });
    // The player/DM lines survive; raw tool argument JSON does not leak.
    expect(md).toContain('I attack.');
    expect(md).toContain('You hit!');
    expect(md).not.toContain('"sides"');
  });
});

describe('exportAdventureLogToFile', () => {
  beforeEach(() => {
    mkdir.mockClear();
    writeTextFile.mockClear();
    appDataDir.mockClear();

    chatState = {
      sessions: [
        {
          id: 'chat-1',
          title: 'chat',
          messages: [
            msg({ id: 'a', sender: 'user', content: 'Hello DM.' }),
            msg({ id: 'b', sender: 'ai', content: 'Welcome, adventurer.' }),
          ],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      currentSessionId: 'chat-1',
      getMessages: () => chatState.sessions[0].messages,
    };

    sessionState = {
      getActiveSession: () => ({
        id: 'session-1',
        name: 'The Lost Mine',
        partyId: 'party-1',
        worldId: 'world-1',
        chatSessionId: 'chat-1',
        activeCharacterId: 'char-1',
      }),
    };

    gameStateState = {
      quests: [{ name: 'Rescue Gundren', status: 'active' }],
      activeCharacter: { name: 'Hero', level: 3, class: 'Ranger' },
    };

    partyState = {
      getActiveParty: () => ({
        members: [
          { character: { name: 'Hero', class: 'Ranger', level: 3 } },
        ],
      }),
    };
  });

  it('writes a .md file under exports/ with the rendered markdown', async () => {
    const path = await exportAdventureLogToFile(undefined, FIXED_TS);

    expect(appDataDir).toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining('/exports'),
      expect.objectContaining({ recursive: true })
    );
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [writtenPath, writtenContents] = writeTextFile.mock.calls[0];
    expect(writtenPath).toMatch(/\/exports\/.*\.md$/);
    expect(writtenPath).toBe(path);

    // Contents must equal what the pure renderer produces for the same state.
    const expected = buildAdventureLogMarkdown({
      sessionName: 'The Lost Mine',
      messages: chatState.sessions[0].messages,
      generatedAt: FIXED_TS,
      party: [{ name: 'Hero', class: 'Ranger', level: 3 }],
      quests: [{ name: 'Rescue Gundren', status: 'active' }],
    });
    expect(writtenContents).toBe(expected);
  });

  it('slugifies the campaign name into the filename', async () => {
    const path = await exportAdventureLogToFile(undefined, FIXED_TS);
    expect(path.toLowerCase()).toContain('the-lost-mine');
  });

  it('rejects (without writing) when there is no active session', async () => {
    sessionState = { getActiveSession: () => null };

    await expect(exportAdventureLogToFile(undefined, FIXED_TS)).rejects.toThrow();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
