import React from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useGameStateStore } from '../../stores/gameStateStore';
import { exportAdventureLogToFile } from '../../services/adventureLogExport';
import { exportCharacterSheetPdf } from '../../services/characterSheetPdf';

type ExportStatus = 'idle' | 'loading' | 'success' | 'error';

interface ExportActionState {
  status: ExportStatus;
  path: string | null;
  error: string | null;
}

const IDLE_STATE: ExportActionState = {
  status: 'idle',
  path: null,
  error: null,
};

/**
 * ExportPanel — a settings panel that renders the active campaign to disk:
 *   1. the chat transcript + state summaries as a Markdown adventure log, and
 *   2. the active character's sheet as a PDF.
 *
 * Pure frontend: it just orchestrates the export services and reflects each
 * one's idle / loading / success(path) / error state. The Markdown button is
 * disabled (empty state) when there is no active campaign session; the PDF
 * button is disabled (empty state) when there is no active character.
 */
export const ExportPanel: React.FC = () => {
  const hasActiveSession = useSessionStore(
    (s) => s.getActiveSession() !== null
  );
  const hasActiveCharacter = useGameStateStore(
    (s) => s.activeCharacter !== null
  );

  const [log, setLog] = React.useState<ExportActionState>(IDLE_STATE);
  const [pdf, setPdf] = React.useState<ExportActionState>(IDLE_STATE);

  // Track mount status so the async handlers never setState after unmount (an
  // export can resolve/reject while the settings panel is already closed).
  const isMountedRef = React.useRef(true);
  React.useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  /**
   * Run an export action, threading its idle/loading/success/error state through
   * the provided setter. Failures are surfaced in the UI; nothing escapes as an
   * unhandled throw. All post-unmount setStates are skipped via the mount guard.
   */
  const runExport = async (
    action: () => Promise<string>,
    setState: React.Dispatch<React.SetStateAction<ExportActionState>>
  ) => {
    setState({ status: 'loading', path: null, error: null });
    try {
      const written = await action();
      if (isMountedRef.current) {
        setState({ status: 'success', path: written, error: null });
      }
    } catch (e) {
      if (isMountedRef.current) {
        setState({
          status: 'error',
          path: null,
          error: e instanceof Error ? e.message : 'Export failed',
        });
      }
    }
  };

  const logDisabled = !hasActiveSession || log.status === 'loading';
  const pdfDisabled = !hasActiveCharacter || pdf.status === 'loading';

  return (
    <div className="pt-2 border-t border-terminal-green-dim space-y-4">
      {/* --- Adventure log (Markdown) ------------------------------------- */}
      <div>
        <label className="block text-sm font-bold text-terminal-green mb-2">
          ADVENTURE LOG
        </label>

        <button
          data-testid="export-adventure-log-btn"
          onClick={() => runExport(() => exportAdventureLogToFile(), setLog)}
          disabled={logDisabled}
          className="w-full rounded border border-terminal-green bg-black/50 px-4 py-2 font-mono text-sm text-terminal-green transition-colors hover:bg-terminal-green/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {log.status === 'loading'
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

        {log.status === 'success' && log.path && (
          <p
            data-testid="export-success"
            className="mt-2 break-all text-xs text-terminal-green-bright"
          >
            ✓ Saved to {log.path}
          </p>
        )}

        {log.status === 'error' && (
          <p data-testid="export-error" className="mt-2 text-xs text-red-400">
            ✗ Export failed: {log.error}
          </p>
        )}
      </div>

      {/* --- Character sheet (PDF) ---------------------------------------- */}
      <div>
        <label className="block text-sm font-bold text-terminal-green mb-2">
          CHARACTER SHEET
        </label>

        <button
          data-testid="export-character-pdf-btn"
          onClick={() => runExport(() => exportCharacterSheetPdf(), setPdf)}
          disabled={pdfDisabled}
          className="w-full rounded border border-terminal-green bg-black/50 px-4 py-2 font-mono text-sm text-terminal-green transition-colors hover:bg-terminal-green/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pdf.status === 'loading'
            ? '⏳ EXPORTING…'
            : '🧾 EXPORT CHARACTER SHEET (PDF)'}
        </button>

        {!hasActiveCharacter && (
          <p
            data-testid="export-character-pdf-empty-state"
            className="mt-2 text-xs text-terminal-green-dim"
          >
            Select an active character to export its sheet.
          </p>
        )}

        {pdf.status === 'success' && pdf.path && (
          <p
            data-testid="export-character-pdf-success"
            className="mt-2 break-all text-xs text-terminal-green-bright"
          >
            ✓ Saved to {pdf.path}
          </p>
        )}

        {pdf.status === 'error' && (
          <p
            data-testid="export-character-pdf-error"
            className="mt-2 text-xs text-red-400"
          >
            ✗ Export failed: {pdf.error}
          </p>
        )}
      </div>
    </div>
  );
};
