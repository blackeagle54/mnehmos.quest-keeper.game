/**
 * Tests for the PDF character-sheet export slice (Phase 5).
 *
 * `buildCharacterSheetDocDefinition` is a PURE/deterministic builder: same
 * character + the same injected timestamp must always produce a deep-equal
 * pdfmake document-definition object (plain JSON). It never reads the clock or
 * Math.random() — the timestamp is passed in. No PDF rendering happens here, so
 * we can assert directly on the document-definition object's structure.
 *
 * `exportCharacterSheetPdf` gathers the active character from the stores (or
 * accepts an injected character), builds the doc-def, renders it to BYTES via
 * pdfmake, and writes it under `<appDataDir>/exports/<slug>.pdf` as a BINARY
 * file (writeFile + Uint8Array, NOT writeTextFile). An absent active character
 * must surface as a rejected error WITHOUT writing a file, so the UI layer can
 * show an error state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CharacterStats } from '../stores/gameStateStore';
import type { InventoryItem } from '../stores/gameStateStore';

// --- pdfmake mock (must precede the module-under-test import) -----------------
//
// The browser build is mocked so the test exercises only the doc-def -> bytes
// seam: createPdf(docDef).getBuffer() resolves to a fake byte buffer. We also
// capture the doc-def passed to createPdf so we can assert the impure boundary
// hands the pure builder's output straight to pdfmake.

const FAKE_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
const getBuffer = vi.fn(async () => FAKE_PDF_BYTES);
const createPdf = vi.fn((_docDef: unknown) => ({ getBuffer }));

vi.mock('pdfmake/build/pdfmake', () => ({
  default: {
    createPdf: (...args: unknown[]) => createPdf(args[0]),
    vfs: {},
  },
}));

// vfs_fonts has no testable surface; stub it so the import resolves.
vi.mock('pdfmake/build/vfs_fonts', () => ({ default: { vfs: {} } }));

// --- Tauri fs/path mocks ------------------------------------------------------

const mkdir = vi.fn(async (_path: string, _opts?: unknown) => {});
const writeFile = vi.fn(async (_path: string, _data: Uint8Array) => {});
const appDataDir = vi.fn(async () => '/mock/app/data');

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: (...args: unknown[]) => mkdir(...(args as [string, unknown])),
  writeFile: (...args: unknown[]) =>
    writeFile(...(args as [string, Uint8Array])),
}));

const join = vi.fn((...parts: string[]) => parts.join('/'));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: (...args: unknown[]) => appDataDir(...(args as [])),
  join: (...args: string[]) => join(...args),
}));

// --- Store mocks --------------------------------------------------------------

let gameStateState: any;

vi.mock('../stores/gameStateStore', () => ({
  useGameStateStore: { getState: () => gameStateState },
}));

import {
  buildCharacterSheetDocDefinition,
  exportCharacterSheetPdf,
  slugifyCharacterName,
} from './characterSheetPdf';

// --- Fixtures -----------------------------------------------------------------

function character(partial: Partial<CharacterStats> = {}): CharacterStats {
  return {
    id: partial.id ?? 'char-1',
    name: partial.name ?? 'Aria Stormborn',
    level: partial.level ?? 5,
    class: partial.class ?? 'Wizard',
    race: partial.race ?? 'Elf',
    hp: partial.hp ?? { current: 27, max: 32 },
    xp: partial.xp ?? { current: 6500, max: 14000 },
    stats: partial.stats ?? {
      str: 8,
      dex: 14,
      con: 13,
      int: 18,
      wis: 12,
      cha: 10,
    },
    equipment: partial.equipment ?? {
      armor: 'Mage Armor',
      weapons: ['Quarterstaff', 'Dagger'],
      other: [],
    },
    armorClass: partial.armorClass ?? 15,
    speed: partial.speed ?? 30,
    currencies: partial.currencies,
    knownSpells: partial.knownSpells,
    preparedSpells: partial.preparedSpells,
    cantripsKnown: partial.cantripsKnown,
    ...partial,
  };
}

function item(partial: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: partial.id ?? 'i1',
    name: partial.name ?? 'Healing Potion',
    description: partial.description ?? '',
    quantity: partial.quantity ?? 1,
    type: partial.type ?? 'consumable',
    ...partial,
  };
}

const FIXED_TS = 1700000000000; // 2023-11-14T22:13:20.000Z (deterministic)

// Recursively collect every string leaf in the doc-def so we can assert content
// is present regardless of which nested table/stack node carries it.
function collectText(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === 'string') {
    acc.push(node);
  } else if (typeof node === 'number') {
    acc.push(String(node));
  } else if (Array.isArray(node)) {
    for (const child of node) collectText(child, acc);
  } else if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectText(value, acc);
    }
  }
  return acc;
}

describe('buildCharacterSheetDocDefinition', () => {
  it('returns a plain pdfmake document-definition object with a content array', () => {
    const docDef = buildCharacterSheetDocDefinition(character(), {
      generatedAt: FIXED_TS,
    });
    expect(docDef).toBeTypeOf('object');
    expect(Array.isArray(docDef.content)).toBe(true);
  });

  it('is pure/deterministic: same character + timestamp => deep-equal doc-def', () => {
    const char = character();
    const a = buildCharacterSheetDocDefinition(char, { generatedAt: FIXED_TS });
    const b = buildCharacterSheetDocDefinition(char, { generatedAt: FIXED_TS });
    expect(a).toEqual(b);
    // Plain JSON: a structural round-trip must be lossless (no class instances,
    // functions, Dates, or other non-serialisable nodes leak in).
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('renders the injected timestamp (never Date.now) in the document', () => {
    const docDef = buildCharacterSheetDocDefinition(character(), {
      generatedAt: FIXED_TS,
    });
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain(new Date(FIXED_TS).toISOString());
  });

  it("includes the character's name as the title", () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({ name: 'Borin Ironfist' }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain('Borin Ironfist');
  });

  it('includes level, class and race', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({ level: 7, class: 'Paladin', race: 'Human' }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain('Paladin');
    expect(text).toContain('Human');
    // Assert the exact label so an incidental '7' elsewhere can't false-pass.
    expect(text).toContain('Level 7');
  });

  it('includes every ability score (STR/DEX/CON/INT/WIS/CHA) and its value', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({
        stats: { str: 16, dex: 12, con: 15, int: 9, wis: 13, cha: 11 },
      }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    for (const label of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
      expect(text).toContain(label);
    }
    for (const value of ['16', '12', '15', '9', '13', '11']) {
      expect(text).toContain(value);
    }
  });

  it('includes HP (current/max) and AC', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({ hp: { current: 18, max: 24 }, armorClass: 17 }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain('18');
    expect(text).toContain('24');
    expect(text).toContain('17'); // AC
    expect(text.toUpperCase()).toContain('HP');
    expect(text.toUpperCase()).toContain('AC');
  });

  it('lists inventory items when provided', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character(),
      {
        generatedAt: FIXED_TS,
        inventory: [
          item({ id: 'a', name: 'Rope (50 ft)' }),
          item({ id: 'b', name: 'Torch', quantity: 3 }),
        ],
      }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain('Rope (50 ft)');
    expect(text).toContain('Torch');
  });

  it('lists spells when the character has any', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({
        cantripsKnown: ['Fire Bolt', 'Mage Hand'],
        knownSpells: ['Magic Missile', 'Shield'],
      }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain('Fire Bolt');
    expect(text).toContain('Magic Missile');
  });

  it('omits the spells section entirely for a non-caster (no empty heading)', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({
        cantripsKnown: undefined,
        knownSpells: undefined,
        preparedSpells: undefined,
      }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text.toUpperCase()).not.toContain('SPELLS');
  });

  it('renders equipment.other items as an "Other:" line', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({
        equipment: {
          armor: 'Plate',
          weapons: ['Longsword'],
          other: ['Torch', 'Rope'],
        },
      }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain('Other: Torch, Rope');
  });

  it('omits the "Other:" line when equipment.other is empty', () => {
    const docDef = buildCharacterSheetDocDefinition(
      character({
        equipment: { armor: 'Plate', weapons: ['Longsword'], other: [] },
      }),
      { generatedAt: FIXED_TS }
    );
    const text = collectText(docDef.content).join('\n');
    expect(text).not.toContain('Other:');
  });

  it('does not throw on a minimal character with empty inventory/equipment', () => {
    const minimal = character({
      equipment: { armor: 'None', weapons: [], other: [] },
    });
    expect(() =>
      buildCharacterSheetDocDefinition(minimal, {
        generatedAt: FIXED_TS,
        inventory: [],
      })
    ).not.toThrow();
  });
});

describe('slugifyCharacterName', () => {
  it('lowercases and dashes a name into a filesystem-safe stem', () => {
    expect(slugifyCharacterName('Aria Stormborn')).toBe('aria-stormborn');
    expect(slugifyCharacterName("  O'Malley the Bold!  ")).toBe(
      'o-malley-the-bold'
    );
  });

  it('falls back to a default stem for an empty/symbol-only name', () => {
    expect(slugifyCharacterName('   ')).toBe('character-sheet');
    expect(slugifyCharacterName('***')).toBe('character-sheet');
  });
});

describe('exportCharacterSheetPdf', () => {
  beforeEach(() => {
    mkdir.mockClear();
    writeFile.mockClear();
    appDataDir.mockClear();
    join.mockClear();
    createPdf.mockClear();
    getBuffer.mockClear();

    gameStateState = {
      activeCharacter: character({ name: 'Aria Stormborn' }),
      inventory: [item({ id: 'a', name: 'Spellbook' })],
    };
  });

  it('renders via pdfmake and writes a BINARY .pdf under exports/', async () => {
    const path = await exportCharacterSheetPdf(undefined, FIXED_TS);

    // The pure builder's output is what pdfmake renders.
    expect(createPdf).toHaveBeenCalledTimes(1);
    const docDefArg = createPdf.mock.calls[0][0] as { content: unknown };
    expect(Array.isArray(docDefArg.content)).toBe(true);
    expect(getBuffer).toHaveBeenCalledTimes(1);

    // Directory is created recursively under <appDataDir>/exports.
    expect(appDataDir).toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining('/exports'),
      expect.objectContaining({ recursive: true })
    );

    // The file is written as BINARY bytes (writeFile + Uint8Array), NOT text.
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenData] = writeFile.mock.calls[0];
    expect(writtenPath).toMatch(/\/exports\/.*\.pdf$/);
    expect(writtenPath).toBe(path);
    expect(writtenData).toBeInstanceOf(Uint8Array);
    expect(writtenData).toBe(FAKE_PDF_BYTES);

    // Paths are composed via Tauri's `join`, not hardcoded "/" concatenation.
    expect(join).toHaveBeenCalledWith('/mock/app/data', 'exports');
    expect(join).toHaveBeenCalledWith(
      '/mock/app/data/exports',
      'aria-stormborn.pdf'
    );
    expect(writtenPath).toBe('/mock/app/data/exports/aria-stormborn.pdf');
  });

  it('slugifies the active character name into the filename', async () => {
    const path = await exportCharacterSheetPdf(undefined, FIXED_TS);
    expect(path.toLowerCase()).toContain('aria-stormborn');
  });

  it('accepts an injected character (used instead of the store)', async () => {
    gameStateState = { activeCharacter: null, inventory: [] };
    const injected = character({ name: 'Borin Ironfist' });

    const path = await exportCharacterSheetPdf(injected, FIXED_TS);

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(path.toLowerCase()).toContain('borin-ironfist');
  });

  it('attaches the store inventory only when exporting the ACTIVE character', async () => {
    // Active character (id char-1) carries a Spellbook in the store.
    gameStateState = {
      activeCharacter: character({ id: 'char-1', name: 'Aria Stormborn' }),
      activeCharacterId: 'char-1',
      inventory: [item({ id: 'a', name: 'Spellbook' })],
    };

    await exportCharacterSheetPdf(
      character({ id: 'char-1', name: 'Aria Stormborn' }),
      FIXED_TS
    );

    const docDef = createPdf.mock.calls[0][0] as { content: unknown[] };
    const text = collectText(docDef.content).join('\n');
    expect(text).toContain('Spellbook'); // active char's inventory is present
    expect(text).not.toContain('No items carried.');
  });

  it('does NOT attach the active inventory to a DIFFERENT character', async () => {
    // Store's active character is char-1 with a Spellbook; we export char-2.
    gameStateState = {
      activeCharacter: character({ id: 'char-1', name: 'Aria Stormborn' }),
      activeCharacterId: 'char-1',
      inventory: [item({ id: 'a', name: 'Spellbook' })],
    };

    const other = character({ id: 'char-2', name: 'Borin Ironfist' });
    await exportCharacterSheetPdf(other, FIXED_TS);

    const docDef = createPdf.mock.calls[0][0] as { content: unknown[] };
    const text = collectText(docDef.content).join('\n');
    // The active character's Spellbook must NOT leak onto a different character.
    expect(text).not.toContain('Spellbook');
    expect(text).toContain('No items carried.');
  });

  it('does NOT attach the active inventory when BOTH ids are undefined', async () => {
    // CharacterStats.id is `string | undefined`. A bare `===` comparison would
    // treat two undefined ids as equal, wrongly leaking the active character's
    // inventory onto an unrelated character that also lacks an id.
    gameStateState = {
      activeCharacter: character({ id: undefined, name: 'Aria Stormborn' }),
      inventory: [item({ id: 'a', name: 'Spellbook' })],
    };

    const other = character({ id: undefined, name: 'Borin Ironfist' });
    await exportCharacterSheetPdf(other, FIXED_TS);

    const docDef = createPdf.mock.calls[0][0] as { content: unknown[] };
    const text = collectText(docDef.content).join('\n');
    // The active character's Spellbook must NOT leak onto a different character
    // just because neither has an id.
    expect(text).not.toContain('Spellbook');
    expect(text).toContain('No items carried.');
  });

  it('rejects (without writing) when there is no active character', async () => {
    gameStateState = { activeCharacter: null, inventory: [] };

    await expect(exportCharacterSheetPdf(undefined, FIXED_TS)).rejects.toThrow();
    expect(writeFile).not.toHaveBeenCalled();
    expect(createPdf).not.toHaveBeenCalled();
  });
});
