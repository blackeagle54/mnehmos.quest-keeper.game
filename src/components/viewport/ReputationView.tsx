import React from 'react';
import { useGameStateStore } from '../../stores/gameStateStore';
import { usePartyStore } from '../../stores/partyStore';
import { useReputationStore, type Faction, type Standing } from '../../stores/reputationStore';

// ============================================
// Standing presentation
// ============================================

// The clamp bounds and standing ladder are mirrored locally (not imported from
// the store) so the view stays renderable when tests mock the whole store
// module — exactly as AchievementsView depends only on its hook. These match the
// FROZEN engine tiers; the store owns the canonical copies.
const REPUTATION_MIN = -1000;
const REPUTATION_MAX = 1000;

/**
 * Local fallback standing derivation, mirroring the store's standingFromValue.
 * Only used to annotate a bare faction (no value/standing) so the card never
 * renders NaN / blank; the store normally supplies the engine standing.
 */
function deriveStanding(value: number): Standing {
  const v = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, value));
  if (v >= 1000) return 'Exalted';
  if (v >= 600) return 'Revered';
  if (v >= 300) return 'Honored';
  if (v >= 100) return 'Friendly';
  if (v >= 0) return 'Neutral';
  if (v >= -100) return 'Unfriendly';
  if (v >= -500) return 'Hostile';
  return 'Hated';
}

/**
 * Color grading for each standing tier, Hated -> Exalted. Uses the terminal
 * palette so the badge reads as a temperature: red for hostile, green for
 * friendly, gold-ish for the top tiers. Tailwind classes only (no dynamic
 * class names) so the JIT keeps them.
 */
const STANDING_STYLES: Record<Standing, { badge: string; bar: string }> = {
  Hated: { badge: 'bg-terminal-red text-terminal-black', bar: 'bg-terminal-red' },
  Hostile: { badge: 'bg-terminal-red/70 text-terminal-black', bar: 'bg-terminal-red/70' },
  Unfriendly: { badge: 'bg-terminal-red/40 text-terminal-red', bar: 'bg-terminal-red/50' },
  Neutral: { badge: 'border border-terminal-green/40 text-terminal-green/60', bar: 'bg-terminal-green/30' },
  Friendly: { badge: 'bg-terminal-green/40 text-terminal-green', bar: 'bg-terminal-green/60' },
  Honored: { badge: 'bg-terminal-green/70 text-terminal-black', bar: 'bg-terminal-green/80' },
  Revered: { badge: 'bg-terminal-green text-terminal-black', bar: 'bg-terminal-green' },
  Exalted: { badge: 'bg-terminal-amber text-terminal-black', bar: 'bg-terminal-amber' },
};

const NEUTRAL_STYLE = STANDING_STYLES.Neutral;

// ============================================
// Card
// ============================================

interface FactionCardProps {
  faction: Faction;
}

