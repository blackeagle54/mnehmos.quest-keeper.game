/**
 * Tests for SaveLoadPanel — the manual campaign save/load-to-file UI (Phase 5).
 *
 * The panel lets the player SAVE the active campaign to a `.qksave` file and
 * LOAD one back from the appdata `saves/` dir (no native file dialog is
 * installed, so v1 lists files instead of opening a picker). We mock the
 * saveSlotIO service + sessionStore so this drives render/handler state without
 * a live bridge or real disk. Mirrors the existing viewport view-test pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- Service mock (must precede component import) ----------------------------

const exportActiveCampaignToFile = vi.fn();
const listSaveFiles = vi.fn();
const importCampaignFromFile = vi.fn();

vi.mock('../../services/saveSlotIO', () => ({
  exportActiveCampaignToFile: (...args: any[]) => exportActiveCampaignToFile(...args),
  listSaveFiles: (...args: any[]) => listSaveFiles(...args),
  importCampaignFromFile: (...args: any[]) => importCampaignFromFile(...args),
}));

// --- Session store mock ------------------------------------------------------

let activeSession: any = {
  id: 'session_1',
  name: 'The Ironwood Saga',
  worldId: 'world_1',
  partyId: 'party_1',
};

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: vi.fn((selector: any) =>
    selector({
      getActiveSession: () => activeSession,
      activeSessionId: activeSession?.id ?? null,
    })
  ),
}));

import { SaveLoadPanel } from './SaveLoadPanel';

beforeEach(() => {
  vi.clearAllMocks();
  activeSession = {
    id: 'session_1',
    name: 'The Ironwood Saga',
    worldId: 'world_1',
    partyId: 'party_1',
  };
  exportActiveCampaignToFile.mockResolvedValue('/mock/app/data/saves/the-ironwood-saga.qksave');
  listSaveFiles.mockResolvedValue([
    { name: 'the-ironwood-saga.qksave', path: '/mock/app/data/saves/the-ironwood-saga.qksave' },
    { name: 'other.qksave', path: '/mock/app/data/saves/other.qksave' },
  ]);
  importCampaignFromFile.mockResolvedValue(undefined);
});

describe('SaveLoadPanel', () => {
  it('renders the save and load controls', () => {
    render(<SaveLoadPanel />);
    expect(screen.getByTestId('save-campaign-button')).toBeInTheDocument();
    expect(screen.getByTestId('refresh-saves-button')).toBeInTheDocument();
  });

  it('saves the active campaign to a file when the save button is clicked', async () => {
    render(<SaveLoadPanel />);
    fireEvent.click(screen.getByTestId('save-campaign-button'));

    await waitFor(() => {
      expect(exportActiveCampaignToFile).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a success message with the saved file name after saving', async () => {
    render(<SaveLoadPanel />);
    fireEvent.click(screen.getByTestId('save-campaign-button'));

    await waitFor(() => {
      expect(screen.getByTestId('save-load-status')).toHaveTextContent(/the-ironwood-saga\.qksave/);
    });
  });

  it('lists the available .qksave files', async () => {
    render(<SaveLoadPanel />);
    fireEvent.click(screen.getByTestId('refresh-saves-button'));

    await waitFor(() => {
      const items = screen.getAllByTestId('save-file-entry');
      expect(items).toHaveLength(2);
    });
    expect(screen.getByText('the-ironwood-saga.qksave')).toBeInTheDocument();
  });

  it('imports the chosen file when its load button is clicked', async () => {
    render(<SaveLoadPanel />);
    fireEvent.click(screen.getByTestId('refresh-saves-button'));

    await waitFor(() => {
      expect(screen.getAllByTestId('save-file-entry')).toHaveLength(2);
    });

    const loadButtons = screen.getAllByTestId('load-file-button');
    fireEvent.click(loadButtons[0]);

    await waitFor(() => {
      expect(importCampaignFromFile).toHaveBeenCalledWith(
        '/mock/app/data/saves/the-ironwood-saga.qksave'
      );
    });
  });

  it('shows an error state when saving fails (and does not crash)', async () => {
    exportActiveCampaignToFile.mockRejectedValueOnce(new Error('disk full'));
    render(<SaveLoadPanel />);
    fireEvent.click(screen.getByTestId('save-campaign-button'));

    await waitFor(() => {
      const status = screen.getByTestId('save-load-status');
      expect(status).toHaveTextContent(/disk full/i);
    });
  });

  it('shows an error state when loading fails (no-clobber: surfaced, not thrown)', async () => {
    importCampaignFromFile.mockRejectedValueOnce(new Error('Unsupported save schemaVersion 999'));
    render(<SaveLoadPanel />);
    fireEvent.click(screen.getByTestId('refresh-saves-button'));

    await waitFor(() => {
      expect(screen.getAllByTestId('save-file-entry')).toHaveLength(2);
    });
    fireEvent.click(screen.getAllByTestId('load-file-button')[0]);

    await waitFor(() => {
      expect(screen.getByTestId('save-load-status')).toHaveTextContent(/schemaVersion 999/i);
    });
  });

  it('disables the save button when there is no active campaign', () => {
    activeSession = null;
    render(<SaveLoadPanel />);
    expect(screen.getByTestId('save-campaign-button')).toBeDisabled();
  });
});
