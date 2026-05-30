/**
 * Tests for ExportPanel — the settings panel that triggers the Markdown
 * adventure-log export.
 *
 * The export service is mocked so we drive only the panel's UI states:
 * idle -> loading -> success(path) and idle -> loading -> error. The button is
 * disabled (empty state) when there is no active campaign session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
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

  describe('unmount during an in-flight export', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let useStateSpy: ReturnType<typeof vi.spyOn>;
    // Every state setter the panel hands out (setStatus/setPath/setError).
    let setters: Array<ReturnType<typeof vi.fn>>;

    beforeEach(() => {
      // Guard against any React warning leaking (e.g. act() / unmounted update).
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Wrap each useState setter so we can assert NONE of them fire after the
      // component has unmounted. Without the isMountedRef guard, the awaited
      // success/error branch in handleExport calls these post-unmount.
      setters = [];
      const realUseState = React.useState;
      useStateSpy = vi
        .spyOn(React, 'useState')
        .mockImplementation(((initial: unknown) => {
          const [value, realSetter] = (realUseState as any)(initial);
          const wrapped = vi.fn(realSetter);
          setters.push(wrapped);
          return [value, wrapped];
        }) as unknown as typeof React.useState);
    });

    afterEach(() => {
      useStateSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    /** Drain the microtask queue so the awaited setState path runs. */
    const drainMicrotasks = async () => {
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    };

    /** Count setter invocations recorded after a given baseline snapshot. */
    const settersCalledSince = (baseline: number[]) =>
      setters.reduce(
        (sum, s, i) => sum + (s.mock.calls.length - (baseline[i] ?? 0)),
        0
      );

    it('does not setState (no warning, no throw) when the export resolves after unmount', async () => {
      // Hand back a promise we control so we can unmount mid-flight.
      let resolveExport!: (path: string) => void;
      exportAdventureLogToFile.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveExport = resolve;
        })
      );

      const { unmount } = render(<ExportPanel />);
      fireEvent.click(screen.getByTestId('export-adventure-log-btn'));

      await waitFor(() => {
        expect(exportAdventureLogToFile).toHaveBeenCalledTimes(1);
      });

      // Snapshot setter call counts at unmount; nothing may setState after this.
      unmount();
      const baseline = setters.map((s) => s.mock.calls.length);

      resolveExport('/mock/app/data/exports/the-lost-mine.md');
      await drainMicrotasks();

      // The guard must skip every post-unmount setState (setPath + setStatus).
      expect(settersCalledSince(baseline)).toBe(0);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('does not setState (no warning, no throw) when the export rejects after unmount', async () => {
      let rejectExport!: (err: Error) => void;
      const pending = new Promise<string>((_, reject) => {
        rejectExport = reject;
      });
      // Pre-attach a catch so an unhandled rejection never leaks once it settles.
      pending.catch(() => {});
      exportAdventureLogToFile.mockReturnValue(pending);

      const { unmount } = render(<ExportPanel />);
      fireEvent.click(screen.getByTestId('export-adventure-log-btn'));

      await waitFor(() => {
        expect(exportAdventureLogToFile).toHaveBeenCalledTimes(1);
      });

      unmount();
      const baseline = setters.map((s) => s.mock.calls.length);

      rejectExport(new Error('disk full'));
      await drainMicrotasks();

      // The guard must skip the post-unmount setState (setError + setStatus).
      expect(settersCalledSince(baseline)).toBe(0);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
