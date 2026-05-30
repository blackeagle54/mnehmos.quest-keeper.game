/**
 * PDF character-sheet export (Phase 5).
 *
 * PURE FRONTEND: renders a printable PDF of the active character from the data
 * already in-store (gameStateStore). No engine / MCP calls are made here — this
 * is a render of current state, not a fetch.
 *
 * Design notes (mirrors `adventureLogExport.ts`):
 *  - `buildCharacterSheetDocDefinition` is PURE and DETERMINISTIC. It returns a
 *    pdfmake *document-definition object* (plain JSON: strings, numbers, arrays,
 *    objects — no Dates/functions/class instances). The "generated at" timestamp
 *    is INJECTED (never Date.now()), so identical input always yields a deep-
 *    equal doc-def. This object is the testable seam: we assert on its structure
 *    without ever rendering a real PDF.
 *  - `exportCharacterSheetPdf` is the impure boundary: it reads the store (or
 *    accepts an injected character), reads the clock once (or accepts an
 *    injected `now`), calls the pure builder, renders the doc-def to BYTES via
 *    pdfmake, and writes the file. The PDF is BINARY, so it is written with
 *    `writeFile` (Uint8Array) — never `writeTextFile`.
 */
import type { CharacterStats, InventoryItem } from '../stores/gameStateStore';

// --- Public option shapes -----------------------------------------------------

export interface BuildCharacterSheetOptions {
  /**
   * Generation timestamp (ms epoch), INJECTED for determinism. Never read the
   * clock inside the pure builder.
   */
  generatedAt: number;
  /**
   * Optional carried inventory (the gameStateStore keeps inventory separate
   * from the character record). Defaults to an empty list.
   */
  inventory?: InventoryItem[];
}

// --- Pure helpers -------------------------------------------------------------

