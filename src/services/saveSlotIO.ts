/**
 * saveSlotIO — manual campaign save/load TO FILE (Phase 5).
 *
 * A `.qksave` file is a portable, per-campaign bundle that pairs the engine's
 * authoritative entity export (via the `save_manage` tool) with the frontend
 * session/chat/notes layer, so one file fully describes a playable campaign:
 *
 *   {
 *     schemaVersion,   // THIS file format's version (frontend wrapper)
 *     savedAt,         // epoch ms
 *     sessionMeta,     // the CampaignSession (world/party/chat links + snapshot)
 *     chat,            // the slot's chat messages
 *     notes,           // notesStore notes
 *     engine,          // the save_manage export bundle (entity rows, own schemaVersion)
 *   }
 *
 * Engine bridge: mcpManager.gameStateClient.callTool(tool, args) REJECTS on a
 * JSON-RPC error and embeds its JSON payload in
 * `<!-- SAVE_MANAGE_JSON ... SAVE_MANAGE_JSON -->`. We parse with
 * extractEmbeddedJson(text, 'SAVE_MANAGE_JSON') (the FULL token, incl. `_JSON`),
 * mirroring achievementStore/reputationStore.
 *
 * No native file dialog is installed (@tauri-apps/plugin-dialog is NOT a dep),
 * so v1 keeps saves in `<appDataDir>/saves/` and lists them via readDir. A
 * Save-As / Open dialog is a documented fast-follow, not this slice.
 *
 * No-clobber invariant: a malformed / wrong-version file, an engine import
 * failure, or a bridge rejection must NEVER mutate current state. We therefore
 * (1) parse + structurally validate the file, (2) run the engine import and
 * confirm success, and ONLY THEN (3) restore the frontend stores.
 */

import { extractEmbeddedJson } from '../utils/mcpUtils';
import type { CampaignSession } from '../stores/sessionStore';
import type { Message } from '../stores/chatStore';
import type { Note } from '../stores/notesStore';

/** The `.qksave` wrapper format version (independent of the engine bundle's own). */
export const SAVE_SCHEMA_VERSION = 1 as const;

/** The engine save_manage bundle carries its own schemaVersion (currently 1). */
const ENGINE_SCHEMA_VERSION = 1 as const;

/** File extension + on-disk layout. */
const SAVE_EXTENSION = '.qksave';
const SAVES_DIRNAME = 'saves';

/** The on-disk shape of a `.qksave` file. */
export interface CampaignSaveBundle {
  schemaVersion: typeof SAVE_SCHEMA_VERSION;
  savedAt: number;
  sessionMeta: CampaignSession;
  chat: Message[];
  notes: Note[];
  /** The engine's save_manage export bundle (entity rows + its own schemaVersion). */
  engine: Record<string, unknown>;
}

/** A listed save file: its bare name plus the full path to read back. */
export interface SaveFileEntry {
  name: string;
  path: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ════════════════════════════════════════════════════════════════════════════

/** Resolve `<appDataDir>/saves` (no trailing slash). */
async function getSavesDir(): Promise<string> {
  const { appDataDir } = await import('@tauri-apps/api/path');
  const dir = await appDataDir();
  // appDataDir() may or may not include a trailing slash across platforms;
  // normalize so we never produce a double slash.
  const base = dir.replace(/[/\\]+$/, '');
  return `${base}/${SAVES_DIRNAME}`;
}

/** Pull the embedded SAVE_MANAGE_JSON payload out of a tool response. */
function parseSaveManageResponse(result: any): any | null {
  const text: string | undefined = result?.content?.find?.(
    (c: any) => c?.type === 'text'
  )?.text;
  if (!text) return null;
  return extractEmbeddedJson(text, 'SAVE_MANAGE_JSON');
}

/** Coerce an unknown thrown value into a message (callTool rejects with JSON-RPC error). */
function toErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  if (typeof err === 'string' && err.length > 0) return err;
  return fallback;
}

/**
 * Decide whether a save_manage payload (for a given action) is a FAILURE before
 * we trust it. A payload is bad when it failed to parse, carries an explicit
 * error envelope, reports success:false, or is the wrong action. Returns a
 * message on failure, else null.
 */
function saveManageFailure(
  data: any,
  expectedAction: 'export' | 'import',
  fallback: string
): string | null {
  if (data == null) return fallback;
  if (data.error) return data.message || fallback;
  if (data.success === false) return data.message || fallback;
  if (data.actionType !== expectedAction) {
    return data.message || `Unexpected save payload (expected ${expectedAction})`;
  }
  return null;
}

/** Make a filesystem-safe slug from a campaign name for the default filename. */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'campaign';
}

