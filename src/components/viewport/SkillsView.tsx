import React from 'react';
import { useGameStateStore } from '../../stores/gameStateStore';
import { usePartyStore } from '../../stores/partyStore';
import { useSkillStore, type SkillMap } from '../../stores/skillStore';
import { SKILL_NAMES, MAX_SKILL_LEVEL, type SkillName } from '../../data/skills';
import { xpProgress } from '../../utils/skillXp';

// Per-skill flavor for the terminal UI. Keyed by SKILL_NAMES so it can never
// drift from the canonical list.
const SKILL_META: Record<SkillName, { label: string; icon: string }> = {
  combat: { label: 'Combat', icon: '⚔️' },
  magic: { label: 'Magic', icon: '✨' },
  crafting: { label: 'Crafting', icon: '🛠️' },
  gathering: { label: 'Gathering', icon: '🌿' },
  social: { label: 'Social', icon: '💬' },
};

interface SkillBarProps {
  skill: SkillName;
  entry: { xp: number; level: number };
}

const SkillBar: React.FC<SkillBarProps> = ({ skill, entry }) => {
  // Derive progress from the authoritative XP (engine sends only {xp, level}
  // per skill via get_skills; the curve mirror turns that into a bar fraction).
  const progress = xpProgress(entry.xp);
  const meta = SKILL_META[skill];

  // Fraction of the current level completed. The level span is
  // (xpIntoLevel + xpToNext); guard against a zero span (only possible at max).
  const span = progress.xpIntoLevel + progress.xpToNext;
  const pct = progress.atMax
    ? 100
    : span > 0
      ? Math.max(0, Math.min(100, Math.round((progress.xpIntoLevel / span) * 100)))
      : 0;

  return (
    <div
      data-testid="skill-bar"
      className="border border-terminal-green/30 bg-terminal-green/5 p-4 rounded"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{meta.icon}</span>
          <span className="font-bold uppercase tracking-wider text-terminal-green">
            {meta.label}
          </span>
        </div>
        <span className="text-sm font-bold bg-terminal-green text-terminal-black px-2 rounded">
          LVL {progress.level}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-3 w-full bg-terminal-black border border-terminal-green/40 rounded overflow-hidden">
        <div
          className="h-full bg-terminal-green transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1 flex justify-between text-xs text-terminal-green/60">
        {progress.atMax ? (
          <span className="text-terminal-green-bright">MAX LEVEL ({MAX_SKILL_LEVEL})</span>
        ) : (
          <>
            <span>{progress.xpIntoLevel.toLocaleString()} XP into level</span>
            <span>{progress.xpToNext.toLocaleString()} to next</span>
          </>
        )}
      </div>
      <div className="mt-0.5 text-xs text-terminal-green/40">
        {entry.xp.toLocaleString()} total XP
      </div>
    </div>
  );
};

export const SkillsView: React.FC = () => {
  // Active character: gameStateStore is the POV source of truth; fall back to
  // the party's active member if gameState hasn't resolved one yet.
  const activeCharacterId = useGameStateStore((s) => s.activeCharacterId);
  const activeMember = usePartyStore((s) => s.getActiveCharacterMember());
  const characterId = activeCharacterId ?? activeMember?.characterId ?? null;

  const skillsByCharacter = useSkillStore((s) => s.skillsByCharacter);
  const isLoading = useSkillStore((s) => s.isLoading);
  const error = useSkillStore((s) => s.error);
  const syncSkills = useSkillStore((s) => s.syncSkills);

  React.useEffect(() => {
    if (characterId) {
      syncSkills(characterId);
    }
  }, [characterId, syncSkills]);

  const skills: SkillMap | null = characterId ? skillsByCharacter[characterId] ?? null : null;

  if (!characterId) {
    return (
      <div className="h-full w-full flex items-center justify-center p-8 text-terminal-green/60">
        <div className="text-center space-y-4">
          <p className="text-xl">NO CHARACTER SELECTED</p>
          <p className="text-sm">Select a character to view skill progression.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-terminal-green/20 scrollbar-track-transparent">
      <div className="border-b-2 border-terminal-green pb-4 mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold uppercase tracking-widest text-terminal-green flex items-center gap-2">
          <span>✨</span> Skills
        </h2>
        <button
          onClick={() => characterId && syncSkills(characterId)}
          className="text-xs border border-terminal-green px-2 py-1 text-terminal-green hover:bg-terminal-green/10 transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 border border-terminal-red/50 bg-terminal-red/10 text-terminal-red px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}

      {isLoading && !skills && (
        <div className="text-terminal-green/60 mb-4">Loading skills…</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SKILL_NAMES.map((name) => {
          const entry = skills?.[name] ?? { xp: 0, level: 1 };
          return <SkillBar key={name} skill={name} entry={entry} />;
        })}
      </div>
    </div>
  );
};