const FactionCard: React.FC<FactionCardProps> = ({ faction }) => {
  // A faction with no per-character entry defaults to value 0 / Neutral. Be
  // pessimistic about the incoming shape: a store handing us a bare entry (no
  // value/standing) must still render Neutral / 0 rather than NaN / blank.
  const value = typeof faction.value === 'number' ? faction.value : 0;
  const standing: Standing = faction.standing ?? deriveStanding(value);
  const style = STANDING_STYLES[standing] ?? NEUTRAL_STYLE;

  // Position the value within [-1000, 1000] for the bar. 0 sits at the midpoint
  // so a positive standing fills right and a negative one fills left.
  const clamped = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, value));
  const pct = Math.round(((clamped - REPUTATION_MIN) / (REPUTATION_MAX - REPUTATION_MIN)) * 100);

  return (
    <div
      data-testid="faction-card"
      data-standing={standing}
      className="border border-terminal-green/30 bg-terminal-black/40 p-4 rounded transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xl shrink-0">🤝</span>
          <span className="font-bold uppercase tracking-wider truncate text-terminal-green">
            {faction.name}
          </span>
        </div>
        <span
          data-testid="faction-standing"
          className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${style.badge}`}
        >
          {standing}
        </span>
      </div>

      {faction.description && (
        <p className="text-xs text-terminal-green/60 mb-2">{faction.description}</p>
      )}

      {/* Rep bar: value visualized within [-1000, 1000], midpoint = 0. */}
      <div data-testid="faction-bar">
        <div className="relative h-2 w-full bg-terminal-black border border-terminal-green/40 rounded overflow-hidden">
          {/* Center tick at the 0 midpoint. */}
          <div className="absolute inset-y-0 left-1/2 w-px bg-terminal-green/30" />
          <div
            className={`h-full transition-all duration-300 ${style.bar}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-terminal-green/50">
          <span>{REPUTATION_MIN}</span>
          <span data-testid="faction-value" className="font-bold text-terminal-green/80">
            {value.toLocaleString()}
          </span>
          <span>{REPUTATION_MAX}</span>
        </div>
      </div>
    </div>
  );
};

// ============================================
// View
// ============================================

export const ReputationView: React.FC = () => {
  // Active character: gameStateStore is the POV source of truth; fall back to
  // the party's active member if gameState hasn't resolved one yet.
  const activeCharacterId = useGameStateStore((s) => s.activeCharacterId);
  const activeMember = usePartyStore((s) => s.getActiveCharacterMember());
  const characterId = activeCharacterId ?? activeMember?.characterId ?? null;

  const reputationByCharacter = useReputationStore((s) => s.reputationByCharacter);
  const isLoading = useReputationStore((s) => s.isLoading);
  const error = useReputationStore((s) => s.error);
  const syncReputation = useReputationStore((s) => s.syncReputation);

  React.useEffect(() => {
    if (characterId) {
      syncReputation(characterId);
    }
  }, [characterId, syncReputation]);

  const entry = characterId ? reputationByCharacter[characterId] ?? null : null;
  const factions: Faction[] = entry?.factions ?? [];

  if (!characterId) {
    return (
      <div className="h-full w-full flex items-center justify-center p-8 text-terminal-green/60">
        <div className="text-center space-y-4">
          <p className="text-xl">NO CHARACTER SELECTED</p>
          <p className="text-sm">Select a character to view reputation.</p>
        </div>
      </div>
    );
  }

  const factionCount = entry?.factionCount ?? factions.length;

  return (
    <div className="h-full w-full overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-terminal-green/20 scrollbar-track-transparent">
      <div className="border-b-2 border-terminal-green pb-4 mb-4 flex items-center justify-between">
        <h2 className="text-2xl font-bold uppercase tracking-widest text-terminal-green flex items-center gap-2">
          <span>🤝</span> Reputation
        </h2>
        <button
          onClick={() => characterId && syncReputation(characterId)}
          className="text-xs border border-terminal-green px-2 py-1 text-terminal-green hover:bg-terminal-green/10 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Totals header */}
      <div
        data-testid="reputation-totals"
        className="mb-4 flex flex-wrap items-center gap-4 text-sm text-terminal-green"
      >
        <span className="font-bold">{factionCount} factions</span>
        {entry?.characterName && (
          <span className="text-terminal-green/40">— {entry.characterName}</span>
        )}
      </div>

      {error && (
        <div className="mb-4 border border-terminal-red/50 bg-terminal-red/10 text-terminal-red px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}

      {isLoading && factions.length === 0 && (
        <div className="text-terminal-green/60 mb-4">Loading reputation…</div>
      )}

      {/* Empty-state: no factions to show (and not currently loading / erroring). */}
      {!isLoading && factions.length === 0 && !error && (
        <div className="text-terminal-green/60">No factions defined yet.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {factions.map((f) => (
          <FactionCard key={f.id} faction={f} />
        ))}
      </div>
    </div>
  );
};
