import React from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { exportAdventureLogToFile } from '../../services/adventureLogExport';

type ExportStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * ExportPanel — a settings panel that renders the active campaign's chat
 * transcript + state summaries to a Markdown adventure log on disk.
 *
 * Pure frontend: it just orchestrates the export service and reflects its
 * idle / loading / success(path) / error state. The button is disabled (empty
 * state) when there is no active campaign session.
 */
export const ExportPanel: React.FC = () => {
  const hasActiveSession = useSessionStore(
    (s) => s.getActiveSession() !== null
  );

  const [status, setStatus] = React.useState<ExportStatus>('idle');
  const [path, setPath] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleExport = async () => {
    setStatus('loading');
    setPath(null);
    setError(null);
    try {
      const written = await exportAdventureLogToFile();
      setPath(written);
      setStatus('success');
    } catch (e) {
      // Surface the failure in the UI; never let it escape as an unhandled throw.
      setError(e instanceof Error ? e.message : 'Export failed');
      setStatus('error');
    }
  };

  const disabled = !hasActiveSession || status === 'loading';

  return (
    <div className="pt-2 border-t border-terminal-green-dim">
      <label className="block text-sm font-bold text-terminal-green mb-2">
        ADVENTURE LOG
      </label>

      <button
        data-testid="export-adventure-log-btn"
        onClick={handleExport}
        disabled={disabled}
        className="w-full rounded border border-terminal-green bg-black/50 px-4 py-2 font-mono text-sm text-terminal-green transition-colors hover:bg-terminal-green/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'loading'
          ? '⏳ EXPORTING…'
          : '📜 EXPORT ADVENTURE LOG (MARKDOWN)'}
      </button>

      {!hasActiveSession && (
        <p
          data-testid="export-empty-state"
          className="mt-2 text-xs text-terminal-green-dim"
        >
          Start or load a campaign to export its adventure log.
        </p>
      )}

      {status === 'success' && path && (
        <p
          data-testid="export-success"
          className="mt-2 break-all text-xs text-terminal-green-bright"
        >
          ✓ Saved to {path}
        </p>
      )}

      {status === 'error' && (
        <p
          data-testid="export-error"
          className="mt-2 text-xs text-red-400"
        >
          ✗ Export failed: {error}
        </p>
      )}
    </div>
  );
};
