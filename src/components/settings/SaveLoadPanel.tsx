import React from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import {
  exportActiveCampaignToFile,
  listSaveFiles,
  importCampaignFromFile,
  type SaveFileEntry,
} from '../../services/saveSlotIO';

/**
 * SaveLoadPanel — manual campaign save/load TO FILE (Phase 5).
 *
 * SAVE writes the active campaign to `<appDataDir>/saves/<name>.qksave` (the
 * engine entity export + the frontend session/chat/notes). LOAD reads a chosen
 * `.qksave` back. No native file dialog is installed, so instead of an OS picker
 * we list the files already in the saves dir and let the player pick one — a
 * Save-As/Open dialog is a documented fast-follow, not this slice.
 *
 * All async work is wrapped so a failed save or a bad/no-clobber-rejected load
 * surfaces as an error message rather than throwing into the React tree.
 */
export const SaveLoadPanel: React.FC = () => {
  const getActiveSession = useSessionStore((s) => s.getActiveSession);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [files, setFiles] = React.useState<SaveFileEntry[]>([]);
  const [listed, setListed] = React.useState(false);

  // The active session id is reactive; resolving the session here keeps the
  // disabled state in sync without selecting the (unstable) object itself.
  const hasActiveCampaign = activeSessionId != null && getActiveSession() != null;

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const path = await exportActiveCampaignToFile();
      const name = path.split(/[/\\]/).pop() || path;
      setStatus({ kind: 'ok', text: `Saved campaign to ${name}` });
      // Refresh the list if it is already shown so the new file appears.
      if (listed) await refresh();
    } catch (err) {
      setStatus({ kind: 'error', text: messageOf(err, 'Failed to save campaign') });
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const entries = await listSaveFiles();
      setFiles(entries);
      setListed(true);
      if (entries.length === 0) {
        setStatus({ kind: 'ok', text: 'No save files yet.' });
      }
    } catch (err) {
      setStatus({ kind: 'error', text: messageOf(err, 'Failed to list save files') });
    } finally {
      setBusy(false);
    }
  };

  const handleLoad = async (entry: SaveFileEntry) => {
    setBusy(true);
    setStatus(null);
    try {
      await importCampaignFromFile(entry.path);
      setStatus({ kind: 'ok', text: `Loaded campaign from ${entry.name}` });
    } catch (err) {
      // No-clobber: a bad file never corrupts current state — we just report it.
      setStatus({ kind: 'error', text: messageOf(err, 'Failed to load campaign') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="save-load-panel">
      <label className="block text-sm font-bold text-terminal-green">CAMPAIGN SAVES</label>

      <div className="flex gap-2">
        <button
          data-testid="save-campaign-button"
          onClick={handleSave}
          disabled={busy || !hasActiveCampaign}
          className="flex-1 rounded border border-terminal-green bg-black/50 px-4 py-2 font-mono text-sm text-terminal-green transition-colors hover:bg-terminal-green/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          title={hasActiveCampaign ? 'Save the active campaign to a file' : 'No active campaign to save'}
        >
          💾 SAVE TO FILE
        </button>
        <button
          data-testid="refresh-saves-button"
          onClick={refresh}
          disabled={busy}
          className="flex-1 rounded border border-terminal-green bg-black/50 px-4 py-2 font-mono text-sm text-terminal-green transition-colors hover:bg-terminal-green/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          title="List saved campaign files"
        >
          📂 LOAD FROM FILE
        </button>
      </div>

      {status && (
        <p
          data-testid="save-load-status"
          className={`text-xs font-mono ${
            status.kind === 'error' ? 'text-red-400' : 'text-terminal-green-dim'
          }`}
        >
          {status.text}
        </p>
      )}

      {listed && files.length > 0 && (
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded border border-terminal-green-dim p-2">
          {files.map((entry) => (
            <li
              key={entry.path}
              data-testid="save-file-entry"
              className="flex items-center justify-between gap-2 text-xs font-mono text-terminal-green"
            >
              <span className="truncate" title={entry.path}>
                {entry.name}
              </span>
              <button
                data-testid="load-file-button"
                onClick={() => handleLoad(entry)}
                disabled={busy}
                className="shrink-0 rounded border border-terminal-green px-2 py-1 text-terminal-green transition-colors hover:bg-terminal-green hover:text-terminal-black focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                LOAD
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-terminal-green-dim">
        Saves are stored in the app data <code>saves/</code> folder. A native file
        picker is a planned follow-up.
      </p>
    </div>
  );
};

/** Coerce an unknown thrown value into a user-facing message. */
function messageOf(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  if (typeof err === 'string' && err.length > 0) return err;
  return fallback;
}
