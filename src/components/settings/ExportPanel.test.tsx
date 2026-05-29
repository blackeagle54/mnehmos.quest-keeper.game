/**
 * Tests for ExportPanel — the settings panel that triggers the Markdown
 * adventure-log export.
 *
 * The export service is mocked so we drive only the panel's UI states:
 * idle -> loading -> success(path) and idle -> loading -> error. The button is
 * disabled (empty state) when there is no active campaign session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- Service + store mocks (must precede component import) --------------------

const exportAdventureLogToFile = vi.fn();

vi.mock('../../services/adventureLogExport', () => ({
  exportAdventureLogToFile: (...args: unknown[]) =>
    exportAdventureLogToFile(...args),
}));

let sessionState: any;
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: any) => selector(sessionState),
}));

import { ExportPanel } from './ExportPanel';

describe('ExportPanel', () => {
  beforeEach(() => {
    exportAdventureLogToFile.mockReset();
    sessionState = {
      getActiveSession: () => ({ id: 's1', name: 'The Lost Mine' }),
    };
  });

  it('renders the export button', () => {
    render(<ExportPanel />);
    expect(screen.getByTestId('export-adventure-log-btn')).toBeInTheDocument();
    expect(
      screen.getByText(/export adventure log/i)
    ).toBeInTheDocument();
  });

  it('disables the button (empty state) when there is no active session', () => {
    sessionState = { getActiveSession: () => null };
    render(<ExportPanel />);
    expect(screen.getByTestId('export-adventure-log-btn')).toBeDisabled();
    expect(screen.getByTestId('export-empty-state')).toBeInTheDocument();
  });

  it('triggers the export and shows the success path', async () => {
    exportAdventureLogToFile.mockResolvedValue('/mock/app/data/exports/the-lost-mine.md');
    render(<ExportPanel />);

    fireEvent.click(screen.getByTestId('export-adventure-log-btn'));

    await waitFor(() => {
      expect(exportAdventureLogToFile).toHaveBeenCalledTimes(1);
    });

    const success = await screen.findByTestId('export-success');
    expect(success).toHaveTextContent('the-lost-mine.md');
  });

  it('shows an error state when the export rejects (no throw escapes the UI)', async () => {
    exportAdventureLogToFile.mockRejectedValue(new Error('disk full'));
    render(<ExportPanel />);

    fireEvent.click(screen.getByTestId('export-adventure-log-btn'));

    const error = await screen.findByTestId('export-error');
    expect(error).toHaveTextContent(/disk full|failed/i);
    // No success element should be present.
    expect(screen.queryByTestId('export-success')).not.toBeInTheDocument();
  });
});
