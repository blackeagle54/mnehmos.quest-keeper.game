/**
 * Tests for notesStore.ts — focused on importNotes dedup-by-id.
 *
 * The save/load-to-file slice re-imports a campaign's notes on every LOAD. The
 * original importNotes() did `[...notes, ...state.notes]` (a prepend with NO
 * dedup), so loading the same .qksave twice duplicated every note. importNotes
 * MUST dedup by note id: re-importing the same notes is idempotent, and an
 * incoming note updates/replaces the existing row with the same id rather than
 * appending a clone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNotesStore, type Note } from './notesStore';

function makeNote(overrides: Partial<Note> & { id: string }): Note {
  const now = Date.now();
  return {
    title: 'Untitled',
    content: 'body',
    category: 'general',
    tags: [],
    author: 'player',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('notesStore.importNotes (dedup by id)', () => {
  beforeEach(() => {
    useNotesStore.setState({ notes: [] });
  });

  it('imports notes into an empty store', () => {
    const incoming = [makeNote({ id: 'n1' }), makeNote({ id: 'n2' })];
    useNotesStore.getState().importNotes(incoming);

    const ids = useNotesStore.getState().notes.map((n) => n.id).sort();
    expect(ids).toEqual(['n1', 'n2']);
  });

  it('does NOT duplicate notes when the same notes are imported twice', () => {
    const incoming = [makeNote({ id: 'n1' }), makeNote({ id: 'n2' })];

    useNotesStore.getState().importNotes(incoming);
    useNotesStore.getState().importNotes(incoming); // re-import (e.g. loading the same save again)

    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(2);
    const ids = notes.map((n) => n.id).sort();
    expect(ids).toEqual(['n1', 'n2']);
  });

  it('merges new notes alongside existing ones without dropping either', () => {
    useNotesStore.getState().importNotes([makeNote({ id: 'existing' })]);
    useNotesStore.getState().importNotes([makeNote({ id: 'fresh' })]);

    const ids = useNotesStore.getState().notes.map((n) => n.id).sort();
    expect(ids).toEqual(['existing', 'fresh']);
  });

  it('an imported note replaces the existing note with the same id (no clone)', () => {
    useNotesStore.getState().importNotes([
      makeNote({ id: 'n1', title: 'Old Title', content: 'old' }),
    ]);
    useNotesStore.getState().importNotes([
      makeNote({ id: 'n1', title: 'New Title', content: 'new' }),
    ]);

    const matches = useNotesStore.getState().notes.filter((n) => n.id === 'n1');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('New Title');
    expect(matches[0].content).toBe('new');
  });

  it('dedups duplicate ids WITHIN a single import payload', () => {
    useNotesStore.getState().importNotes([
      makeNote({ id: 'dup', title: 'first' }),
      makeNote({ id: 'dup', title: 'second' }),
    ]);

    const notes = useNotesStore.getState().notes.filter((n) => n.id === 'dup');
    expect(notes).toHaveLength(1);
  });

  // A .qksave is untrusted input; a malformed notes payload must be rejected
  // BEFORE any dedup/mutation so the store is left unchanged (no-clobber).
  describe('shape validation (no-clobber)', () => {
    it('throws and leaves the store unchanged when a note entry is not an object', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([
          makeNote({ id: 'n1' }),
          'not-an-object' as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      const ids = useNotesStore.getState().notes.map((n) => n.id);
      expect(ids).toEqual(['keep']);
    });

    it('throws and leaves the store unchanged when a note entry lacks a string id', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([
          makeNote({ id: 'n1' }),
          { title: 'no id here' } as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      const ids = useNotesStore.getState().notes.map((n) => n.id);
      expect(ids).toEqual(['keep']);
    });

    it('throws when a note id is a non-string (e.g. number)', () => {
      useNotesStore.setState({ notes: [] });

      expect(() =>
        useNotesStore.getState().importNotes([{ id: 42, title: 'x' } as any])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes).toHaveLength(0);
    });

    it('throws when a note entry is null', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([null as any])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
    });

    // The notes payload comes straight off an untrusted .qksave; if it is not an
    // array at all (e.g. an object or null where an array was expected), iterating
    // it would throw a raw TypeError or silently misbehave. Guard explicitly,
    // BEFORE any mutation, with a clear message.
    it('throws when the argument is NOT an array, leaving the store unchanged', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      for (const bad of [null, undefined, {}, 'nope', 42] as any[]) {
        expect(() => useNotesStore.getState().importNotes(bad)).toThrow(
          /notes payload must be an array/
        );
      }

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
    });

    // Beyond `id` (the dedup key), the queries (searchNotes/getNotesByTag) read
    // title/content/tags directly and would crash on a structurally-incomplete
    // note. Validate the required structural fields up front so a malformed entry
    // is rejected before it can poison the store.
    it('throws and leaves the store unchanged when a note is missing required string fields', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([
          makeNote({ id: 'ok' }),
          { id: 'n2', content: 'has no title' } as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
    });

    it('throws when a note is missing its tags array', () => {
      useNotesStore.setState({ notes: [] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: 'n1', title: 't', content: 'c' } as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes).toHaveLength(0);
    });
  });
});
