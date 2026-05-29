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
const createSession = vi.fn(() => 'new-session-id');
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
});