/** Ability modifier from a raw score (D&D 5e: floor((score - 10) / 2)). */
function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Format a modifier with an explicit sign (e.g. +3, -1, +0). */
function formatModifier(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

/** Slugify a character name into a filesystem-safe filename stem. */
export function slugifyCharacterName(name: string): string {
  const slug = (name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumerics -> single dash
    .replace(/^-+|-+$/g, ''); // trim leading/trailing dashes
  return slug || 'character-sheet';
}

/**
 * Collapse a spell list into a deduplicated, order-preserving array of
 * non-empty trimmed names. Returns an empty array for absent/empty input.
 */
function normalizeSpellList(spells?: string[]): string[] {
  if (!Array.isArray(spells)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of spells) {
    const name = (raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// --- Pure document builder ----------------------------------------------------

// Ability scores rendered in a stable, canonical order for determinism.
const ABILITIES: ReadonlyArray<{ key: keyof CharacterStats['stats']; label: string }> = [
  { key: 'str', label: 'STR' },
  { key: 'dex', label: 'DEX' },
  { key: 'con', label: 'CON' },
  { key: 'int', label: 'INT' },
  { key: 'wis', label: 'WIS' },
  { key: 'cha', label: 'CHA' },
];

/**
 * Build a pdfmake document-definition object for a character sheet. Pure &
 * deterministic: identical `character` + `opts` (including `generatedAt`) always
 * produce a deep-equal object.
 *
 * The returned object is plain JSON — no functions, Dates, or class instances —
 * so it round-trips through JSON.stringify losslessly and is trivially
 * assertable in tests.
 */
export function buildCharacterSheetDocDefinition(
  character: CharacterStats,
  opts: BuildCharacterSheetOptions
): { content: unknown[]; styles: Record<string, unknown>; defaultStyle: Record<string, unknown>; pageMargins: number[] } {
  const { generatedAt, inventory } = opts;

  const content: unknown[] = [];

  // --- Title + metadata -------------------------------------------------------
  content.push({ text: character.name, style: 'title' });

  const subtitleBits: string[] = [`Level ${character.level}`];
  if (character.race) subtitleBits.push(character.race);
  if (character.class) subtitleBits.push(character.class);
  content.push({ text: subtitleBits.join(' • '), style: 'subtitle' });

  content.push({
    text: `Generated: ${new Date(generatedAt).toISOString()}`,
    style: 'meta',
  });

  // --- Vitals (HP / AC / Speed) ----------------------------------------------
  content.push({ text: 'VITALS', style: 'sectionHeader' });
  content.push({
    style: 'table',
    table: {
      widths: ['*', '*', '*'],
      body: [
        ['HP', 'AC', 'SPEED'],
        [
          `${character.hp.current} / ${character.hp.max}`,
          character.armorClass != null ? String(character.armorClass) : '—',
          `${character.speed ?? 30} ft`,
        ],
      ],
    },
  });

  // --- Ability scores ---------------------------------------------------------
  content.push({ text: 'ABILITY SCORES', style: 'sectionHeader' });
  const abilityHeader = ABILITIES.map((a) => a.label);
  const abilityScores = ABILITIES.map((a) => String(character.stats[a.key]));
  const abilityMods = ABILITIES.map((a) =>
    formatModifier(abilityModifier(character.stats[a.key]))
  );
  content.push({
    style: 'table',
    table: {
      widths: ['*', '*', '*', '*', '*', '*'],
      body: [abilityHeader, abilityScores, abilityMods],
    },
  });

  // --- Equipment --------------------------------------------------------------
  content.push({ text: 'EQUIPMENT', style: 'sectionHeader' });
  const weapons = character.equipment?.weapons ?? [];
  const equipmentLines: string[] = [
    `Armor: ${character.equipment?.armor || 'None'}`,
    weapons.length > 0 ? `Weapons: ${weapons.join(', ')}` : 'Weapons: None',
  ];
  content.push({ ul: equipmentLines, style: 'list' });

  // --- Inventory --------------------------------------------------------------
  content.push({ text: 'INVENTORY', style: 'sectionHeader' });
  const items = inventory ?? [];
  if (items.length === 0) {
    content.push({ text: 'No items carried.', style: 'empty' });
  } else {
    content.push({
      ul: items.map((it) => {
        const qty = it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : '';
        return `${it.name}${qty}`;
      }),
      style: 'list',
    });
  }

  // --- Spells (only for casters) ---------------------------------------------
  const cantrips = normalizeSpellList(character.cantripsKnown);
  // Prefer the explicit known list; fall back to prepared so prepared-casters
  // (e.g. Clerics) still render a spell list.
  const spells = normalizeSpellList(
    character.knownSpells && character.knownSpells.length > 0
      ? character.knownSpells
      : character.preparedSpells
  );
  if (cantrips.length > 0 || spells.length > 0) {
    content.push({ text: 'SPELLS', style: 'sectionHeader' });
    if (cantrips.length > 0) {
      content.push({ text: `Cantrips: ${cantrips.join(', ')}`, style: 'list' });
    }
    if (spells.length > 0) {
      content.push({ text: `Spells: ${spells.join(', ')}`, style: 'list' });
    }
  }

  return {
    content,
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { fontSize: 10 },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 12, margin: [0, 0, 0, 2] },
      meta: { fontSize: 8, color: '#666666', margin: [0, 0, 0, 12] },
      sectionHeader: { fontSize: 13, bold: true, margin: [0, 12, 0, 4] },
      table: { margin: [0, 0, 0, 8] },
      list: { margin: [0, 0, 0, 8] },
      empty: { italics: true, color: '#888888', margin: [0, 0, 0, 8] },
    },
  };
}

// --- Impure export boundary ---------------------------------------------------

/**
 * Render the active character's sheet to a PDF and write it under
 * `<appDataDir>/exports/<slug>.pdf`.
 *
 * @param character Optional character to export; defaults to the gameStateStore's
 *                  active character. If neither is available the call rejects so
 *                  the UI can show an error state (no file is written).
 * @param now       Optional injected timestamp (ms epoch). Defaults to Date.now()
 *                  read ONCE here at the boundary — never inside the pure builder.
 * @returns The absolute path of the written PDF.
 * @throws  If there is no character to export.
 */
export async function exportCharacterSheetPdf(
  character?: CharacterStats,
  now: number = Date.now()
): Promise<string> {
  // Lazy store import keeps this module tree-shakeable and test-mockable.
  const { useGameStateStore } = await import('../stores/gameStateStore');
  const gameState = useGameStateStore.getState();

  const target = character ?? gameState.activeCharacter;
  if (!target) {
    throw new Error('No active character to export.');
  }

  // `gameState.inventory` is the ACTIVE character's carried items, NOT a
  // per-character store. Only attach it when the character being exported IS the
  // active character; otherwise a non-active export would wrongly carry the
  // active character's inventory. Per-character inventory for non-active chars
  // isn't synced into the store, so it correctly falls back to empty.
  const isActiveCharacter =
    !character ||
    (gameState.activeCharacter != null &&
      gameState.activeCharacter.id === character.id);
  const inventory = isActiveCharacter ? (gameState.inventory ?? []) : [];

  const docDefinition = buildCharacterSheetDocDefinition(target, {
    generatedAt: now,
    inventory,
  });

  // Render the doc-def to BYTES. pdfmake 0.3.x's getBuffer() returns a Node
  // Buffer (a Uint8Array subclass), which writeFile accepts directly.
  const { default: pdfMake } = await import('pdfmake/build/pdfmake');
  const { default: pdfFonts } = await import('pdfmake/build/vfs_fonts');
  // Wire the bundled virtual font filesystem so the standard fonts resolve in
  // the browser/Tauri webview. Older builds expose `pdfFonts.pdfMake.vfs`;
  // 0.3.x exposes `pdfFonts.vfs` — support both.
  const vfs =
    (pdfFonts as { vfs?: unknown; pdfMake?: { vfs?: unknown } })?.vfs ??
    (pdfFonts as { pdfMake?: { vfs?: unknown } })?.pdfMake?.vfs;
  if (vfs) {
    (pdfMake as { vfs?: unknown }).vfs = vfs;
  }

  const buffer = await pdfMake
    .createPdf(docDefinition as never)
    .getBuffer();
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer);

  // I/O: write under <appDataDir>/exports/<slug>.pdf. Compose paths with
  // Tauri's `join` so the separator is correct on every platform.
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs');

  const dir = await appDataDir();
  const exportsDir = await join(dir, 'exports');
  await mkdir(exportsDir, { recursive: true });

  const filePath = await join(
    exportsDir,
    `${slugifyCharacterName(target.name)}.pdf`
  );
  await writeFile(filePath, bytes);

  return filePath;
}
