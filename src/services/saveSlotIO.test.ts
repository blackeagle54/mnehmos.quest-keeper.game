/**
 * Tests for saveSlotIO.ts — the manual campaign save/load-to-file slice (Phase 5).
 *
 * A .qksave file is a portable per-campaign bundle:
 *   { schemaVersion, savedAt, sessionMeta, chat, notes, engine }
 * where `engine` is the engine's save_manage export bundle (entity rows) and the
 * rest is the frontend session/chat/notes layer.
 *
 * The engine bridge is mcpManager.gameStateClient.callTool(tool, args); it
 * REJECTS on a JSON-RPC error and embeds its JSON payload in
 * `<!-- SAVE_MANAGE_JSON ... SAVE_MANAGE_JSON -->`. File I/O goes through
 * @tauri-apps/plugin-fs (mkdir/writeTextFile/readTextFile/readDir) under
 * <appDataDir>/saves/. There is NO native file dialog installed, so v1 keeps
 * saves in that appdata dir and lists them via readDir.
 *
 * This file wires its OWN mocks (plugin-fs, api/path, mcpClient + the frontend
 * stores) so nothing here touches a live bridge or real disk. Mocks MUST be
 * declared before importing the module under test (lazy imports resolve to them).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- File I/O + path mocks ---------------------------------------------------

const mkdir = vi.fn(async (_path: string, _opts?: { recursive?: boolean }) => {});
const writeTextFile = vi.fn(async (_path: string, _contents: string) => {});
const readTextFile = vi.fn(async (_path: string): Promise<string> => '');
const readDir = vi.fn(
  async (_path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> => []
);

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir,
  writeTextFile,
  readTextFile,
  readDir,
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/mock/app/data'),
}));

// --- Engine bridge mock ------------------------------------------------------

const callTool = vi.fn();
vi.mock('./mcpClient', () => ({
  mcpManager: {
    gameStateClient: {
      callTool,
    },
  },
}));

// --- Frontend store mocks ----------------------------------------------------

const getActiveSession = vi.fn();
// Mirror the real store: when options.id is supplied, the created session carries
// it (so an import can preserve a saved CampaignSession identity); otherwise a
// fresh id is generated. Tests assert createSession was called WITH the saved id.
const createSession = vi.fn((options?: any) => options?.id ?? 'new-session-id');
const updateSession = vi.fn();
const switchSession = vi.fn(async () => {});
let sessions: any[] = [];

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessions,
      getActiveSession,
      createSession,
      updateSession,
      switchSession,
    }),
  },
}));

const chatGetMessages = vi.fn(() => [] as any[]);
const chatCreateSession = vi.fn(() => 'new-chat-id');
const chatSwitchSession = vi.fn();
const updateSessionTitle = vi.fn();
let chatSessions: any[] = [];

vi.mock('../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      sessions: chatSessions,
      getMessages: chatGetMessages,
      createSession: chatCreateSession,
      switchSession: chatSwitchSession,
      updateSessionTitle,
    }),
    setState: vi.fn((updater: any) => {
      const next = typeof updater === 'function' ? updater({ sessions: chatSessions }) : updater;
      if (next?.sessions) chatSessions = next.sessions;
    }),
  },
}));

const importNotes = vi.fn();
let notes: any[] = [];

vi.mock('../stores/notesStore', () => ({
  useNotesStore: {
    getState: () => ({
      notes,
      importNotes,
    }),
  },
}));

import {
  buildCampaignBundle,
  exportActiveCampaignToFile,
  listSaveFiles,
  importCampaignFromFile,
  SAVE_SCHEMA_VERSION,
} from './saveSlotIO';

// --- Fixtures ----------------------------------------------------------------

function activeSessionFixture() {
  return {
    id: 'session_1',
    name: 'The Ironwood Saga',
    description: 'A grim adventure',
    partyId: 'party_1',
    worldId: 'world_1',
    chatSessionId: 'chat_1',
    activeCharacterId: 'char_1',
    createdAt: 1000,
    lastPlayedAt: 2000,
    playtime: 5000,
    snapshot: { partyName: 'The Party', level: 3, locationName: 'Ironwood', memberCount: 2 },
  };
}

function engineBundleFixture() {
  return {
    schemaVersion: 1,
    worlds: [{ id: 'world_1', name: 'Aethelgard' }],
    parties: [{ id: 'party_1', world_id: 'world_1' }],
    characters: [{ id: 'char_1', name: 'Aria' }],
  };
}

// The engine wraps its JSON payload in markdown + a SAVE_MANAGE_JSON comment
// block (RichFormatter.embedJson(parsed, 'SAVE_MANAGE')). Shape responses the
// way the live tool returns them so the extraction path is exercised.
function wrapSaveManage(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Some markdown header\n<!-- SAVE_MANAGE_JSON\n${JSON.stringify(payload)}\nSAVE_MANAGE_JSON -->\n`,
      },
    ],
  };
}

function exportResponse(bundle = engineBundleFixture()) {
  return wrapSaveManage({
    success: true,
    actionType: 'export',
    schemaVersion: 1,
    worldId: 'world_1',
    counts: { characters: 1, parties: 1 },
    bundle,
  });
}

function importResponse() {
  return wrapSaveManage({
    success: true,
    actionType: 'import',
    schemaVersion: 1,
    imported: { worlds: 1, parties: 1, characters: 1 },
  });
}

function validSaveFileBundle() {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: 1234567890,
    sessionMeta: activeSessionFixture(),
    chat: [
      { id: 'm1', sender: 'user', content: 'Hello', timestamp: 1 },
      { id: 'm2', sender: 'ai', content: 'Greetings', timestamp: 2 },
    ],
    notes: [{ id: 'note1', title: 'Lore', content: 'stuff', category: 'lore', tags: [], author: 'player', createdAt: 1, updatedAt: 1 }],
    engine: engineBundleFixture(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessions = [];
  chatSessions = [];
  notes = [];
  getActiveSession.mockReturnValue(activeSessionFixture());
  chatGetMessages.mockReturnValue([
    { id: 'm1', sender: 'user', content: 'Hello', timestamp: 1 },
  ]);
  notes = [{ id: 'note1', title: 'Lore', content: 'stuff', category: 'lore', tags: [], author: 'player', createdAt: 1, updatedAt: 1 }];
  readTextFile.mockResolvedValue(JSON.stringify(validSaveFileBundle()));
  readDir.mockResolvedValue([]);
});

// =============================================================================
// buildCampaignBundle
// =============================================================================

describe('buildCampaignBundle', () => {
  it('calls save_manage export with the active world + party and embeds the engine bundle', async () => {
    callTool.mockResolvedValueOnce(exportResponse());

    const bundle = await buildCampaignBundle(activeSessionFixture());

    expect(callTool).toHaveBeenCalledWith('save_manage', {
      action: 'export',
      worldId: 'world_1',
      partyId: 'party_1',
    });

    expect(bundle.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(typeof bundle.savedAt).toBe('number');
    expect(bundle.sessionMeta.id).toBe('session_1');
    // The engine sub-bundle (entity rows) is embedded verbatim.
    expect(bundle.engine).toEqual(engineBundleFixture());
  });

  it('captures the slot chat messages and notes into the bundle', async () => {
    callTool.mockResolvedValueOnce(exportResponse());
    // The linked chat slot exists — its messages are captured (not getMessages()).
    chatSessions = [
      {
        id: 'chat_1',
        title: 'Linked',
        messages: [
          { id: 'm1', sender: 'user', content: 'Hello', timestamp: 1 },
          { id: 'm2', sender: 'ai', content: 'Hi', timestamp: 2 },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    const bundle = await buildCampaignBundle(activeSessionFixture());

    expect(bundle.chat).toHaveLength(2);
    expect(bundle.notes).toEqual(notes);
  });

  it('saves EMPTY chat (not the active/other session) when the linked chatSessionId has no matching slot', async () => {
    callTool.mockResolvedValueOnce(exportResponse());
    // The active session links to chat_1, but NO chat slot with that id exists.
    // getMessages() would return some OTHER (active) session's messages — we must
    // NOT save those; the missing linked slot means an empty chat.
    chatSessions = [
      { id: 'some_other_chat', title: 'Other', messages: [{ id: 'x', sender: 'user', content: 'unrelated', timestamp: 9 }], createdAt: 1, updatedAt: 1 },
    ];
    chatGetMessages.mockReturnValue([
      { id: 'x', sender: 'user', content: 'unrelated', timestamp: 9 },
    ]);

    const bundle = await buildCampaignBundle(activeSessionFixture());

    expect(bundle.chat).toEqual([]);
  });

  it('uses getMessages() only when there is NO chatSessionId link', async () => {
    callTool.mockResolvedValueOnce(exportResponse());
    const unlinked = { ...activeSessionFixture(), chatSessionId: undefined };
    chatGetMessages.mockReturnValue([
      { id: 'm1', sender: 'user', content: 'Hello', timestamp: 1 },
      { id: 'm2', sender: 'ai', content: 'Hi', timestamp: 2 },
    ]);

    const bundle = await buildCampaignBundle(unlinked as any);

    expect(bundle.chat).toHaveLength(2);
  });

  it('throws when the engine export reports a failure (no silent partial bundle)', async () => {
    callTool.mockResolvedValueOnce(
      wrapSaveManage({ error: true, message: 'World world_1 not found' })
    );

    await expect(buildCampaignBundle(activeSessionFixture())).rejects.toThrow();
  });

  // CodeRabbit round-3 finding 2: the bundle must be a point-in-time SNAPSHOT.
  // sessionMeta/chat/notes were returned as LIVE store references, so a streaming
  // chat update or a note edit AFTER buildCampaignBundle returned could leak into
  // the file (exportActiveCampaignToFile awaits again before JSON.stringify).
  it('returns a deep snapshot — later store mutations do NOT leak into the bundle', async () => {
    callTool.mockResolvedValueOnce(exportResponse());
    const liveChat = [{ id: 'm1', sender: 'user', content: 'Hello', timestamp: 1 }];
    chatSessions = [
      { id: 'chat_1', title: 'Linked', messages: liveChat, createdAt: 1, updatedAt: 2 },
    ];
    const liveNotes = [
      { id: 'note1', title: 'Lore', content: 'stuff', category: 'lore', tags: ['a'], author: 'player', createdAt: 1, updatedAt: 1 },
    ];
    notes = liveNotes;
    // Hold the SAME object reference we hand to the builder so we can mutate the
    // LIVE session afterwards and prove the bundle was decoupled by the clone.
    // (Comparing against a fresh activeSessionFixture() would ALWAYS differ —
    // a new object every call — so it never exercised the clone at all.)
    const liveSession = activeSessionFixture();

    const bundle = await buildCampaignBundle(liveSession);

    // Mutate the live store data AND the live session object AFTER build returned.
    liveChat.push({ id: 'm2', sender: 'ai', content: 'leaked!', timestamp: 9 });
    liveNotes[0].title = 'EDITED AFTER SAVE';
    liveNotes.push({ id: 'note2', title: 'new', content: 'c', category: 'lore', tags: [], author: 'player', createdAt: 2, updatedAt: 2 });
    liveSession.name = 'RENAMED AFTER SAVE';
    (liveSession.snapshot as any).level = 999;

    // The snapshot is frozen at build time — none of the post-build edits leak.
    expect(bundle.chat).toHaveLength(1);
    expect(bundle.notes).toHaveLength(1);
    expect(bundle.notes[0].title).toBe('Lore');
    // The cloned sessionMeta did not pick up the live mutations.
    expect(bundle.sessionMeta.name).toBe('The Ironwood Saga');
    expect(bundle.sessionMeta.snapshot.level).toBe(3);

    // And every snapshotted half is a DIFFERENT reference than the live store
    // data — the load-bearing decoupling check. Without the deep clone in
    // buildCampaignBundle these would be the same reference and FAIL: the chat
    // array IS the live slot's messages, notes IS the live notes array, and
    // sessionMeta IS the live session object we passed in.
    expect(bundle.chat).not.toBe(liveChat);
    expect(bundle.notes).not.toBe(liveNotes);
    expect(bundle.sessionMeta).not.toBe(liveSession);
    expect(bundle.sessionMeta.snapshot).not.toBe(liveSession.snapshot);
  });

  it('propagates a callTool rejection (engine JSON-RPC error)', async () => {
    callTool.mockRejectedValueOnce(new Error('bridge down'));

    await expect(buildCampaignBundle(activeSessionFixture())).rejects.toThrow();
  });
});

// =============================================================================
// exportActiveCampaignToFile
// =============================================================================

describe('exportActiveCampaignToFile', () => {
  it('mkdirs the saves dir and writes a parseable .qksave file with schemaVersion + engine', async () => {
    callTool.mockResolvedValueOnce(exportResponse());

    const path = await exportActiveCampaignToFile();

    expect(mkdir).toHaveBeenCalledWith('/mock/app/data/saves', expect.objectContaining({ recursive: true }));
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [writtenPath, contents] = writeTextFile.mock.calls[0];
    expect(writtenPath).toMatch(/^\/mock\/app\/data\/saves\/.*\.qksave$/);
    expect(path).toBe(writtenPath);

    const parsed = JSON.parse(contents as string);
    expect(parsed.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(parsed.engine).toEqual(engineBundleFixture());
    expect(parsed.sessionMeta.name).toBe('The Ironwood Saga');
  });

  it('uses a provided name for the file', async () => {
    callTool.mockResolvedValueOnce(exportResponse());

    await exportActiveCampaignToFile('my-custom-save');

    const [writtenPath] = writeTextFile.mock.calls[0];
    expect(writtenPath).toBe('/mock/app/data/saves/my-custom-save.qksave');
  });

  it('throws and does NOT write a file when there is no active campaign', async () => {
    getActiveSession.mockReturnValue(null);

    await expect(exportActiveCampaignToFile()).rejects.toThrow();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('does NOT write a file when the engine export fails', async () => {
    callTool.mockResolvedValueOnce(
      wrapSaveManage({ error: true, message: 'World not found' })
    );

    await expect(exportActiveCampaignToFile()).rejects.toThrow();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

// =============================================================================
// listSaveFiles
// =============================================================================

describe('listSaveFiles', () => {
  it('returns only .qksave file entries from the saves dir', async () => {
    readDir.mockResolvedValueOnce([
      { name: 'alpha.qksave', isFile: true, isDirectory: false },
      { name: 'beta.qksave', isFile: true, isDirectory: false },
      { name: 'notes.txt', isFile: true, isDirectory: false },
      { name: 'subdir', isFile: false, isDirectory: true },
    ]);

    const files = await listSaveFiles();

    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['alpha.qksave', 'beta.qksave']);
    // Each entry exposes a full path under saves/ for import.
    expect(files[0].path).toBe('/mock/app/data/saves/alpha.qksave');
  });

  it('lists files with a mixed-case extension (case-insensitive .qksave filter)', async () => {
    readDir.mockResolvedValueOnce([
      { name: 'Campaign.QKSAVE', isFile: true, isDirectory: false },
      { name: 'lower.qksave', isFile: true, isDirectory: false },
      { name: 'Mixed.QkSave', isFile: true, isDirectory: false },
      { name: 'notes.txt', isFile: true, isDirectory: false },
    ]);

    const files = await listSaveFiles();

    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['Campaign.QKSAVE', 'Mixed.QkSave', 'lower.qksave']);
  });

  it('returns an empty list (no throw) when the saves dir does not exist yet', async () => {
    readDir.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(listSaveFiles()).resolves.toEqual([]);
  });

  it('returns an empty list for a "does not exist" / "not found" readDir error', async () => {
    readDir.mockRejectedValueOnce(new Error('path does not exist'));
    await expect(listSaveFiles()).resolves.toEqual([]);

    readDir.mockRejectedValueOnce(new Error('No such file or directory (not found)'));
    await expect(listSaveFiles()).resolves.toEqual([]);
  });

  it('rethrows (does NOT silently return []) on a generic / permission readDir error', async () => {
    readDir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

    await expect(listSaveFiles()).rejects.toThrow(/Failed to list save files/);
  });
});

// =============================================================================
// importCampaignFromFile — happy path
// =============================================================================

describe('importCampaignFromFile (success)', () => {
  it('reads + parses + validates the file, calls save_manage import with the engine sub-bundle', async () => {
    callTool.mockResolvedValueOnce(importResponse());

    await importCampaignFromFile('/mock/app/data/saves/alpha.qksave');

    expect(readTextFile).toHaveBeenCalledWith('/mock/app/data/saves/alpha.qksave');
    expect(callTool).toHaveBeenCalledWith('save_manage', {
      action: 'import',
      bundle: engineBundleFixture(),
      schemaVersion: 1,
    });
  });

  it('restores notes via importNotes (deduped merge) on success', async () => {
    callTool.mockResolvedValueOnce(importResponse());

    await importCampaignFromFile('/mock/app/data/saves/alpha.qksave');

    expect(importNotes).toHaveBeenCalledTimes(1);
    const importedNotes = importNotes.mock.calls[0][0];
    expect(importedNotes.map((n: any) => n.id)).toContain('note1');
  });

  it('upserts the campaign session and switches to it (syncState re-fetches authoritative state)', async () => {
    callTool.mockResolvedValueOnce(importResponse());

    await importCampaignFromFile('/mock/app/data/saves/alpha.qksave');

    // Either an existing session is updated or a new one is created, then we switch.
    const upserted = createSession.mock.calls.length + updateSession.mock.calls.length;
    expect(upserted).toBeGreaterThan(0);
    expect(switchSession).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// importCampaignFromFile — no-clobber on bad input
// =============================================================================

describe('importCampaignFromFile (no-clobber)', () => {
  it('REJECTS malformed JSON without calling save_manage import or mutating stores', async () => {
    readTextFile.mockResolvedValueOnce('{ this is not valid json ');

    await expect(importCampaignFromFile('/mock/app/data/saves/bad.qksave')).rejects.toThrow();

    expect(callTool).not.toHaveBeenCalled();
    expect(importNotes).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('REJECTS a wrong schemaVersion bundle without calling import or mutating stores', async () => {
    const bad = validSaveFileBundle();
    (bad as any).schemaVersion = 999;
    readTextFile.mockResolvedValueOnce(JSON.stringify(bad));

    await expect(importCampaignFromFile('/mock/app/data/saves/wrong.qksave')).rejects.toThrow();

    expect(callTool).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('REJECTS a structurally-invalid bundle (missing engine) without calling import or mutating stores', async () => {
    const bad = validSaveFileBundle();
    delete (bad as any).engine;
    readTextFile.mockResolvedValueOnce(JSON.stringify(bad));

    await expect(importCampaignFromFile('/mock/app/data/saves/noengine.qksave')).rejects.toThrow();

    expect(callTool).not.toHaveBeenCalled();
    expect(importNotes).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  // sessionMeta.{id,name,worldId} feed downstream store mutations + the engine
  // import worldId, so a bundle missing/empty in any of them must be rejected
  // BEFORE the engine import or any store mutation.
  for (const field of ['id', 'name', 'worldId'] as const) {
    it(`REJECTS a bundle whose sessionMeta.${field} is missing (no import / no mutation)`, async () => {
      const bad = validSaveFileBundle();
      delete (bad.sessionMeta as any)[field];
      readTextFile.mockResolvedValueOnce(JSON.stringify(bad));

      await expect(
        importCampaignFromFile('/mock/app/data/saves/badmeta.qksave')
      ).rejects.toThrow(new RegExp(`sessionMeta\\.${field} is required`));

      expect(callTool).not.toHaveBeenCalled();
      expect(importNotes).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    });

    it(`REJECTS a bundle whose sessionMeta.${field} is an empty string (no import / no mutation)`, async () => {
      const bad = validSaveFileBundle();
      (bad.sessionMeta as any)[field] = '';
      readTextFile.mockResolvedValueOnce(JSON.stringify(bad));

      await expect(
        importCampaignFromFile('/mock/app/data/saves/emptymeta.qksave')
      ).rejects.toThrow(new RegExp(`sessionMeta\\.${field} is required`));

      expect(callTool).not.toHaveBeenCalled();
      expect(importNotes).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
    });

    it(`REJECTS a bundle whose sessionMeta.${field} is whitespace-only (no import / no mutation)`, async () => {
      const bad = validSaveFileBundle();
      (bad.sessionMeta as any)[field] = '   ';
      readTextFile.mockResolvedValueOnce(JSON.stringify(bad));

      await expect(
        importCampaignFromFile('/mock/app/data/saves/wsmeta.qksave')
      ).rejects.toThrow(new RegExp(`sessionMeta\\.${field} is required`));

      expect(callTool).not.toHaveBeenCalled();
      expect(importNotes).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    });
  }

  it('does NOT mutate frontend stores when the engine import itself fails', async () => {
    callTool.mockResolvedValueOnce(
      wrapSaveManage({ error: true, message: 'schemaVersion mismatch' })
    );

    await expect(importCampaignFromFile('/mock/app/data/saves/alpha.qksave')).rejects.toThrow();

    // The engine import was attempted, but a failure must not restore the frontend.
    expect(importNotes).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('does NOT mutate stores when the engine bridge rejects (caught, re-thrown as a clean error)', async () => {
    callTool.mockRejectedValueOnce(new Error('bridge down'));

    await expect(importCampaignFromFile('/mock/app/data/saves/alpha.qksave')).rejects.toThrow();

    expect(importNotes).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  // CodeRabbit round-3 finding 4: malformed `chat` entries must be rejected
  // BEFORE any store mutation. validateSaveBundle only checked Array.isArray, so
  // [null] / message-shaped holes would pass, succeed the engine import, then
  // corrupt chat state. Reject the file up front (no engine call, no mutation).
  for (const [label, badChat] of [
    ['a null entry', [null]],
    ['a non-object entry', ['not-a-message']],
    ['an entry missing id', [{ sender: 'user', content: 'hi', timestamp: 1 }]],
    ['an entry with a non-string content', [{ id: 'm', sender: 'user', content: 42, timestamp: 1 }]],
    ['an entry with a non-string sender', [{ id: 'm', sender: 7, content: 'hi', timestamp: 1 }]],
    ['an entry with a non-number timestamp', [{ id: 'm', sender: 'user', content: 'hi', timestamp: 'x' }]],
  ] as const) {
    it(`REJECTS ${label} in chat without calling import or mutating stores`, async () => {
      const bad = validSaveFileBundle();
      (bad as any).chat = badChat;
      readTextFile.mockResolvedValueOnce(JSON.stringify(bad));

      await expect(
        importCampaignFromFile('/mock/app/data/saves/badchat.qksave')
      ).rejects.toThrow(/chat/i);

      expect(callTool).not.toHaveBeenCalled();
      expect(importNotes).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    });
  }

  it('accepts a well-formed chat array (each entry id/sender/content/timestamp typed)', async () => {
    callTool.mockResolvedValueOnce(importResponse());
    // validSaveFileBundle()'s chat is already well-formed; just confirm it imports.
    await expect(
      importCampaignFromFile('/mock/app/data/saves/ok.qksave')
    ).resolves.toBeUndefined();
    expect(switchSession).toHaveBeenCalledTimes(1);
  });

  // CodeRabbit round-4 (saveSlotIO.ts:183): a chat timestamp that is technically
  // typeof 'number' but NOT finite (Infinity from a numeric overflow literal, or
  // NaN) would pass the old `typeof === 'number'` check, succeed the engine
  // import, then corrupt sort/render. Require Number.isFinite — reject the file
  // BEFORE any engine call or store mutation, so a poisoned timestamp never
  // clobbers current state.
  //
  // JSON.parse('1e400') returns a REAL Infinity number (overflow, no throw) — a
  // hand-edited .qksave can carry exactly this — so the non-finite value reaches
  // validateSaveBundle as a genuine number, not as a parse error.
  for (const [label, rawTimestamp] of [
    ['Infinity (overflow 1e400)', '1e400'],
    ['-Infinity (overflow -1e400)', '-1e400'],
  ] as const) {
    it(`REJECTS a chat entry with a non-finite ${label} timestamp without calling import or mutating stores`, async () => {
      const bundle = validSaveFileBundle();
      // Splice the overflow literal into the raw JSON text so JSON.parse yields a
      // real non-finite number (Tauri's readTextFile returns the exact bytes a
      // hand-edited save contains).
      const json = JSON.stringify(bundle).replace(
        '"timestamp":1}',
        `"timestamp":${rawTimestamp}}`
      );
      readTextFile.mockResolvedValueOnce(json);

      await expect(
        importCampaignFromFile('/mock/app/data/saves/nonfinite.qksave')
      ).rejects.toThrow(/chat/i);

      expect(callTool).not.toHaveBeenCalled();
      expect(importNotes).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    });
  }
});

// =============================================================================
// importCampaignFromFile — chat session identity (findings 3 & 5)
// =============================================================================

describe('importCampaignFromFile (session/chat identity)', () => {
  // Finding 3: a blank saved chatSessionId ('' or whitespace) must be coerced to
  // null so a FRESH chat id is generated, not an unusable empty-id chat slot.
  for (const blank of ['', '   '] as const) {
    it(`coerces a blank chatSessionId (${JSON.stringify(blank)}) to a fresh generated id`, async () => {
      callTool.mockResolvedValueOnce(importResponse());
      const file = validSaveFileBundle();
      (file.sessionMeta as any).chatSessionId = blank;
      readTextFile.mockResolvedValueOnce(JSON.stringify(file));

      await importCampaignFromFile('/mock/app/data/saves/blankchat.qksave');

      // A new chat session was created (no existing slot matched blank), and its
      // id is a non-empty string — NOT the blank value.
      expect(chatSessions.length).toBeGreaterThan(0);
      const created = chatSessions[0];
      expect(typeof created.id).toBe('string');
      expect(created.id.trim().length).toBeGreaterThan(0);

      // The CampaignSession upsert carries that fresh (non-blank) chatSessionId,
      // never the empty string.
      const upsertArgs =
        createSession.mock.calls[0]?.[0] ?? updateSession.mock.calls[0]?.[1];
      expect(upsertArgs.chatSessionId).toBeTruthy();
      expect(upsertArgs.chatSessionId).not.toBe(blank.trim());
    });
  }

  // Finding 5: a NEW import (no local session with meta.id) must preserve the
  // saved CampaignSession id, so re-importing the same .qksave updates that same
  // session instead of spawning a duplicate.
  it('preserves the saved session id when creating a brand-new imported session', async () => {
    callTool.mockResolvedValueOnce(importResponse());
    sessions = []; // no existing session with meta.id

    await importCampaignFromFile('/mock/app/data/saves/fresh.qksave');

    expect(createSession).toHaveBeenCalledTimes(1);
    const opts = createSession.mock.calls[0][0];
    expect(opts.id).toBe('session_1'); // the saved meta.id, preserved on create
    // And we switch to THAT id (not a freshly generated one).
    expect(switchSession).toHaveBeenCalledWith('session_1');
  });

  // CodeRabbit round-4 (saveSlotIO.ts:485): the create-new-session branch only
  // passed id/name/description/partyId/worldId/chatSessionId/activeCharacterId —
  // it DROPPED the saved sessionMeta.snapshot (and other persisted CampaignSession
  // metadata). A re-imported campaign then lost its UI snapshot (party/level/
  // location). Assert the snapshot (and createdAt/playtime, when saved) are passed
  // through to createSession so the restored session keeps them.
  it('restores the saved sessionMeta.snapshot (and metadata) on the create-new-session branch', async () => {
    callTool.mockResolvedValueOnce(importResponse());
    sessions = []; // forces the createSession branch

    await importCampaignFromFile('/mock/app/data/saves/withsnapshot.qksave');

    expect(createSession).toHaveBeenCalledTimes(1);
    const opts = createSession.mock.calls[0][0];
    // The saved snapshot survives the round-trip (was being dropped before).
    expect(opts.snapshot).toEqual({
      partyName: 'The Party',
      level: 3,
      locationName: 'Ironwood',
      memberCount: 2,
    });
    // Other persisted CampaignSession metadata is carried through too.
    expect(opts.createdAt).toBe(1000);
    expect(opts.playtime).toBe(5000);
    expect(opts.lastPlayedAt).toBe(2000);
  });

  it('updates the existing session with the saved snapshot on re-import', async () => {
    sessions = [{ ...activeSessionFixture(), snapshot: { partyName: 'stale', level: 1, locationName: 'old', memberCount: 0 } }];
    callTool.mockResolvedValueOnce(importResponse());

    await importCampaignFromFile('/mock/app/data/saves/again2.qksave');

    expect(updateSession).toHaveBeenCalledTimes(1);
    const [, updates] = updateSession.mock.calls[0];
    expect(updates.snapshot).toEqual({
      partyName: 'The Party',
      level: 3,
      locationName: 'Ironwood',
      memberCount: 2,
    });
  });

  it('re-importing the same save UPDATES the existing session (no duplicate) once it is present locally', async () => {
    // First import creates session_1 (preserving the id); simulate it now existing.
    sessions = [{ ...activeSessionFixture() }];
    callTool.mockResolvedValueOnce(importResponse());

    await importCampaignFromFile('/mock/app/data/saves/again.qksave');

    // Existing → updateSession path, NOT createSession.
    expect(updateSession).toHaveBeenCalledWith('session_1', expect.any(Object));
    expect(createSession).not.toHaveBeenCalled();
    expect(switchSession).toHaveBeenCalledWith('session_1');
  });
});
