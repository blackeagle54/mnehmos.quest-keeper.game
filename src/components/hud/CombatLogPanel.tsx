import React, { useEffect } from 'react';
import { useCombatStore } from '../../stores/combatStore';
import { useHudStore } from '../../stores/hudStore';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import type { CombatLogEntryType } from '../../utils/combatLog';

/** Emoji per entry type — mirrors the iconography used in the combat formatters. */
const TYPE_ICON: Record<CombatLogEntryType, string> = {
  'encounter-start': '⚔️',
  'encounter-end': '🏁',
  'attack-hit': '🎯',
  'attack-miss': '💨',
  damage: '💥',
  heal: '✨',
  ability: '🔮',
  turn: '➡️',
  round: '🔄',
  defeat: '💀',
  info: '•',
};

/** Optional color accent per entry type (terminal palette). */
const TYPE_TONE: Partial<Record<CombatLogEntryType, string>> = {
  'attack-hit': 'text-terminal-green-bright',
  'attack-miss': 'text-terminal-green-dim',
  heal: 'text-emerald-400',
  defeat: 'text-red-400',
  round: 'text-yellow-400',
  'encounter-start': 'text-yellow-400',
  'encounter-end': 'text-yellow-400',
};

/**
 * CombatLogPanel — scrollable, round-tagged history of combat events. [COMBAT-001]
 * Self-gates on hudStore.isCombatLogOpen and auto-scrolls to the newest entry
 * (unless the player has scrolled up to read history).
 */
export const CombatLogPanel: React.FC = () => {
  const combatLog = useCombatStore((s) => s.combatLog);
  const isCombatLogOpen = useHudStore((s) => s.isCombatLogOpen);
  const toggleCombatLog = useHudStore((s) => s.toggleCombatLog);

  const { containerRef, anchorRef, scrollToBottomIfNeeded } = useAutoScroll();

  useEffect(() => {
    scrollToBottomIfNeeded();
  }, [combatLog.length, scrollToBottomIfNeeded]);

  if (!isCombatLogOpen) return null;

  return (
    <div className="pointer-events-auto absolute right-4 top-24 z-30 flex w-80 max-h-[45vh] flex-col rounded border border-terminal-green-dim bg-terminal-black/95 font-mono shadow-[0_0_20px_rgba(0,0,0,0.6)] backdrop-blur-sm animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-terminal-green-dim px-3 py-2">
        <h4 className="text-xs uppercase tracking-wider text-terminal-green">⚔️ Combat Log</h4>
        <button
          type="button"
          aria-label="Close combat log"
          onClick={toggleCombatLog}
          className="px-1 text-sm leading-none text-terminal-green-dim transition-colors hover:text-terminal-green-bright"
        >
          ✕
        </button>
      </div>

      {/* Entries */}
      <div ref={containerRef} className="flex-1 space-y-1 overflow-y-auto px-3 py-2 text-xs">
        {combatLog.length === 0 ? (
          <p className="italic text-terminal-green-dim">No combat events yet.</p>
        ) : (
          combatLog.map((entry) => (
            <div key={entry.id} className="flex items-start gap-1.5 leading-snug">
              <span className="shrink-0">{TYPE_ICON[entry.type] || '•'}</span>
              {entry.round != null && (
                <span className="mt-0.5 shrink-0 text-[10px] text-terminal-green-dim">R{entry.round}</span>
              )}
              <span className={TYPE_TONE[entry.type] || 'text-terminal-green'}>{entry.message}</span>
            </div>
          ))
        )}
        <div ref={anchorRef} />
      </div>
    </div>
  );
};
