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

    // --- Proportional validation (CodeRabbit round-3 findings 6 & 7) ----------
    // A .qksave is untrusted, so REQUIRED structural fields (id/title/content/
    // tags) are rejected when missing/wrong-typed, AND each tags element must be
    // a string (searchNotes/getNotesByTag call .toLowerCase() on it). But we do
    // NOT require OPTIONAL fields the store treats as optional — instead, an
    // optional field that IS present must carry the right type (type-checked-if-
    // present), and absent optionals are fine.

    it('throws when a required field is the wrong type (id non-string)', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: 7, title: 't', content: 'c', tags: [] } as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
    });

    it('throws when id is an empty string (non-empty required as the dedup key)', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: '', title: 't', content: 'c', tags: [] } as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
    });

    for (const [field, value] of [
      ['title', 123],
      ['content', { not: 'a string' }],
      ['tags', 'not-an-array'],
    ] as const) {
      it(`throws when required field '${field}' is the wrong type`, () => {
        useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

        const bad: any = { id: 'n1', title: 't', content: 'c', tags: [] };
        bad[field] = value;

        expect(() =>
          useNotesStore.getState().importNotes([bad])
        ).toThrow(/notes payload contains invalid note entries/);

        expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
      });
    }

    it('throws when a tags element is not a string (e.g. a number)', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: 'n1', title: 't', content: 'c', tags: ['ok', 7] } as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
    });

    it('throws when a tags element is null', () => {
      useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: 'n1', title: 't', content: 'c', tags: [null] } as any,
        ])
      ).toThrow(/notes payload contains invalid note entries/);

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
    });

    // Optional fields are NOT required, but IF present must be the right type.
    for (const [field, value] of [
      ['category', 123],
      ['author', false],
      ['createdAt', {}],
      ['updatedAt', []],
      ['pinned', 'yes'],
      ['characterId', 5],
      ['worldId', true],
      ['questId', {}],
    ] as const) {
      it(`throws when present optional field '${field}' is the wrong type`, () => {
        useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

        const bad: any = { id: 'n1', title: 't', content: 'c', tags: [] };
        bad[field] = value;

        expect(() =>
          useNotesStore.getState().importNotes([bad])
        ).toThrow(/notes payload contains invalid note entries/);

        expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
      });
    }

    it('imports a note carrying ONLY the required fields (optionals absent) without throwing', () => {
      useNotesStore.setState({ notes: [] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: 'minimal', title: 't', content: 'c', tags: ['a', 'b'] } as any,
        ])
      ).not.toThrow();

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['minimal']);
    });

    // CodeRabbit #188 over-reach guard: category/author are OPTIONAL by design
    // (makeNote defaults them; the Note type marks them optional). They must NOT
    // be required — a note WITHOUT category/author is a valid save. They stay
    // type-checked-IF-present (a present string is fine; a present non-string is
    // rejected by the parametrized table above). Requiring them would reject
    // valid saves, so absent must remain accepted.
    it('accepts a note with category/author ABSENT (they are optional, not required)', () => {
      useNotesStore.setState({ notes: [] });

      expect(() =>
        useNotesStore.getState().importNotes([
          // no category, no author — only required + numeric timestamps.
          { id: 'no-opt', title: 't', content: 'c', tags: [], createdAt: 1, updatedAt: 2 } as any,
        ])
      ).not.toThrow();

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['no-opt']);
    });

    it('accepts a note with category/author PRESENT as strings (type-checked-if-present)', () => {
      useNotesStore.setState({ notes: [] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: 'with-opt', title: 't', content: 'c', tags: [], category: 'lore', author: 'player', createdAt: 1, updatedAt: 2 } as any,
        ])
      ).not.toThrow();

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['with-opt']);
    });

    // CodeRabbit round-4 (notesStore #200/#304, #188 partial): the store stores
    // NUMERIC timestamps (Date.now()) and getSortedNotes does `b.updatedAt -
    // a.updatedAt`. A string createdAt/updatedAt makes that subtraction NaN and
    // silently breaks the sort, so a string timestamp is NO LONGER accepted —
    // createdAt/updatedAt, if present, must be a (finite) NUMBER. This FLIPS the
    // round-3 "accepts number OR string" test below.
    it('accepts a numeric createdAt/updatedAt (the only valid serialized form)', () => {
      useNotesStore.setState({ notes: [] });

      expect(() =>
        useNotesStore.getState().importNotes([
          { id: 'n-num', title: 't', content: 'c', tags: [], createdAt: 1, updatedAt: 2 } as any,
        ])
      ).not.toThrow();

      expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['n-num']);
    });

    for (const field of ['createdAt', 'updatedAt'] as const) {
      it(`REJECTS a string ${field} (number-only: a string breaks getSortedNotes' numeric sort)`, () => {
        useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

        const bad: any = { id: 'n-str', title: 't', content: 'c', tags: [] };
        bad[field] = '2020';

        expect(() =>
          useNotesStore.getState().importNotes([bad])
        ).toThrow(/notes payload contains invalid note entries/);

        // No-clobber: the rejection happens before any mutation.
        expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
      });

      it(`REJECTS a non-finite ${field} (NaN/Infinity also break the numeric sort)`, () => {
        useNotesStore.setState({ notes: [makeNote({ id: 'keep' })] });

        const bad: any = { id: 'n-nan', title: 't', content: 'c', tags: [] };
        bad[field] = NaN;

        expect(() =>
          useNotesStore.getState().importNotes([bad])
        ).toThrow(/notes payload contains invalid note entries/);

        expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['keep']);
      });
    }
  });
});