/**
 * Structurally validate an UNTRUSTED parsed `.qksave` object before we touch the
 * engine or any store. Strict on the envelope (schemaVersion must match, engine
 * sub-bundle must be present), loose on the inner arrays (default to []). The
 * engine itself re-validates `engine` on import, so we only guard the wrapper
 * here. Returns the typed bundle or throws.
 */
function validateSaveBundle(parsed: unknown): CampaignSaveBundle {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid save file: not an object');
  }
  const b = parsed as Record<string, unknown>;

  if (b.schemaVersion !== SAVE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported save schemaVersion ${String(b.schemaVersion)} — this build reads schemaVersion ${SAVE_SCHEMA_VERSION}`
    );
  }
  if (typeof b.sessionMeta !== 'object' || b.sessionMeta === null) {
    throw new Error('Invalid save file: missing sessionMeta');
  }
  if (typeof b.engine !== 'object' || b.engine === null || Array.isArray(b.engine)) {
    throw new Error('Invalid save file: missing engine bundle');
  }

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: typeof b.savedAt === 'number' ? b.savedAt : Date.now(),
    sessionMeta: b.sessionMeta as CampaignSession,
    chat: Array.isArray(b.chat) ? (b.chat as Message[]) : [],
    notes: Array.isArray(b.notes) ? (b.notes as Note[]) : [],
    engine: b.engine as Record<string, unknown>,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the in-memory `.qksave` bundle for an active campaign session. Calls
 * save_manage export for the engine entity rows and pairs them with the slot's
 * chat + notes. Throws if the engine export fails (so we never persist a
 * silent partial bundle).
 */
export async function buildCampaignBundle(
  activeSession: CampaignSession
): Promise<CampaignSaveBundle> {
  if (!activeSession) {
    throw new Error('No active campaign session to save');
  }
  if (!activeSession.worldId) {
    throw new Error('Active campaign has no world to export');
  }

  const { mcpManager } = await import('./mcpClient');

  // 1) Engine entity export (the authoritative half). callTool REJECTS on a
  //    JSON-RPC error — let it propagate; callers wrap in try/catch.
  const exportArgs: { action: 'export'; worldId: string; partyId?: string } = {
    action: 'export',
    worldId: activeSession.worldId,
  };
  if (activeSession.partyId) exportArgs.partyId = activeSession.partyId;

  const result = await mcpManager.gameStateClient.callTool('save_manage', exportArgs);
  const payload = parseSaveManageResponse(result);

  const failure = saveManageFailure(payload, 'export', 'Failed to export campaign');
  if (failure) throw new Error(failure);

  const engine = payload?.bundle;
  if (typeof engine !== 'object' || engine === null) {
    throw new Error('Engine export returned no bundle');
  }

  // 2) Frontend half — the slot's chat messages + the player's notes.
  const { useChatStore } = await import('../stores/chatStore');
  const { useNotesStore } = await import('../stores/notesStore');

  // Read the slot's messages: if it is the active chat session getMessages()
  // returns them; otherwise pull from the stored sessions list by id.
  const chatStore = useChatStore.getState();
  let chat: Message[] = chatStore.getMessages();
  if (activeSession.chatSessionId) {
    const slot = chatStore.sessions.find((s) => s.id === activeSession.chatSessionId);
    if (slot) chat = slot.messages;
  }

  const notes = useNotesStore.getState().notes;

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: Date.now(),
    sessionMeta: activeSession,
    chat,
    notes,
    engine: engine as Record<string, unknown>,
  };
}

/**
 * Export the ACTIVE campaign to `<appDataDir>/saves/<name>.qksave`. Builds the
 * bundle (which throws on engine failure, so nothing is written on error),
 * ensures the saves dir exists, writes pretty JSON, and returns the path.
 */
export async function exportActiveCampaignToFile(name?: string): Promise<string> {
  const { useSessionStore } = await import('../stores/sessionStore');
  const activeSession = useSessionStore.getState().getActiveSession();
  if (!activeSession) {
    throw new Error('No active campaign to save');
  }

  // Build FIRST: if the engine export fails this throws before any file I/O,
  // so a failed save never leaves a partial/empty file on disk.
  const bundle = await buildCampaignBundle(activeSession);

  const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
  const savesDir = await getSavesDir();
  await mkdir(savesDir, { recursive: true });

  const fileName = `${slugify(name ?? activeSession.name)}${SAVE_EXTENSION}`;
  const path = `${savesDir}/${fileName}`;
  await writeTextFile(path, JSON.stringify(bundle, null, 2));

  return path;
}

/**
 * List the `.qksave` files in the saves dir. Returns [] (no throw) when the dir
 * does not exist yet (first run, before any save).
 */
export async function listSaveFiles(): Promise<SaveFileEntry[]> {
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const savesDir = await getSavesDir();

  let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
  try {
    entries = (await readDir(savesDir)) as any[];
  } catch {
    // Dir not created yet (no save has been written) — surface as empty.
    return [];
  }

  return entries
    .filter((e) => e?.isFile && typeof e.name === 'string' && e.name.endsWith(SAVE_EXTENSION))
    .map((e) => ({ name: e.name, path: `${savesDir}/${e.name}` }));
}

/**
 * Import a campaign from a `.qksave` file at `path`.
 *
 * Ordering enforces the no-clobber invariant:
 *   1. read + JSON.parse + structurally validate (throws on malformed/wrong
 *      version — BEFORE any engine call or store mutation),
 *   2. call save_manage import with the engine sub-bundle and confirm success
 *      (a failure or bridge rejection throws — BEFORE any store mutation),
 *   3. ONLY on engine success, restore the frontend: upsert the CampaignSession,
 *      restore the slot's chat messages, merge notes (deduped), then switchSession
 *      so syncState re-fetches the now-authoritative engine state.
 *
 * A bad file therefore never corrupts current state.
 */
export async function importCampaignFromFile(path: string): Promise<void> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs');

  // --- (1) Read + parse + validate (no mutation possible past here on failure)
  const raw = await readTextFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid save file: could not parse JSON');
  }
  const bundle = validateSaveBundle(parsed); // throws on wrong version / missing engine

  // --- (2) Engine import — authoritative half FIRST. Confirm success before we
  //         touch any frontend store. callTool REJECTS on a JSON-RPC error.
  const { mcpManager } = await import('./mcpClient');
  let importResult: any;
  try {
    importResult = await mcpManager.gameStateClient.callTool('save_manage', {
      action: 'import',
      bundle: bundle.engine,
      schemaVersion: ENGINE_SCHEMA_VERSION,
    });
  } catch (err) {
    // Re-throw as a clean error; current state is untouched.
    throw new Error(toErrorMessage(err, 'Engine import failed'));
  }

  const importPayload = parseSaveManageResponse(importResult);
  const failure = saveManageFailure(importPayload, 'import', 'Engine import failed');
  if (failure) throw new Error(failure);

  // --- (3) Engine accepted the bundle — NOW restore the frontend. From here on
  //         the engine DB already holds this campaign's rows, so switchSession's
  //         syncState will re-fetch authoritative state.
  const { useSessionStore } = await import('../stores/sessionStore');
  const { useChatStore } = await import('../stores/chatStore');
  const { useNotesStore } = await import('../stores/notesStore');

  const sessionStore = useSessionStore.getState();
  const chatStore = useChatStore.getState();
  const notesStore = useNotesStore.getState();

  const meta = bundle.sessionMeta;

  // 3a) Restore the slot's chat messages into a chat session. Reuse the saved
  //     chatSessionId if present so the session link stays intact; create one
  //     otherwise. We write the messages directly so the imported history is
  //     preserved verbatim.
  let chatSessionId = meta.chatSessionId ?? null;
  const existingChat = chatSessionId
    ? chatStore.sessions.find((s) => s.id === chatSessionId)
    : undefined;

  useChatStore.setState((state) => {
    const now = Date.now();
    if (existingChat) {
      return {
        sessions: state.sessions.map((s) =>
          s.id === chatSessionId
            ? { ...s, messages: bundle.chat, updatedAt: now }
            : s
        ),
      };
    }
    // No matching session — create one carrying the saved id (or a fresh id).
    const id = chatSessionId ?? Date.now().toString();
    chatSessionId = id;
    return {
      sessions: [
        {
          id,
          title: meta.name || 'Imported Campaign',
          messages: bundle.chat,
          createdAt: now,
          updatedAt: now,
        },
        ...state.sessions,
      ],
    };
  });

  // 3b) Merge notes — importNotes now dedups by id, so re-importing the same
  //     save does not duplicate notes.
  notesStore.importNotes(bundle.notes);

  // 3c) Upsert the CampaignSession. If a session with this id already exists,
  //     update it in place; otherwise create a new one. Then switchSession to it
  //     so syncState(true) reloads world/party/character from the engine DB.
  const existingSession = sessionStore.sessions.find((s) => s.id === meta.id);
  let targetSessionId: string;

  if (existingSession) {
    sessionStore.updateSession(meta.id, {
      name: meta.name,
      description: meta.description,
      partyId: meta.partyId,
      worldId: meta.worldId,
      chatSessionId,
      activeCharacterId: meta.activeCharacterId,
      snapshot: meta.snapshot,
    });
    targetSessionId = meta.id;
  } else {
    targetSessionId = sessionStore.createSession({
      name: meta.name,
      description: meta.description,
      partyId: meta.partyId,
      worldId: meta.worldId,
      chatSessionId,
      activeCharacterId: meta.activeCharacterId,
    });
  }

  // 3d) Switch to the restored campaign — this triggers syncState(true), which
  //     re-fetches the authoritative state the engine import just populated.
  await sessionStore.switchSession(targetSessionId);
}
