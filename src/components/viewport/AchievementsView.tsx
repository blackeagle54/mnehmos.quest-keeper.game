import React from 'react';
import { useGameStateStore } from '../../stores/gameStateStore';
import { usePartyStore } from '../../stores/partyStore';
import { useAchievementStore, type Achievement } from '../../stores/achievementStore';

// ============================================
// Card
// ============================================

interface AchievementCardProps {
  achievement: Achievement;
}

const AchievementCard: React.FC<AchievementCardProps> = ({ achievement }) => {
  const unlocked = achievement.unlocked === true;
  // A hidden achievement that is still locked is shown as a generic mystery
  // card. (The engine omits hidden&&!unlocked when a characterId is supplied, so
  // this mostly matters for previews / non-character listings.)
  const masked = achievement.hidden === true && !unlocked;

  // Incremental achievements expose a target; show a progress bar for those that
  // are still locked so the player can see how close they are. A masked
  // (hidden + still-locked) achievement must NOT leak its progress/target — the
  // whole point of hiding it — so it never gets a bar.
  const hasProgress =
    !masked &&
    typeof achievement.target === 'number' &&
    achievement.target > 0 &&
    !unlocked;
  const progress = achievement.progress ?? 0;
  const target = achievement.target ?? 0;
  const pct =
    hasProgress && target > 0
      ? Math.max(0, Math.min(100, Math.round((progress / target) * 100)))
      : 0;

  return (
    <div
      data-testid="achievement-card"
      data-state={unlocked ? 'unlocked' : 'locked'}
      className={`border p-4 rounded transition-colors ${
        unlocked
          ? 'border-terminal-green bg-terminal-green/10'
          : 'border-terminal-green/20 bg-terminal-black/40 opacity-80'
      }`}
    >
      {/* Hidden duplicate test-id markers so getAllByTestId can split the two
          visual states without coupling tests to class names. */}
      {unlocked ? (
        <span data-testid="achievement-card-unlocked" className="sr-only" />
      ) : (
        <span data-testid="achievement-card-locked" className="sr-only" />
      )}

      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xl shrink-0">{unlocked ? '🏆' : masked ? '❓' : '🔒'}</span>
          <span
            className={`font-bold uppercase tracking-wider truncate ${
              unlocked ? 'text-terminal-green' : 'text-terminal-green/60'
            }`}
          >
            {masked ? '???' : achievement.name}
          </span>
        </div>
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${
            unlocked
              ? 'bg-terminal-green text-terminal-black'
              : 'border border-terminal-green/40 text-terminal-green/60'
          }`}
        >
          {achievement.points} PTS
        </span>
      </div>

      <p className="text-xs text-terminal-green/60 mb-2">
        {masked ? 'A hidden achievement. Keep playing to reveal it.' : achievement.description}
      </p>

      {hasProgress && (
        <div data-testid="achievement-progress">
          <div className="h-2 w-full bg-terminal-black border border-terminal-green/40 rounded overflow-hidden">
            <div
              className="h-full bg-terminal-green transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 text-xs text-terminal-green/50 text-right">
            {progress.toLocaleString()} / {target.toLocaleString()}
          </div>
        </div>
      )}

      {unlocked && achievement.unlockedAt && (
        <div className="text-xs text-terminal-green/40">
          Unlocked {new Date(achievement.unlockedAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
};

// ============================================
// View
// ============================================

export const AchievementsView: React.FC = () => {
  // Active character: gameStateStore is the POV source of truth; fall back to
  // the party's active member if gameState hasn't resolved one yet.
  const activeCharacterId = useGameStateStore((s) => s.activeCharacterId);
  const activeMember = usePartyStore((s) => s.getActiveCharacterMember());
  const characterId = activeCharacterId ?? activeMember?.characterId ?? null;

  const achievementsByCharacter = useAchievementStore((s) => s.achievementsByCharacter);
  const selectedCategory = useAchievementStore((s) => s.selectedCategory);
  const setSelectedCategory = useAchievementStore((s) => s.setSelectedCategory);
  const isLoading = useAchievementStore((s) => s.isLoading);
  const error = useAchievementStore((s) => s.error);
  const syncAchievements = useAchievementStore((s) => s.syncAchievements);

  React.useEffect(() => {
    if (characterId) {
      syncAchievements(characterId);
    }
  }, [characterId, syncAchievements]);

  const entry = characterId ? achievementsByCharacter[characterId] ?? null : null;
  const catalog: Achievement[] = entry?.catalog ?? [];

  // Distinct categories present in the catalog, for the filter row.
  const categories = React.useMemo(() => {
    const set = new Set<string>();
    for (const a of catalog) set.add(a.category);
    return Array.from(set).sort();
  }, [catalog]);

  // A persisted selectedCategory can outlive the catalog it was chosen from
  // (different character / world, or the category no longer has entries). Filter
  // by it ONLY when it still exists in the current catalog; otherwise treat it
  // as "all" so a stale filter doesn't silently empty the grid.
  const effectiveCategory =
    selectedCategory && categories.includes(selectedCategory) ? selectedCategory : null;

  const visible = effectiveCategory
    ? catalog.filter((a) => a.category === effectiveCategory)
    : catalog;

  if (!characterId) {
    return (
      <div className="h-full w-full flex items-center justify-center p-8 text-terminal-green/60">
        <div className="text-center space-y-4">
          <p className="text-xl">NO CHARACTER SELECTED</p>
          <p className="text-sm">Select a character to view achievements.</p>
        </div>
      </div>
    );
  }

  const unlockedCount = entry?.unlockedCount ?? 0;
  const totalCount = entry?.totalCount ?? catalog.length;
  const totalPoints = entry?.totalPoints ?? 0;

  return (
    <div className="h-full w-full overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-terminal-green/20 scrollbar-track-transparent">
      <div className="border-b-2 border-terminal-green pb-4 mb-4 flex items-center justify-between">
        <h2 className="text-2xl font-bold uppercase tracking-widest text-terminal-green flex items-center gap-2">
          <span>🏆</span> Achievements
        </h2>
        <button
          onClick={() => characterId && syncAchievements(characterId)}
          className="text-xs border border-terminal-green px-2 py-1 text-terminal-green hover:bg-terminal-green/10 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Totals header */}
      <div
        data-testid="achievement-totals"
        className="mb-4 flex flex-wrap items-center gap-4 text-sm text-terminal-green"
      >
        <span className="font-bold">
          {unlockedCount} / {totalCount} unlocked
        </span>
        <span className="text-terminal-green/70">{totalPoints} points</span>
        {entry?.characterName && (
          <span className="text-terminal-green/40">— {entry.characterName}</span>
        )}
      </div>

      {error && (
        <div className="mb-4 border border-terminal-red/50 bg-terminal-red/10 text-terminal-red px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}

      {isLoading && catalog.length === 0 && (
        <div className="text-terminal-green/60 mb-4">Loading achievements…</div>
      )}

      {/* Category filter */}
      {categories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            data-testid="achievement-filter-all"
            onClick={() => setSelectedCategory(null)}
            className={`text-xs px-3 py-1 rounded border transition-colors ${
              // Highlight "All" when no EFFECTIVE filter is active, so a stale
              // selectedCategory (resolved to null) doesn't leave nothing lit.
              effectiveCategory === null
                ? 'bg-terminal-green text-terminal-black border-terminal-green'
                : 'border-terminal-green/40 text-terminal-green/70 hover:bg-terminal-green/10'
            }`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              data-testid={`achievement-filter-${cat}`}
              onClick={() => setSelectedCategory(cat)}
              className={`text-xs px-3 py-1 rounded border uppercase tracking-wider transition-colors ${
                effectiveCategory === cat
                  ? 'bg-terminal-green text-terminal-black border-terminal-green'
                  : 'border-terminal-green/40 text-terminal-green/70 hover:bg-terminal-green/10'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Empty-state: render whenever nothing is visible (not only when the
          catalog is empty), distinguishing a genuinely empty catalog from a
          filter that matched nothing — otherwise a stale/empty filter leaves an
          unexplained blank grid. */}
      {!isLoading && visible.length === 0 && !error && (
        <div className="text-terminal-green/60">
          {catalog.length === 0
            ? 'No achievements defined yet.'
            : 'No achievements in this category.'}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {visible.map((a) => (
          <AchievementCard key={a.id} achievement={a} />
        ))}
      </div>
    </div>
  );
};
