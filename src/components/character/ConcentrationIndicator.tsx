import React from 'react';
import { ConcentrationState } from '../../stores/gameStateStore';
import { usePartyStore } from '../../stores/partyStore';
import { mcpManager } from '../../services/mcpClient';

interface ConcentrationIndicatorProps {
  characterId: string;
  concentration: ConcentrationState | null | undefined;
  compact?: boolean;
}

/**
 * Visual indicator for active concentration spells
 * Shows what spell is being concentrated on and allows breaking concentration
 */
export const ConcentrationIndicator: React.FC<ConcentrationIndicatorProps> = ({
  characterId,
  concentration,
  compact = false
}) => {
  const { activePartyId, syncPartyDetails } = usePartyStore();
  const [breaking, setBreaking] = React.useState(false);

  const handleBreakConcentration = async () => {
    if (!concentration || breaking) return;
    
    setBreaking(true);
    try {
      await mcpManager.gameStateClient.callTool('concentration_manage', {
        action: 'break',
        characterId,
        reason: 'voluntary'
      });
      
      // Sync party to reflect changes
      if (activePartyId) {
        await syncPartyDetails(activePartyId);
      }
    } catch (error) {
      console.error('[ConcentrationIndicator] Failed to break concentration:', error);
    } finally {
      setBreaking(false);
    }
  };

  if (!concentration) {
    return null;
  }

  if (compact) {
    return (
      <div 
        className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-900/50 border border-purple-500/50 rounded text-xs text-purple-300 animate-pulse"
        title={`Concentrating on: ${concentration.activeSpell}`}
      >
        <span className="text-purple-400">🔮</span>
        <span className="truncate max-w-20">{concentration.activeSpell}</span>
      </div>
    );
  }

  return (
    <div className="bg-purple-950/50 border border-purple-500/50 rounded-lg p-3 animate-pulse-slow">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🔮</span>
          <div>
            <div className="text-xs text-purple-400 uppercase tracking-wider">Concentrating</div>
            <div className="text-lg font-bold text-purple-200">{concentration.activeSpell}</div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {concentration.spellLevel > 0 && (
            <div className="text-center">
              <div className="text-xs text-purple-400">Level</div>
              <div className="text-xl font-bold text-purple-300">{concentration.spellLevel}</div>
            </div>
          )}
          
          <button
            onClick={handleBreakConcentration}
            disabled={breaking}
            className="px-3 py-1.5 bg-red-900/50 border border-red-500/50 text-red-300 text-sm rounded hover:bg-red-800/50 transition-colors disabled:opacity-50"
          >
            {breaking ? '...' : 'Drop'}
          </button>
        </div>
      </div>
      
      {concentration.maxDuration && (
        <div className="mt-2 text-xs text-purple-400">
          Duration: {concentration.maxDuration} rounds (started round {concentration.startedAt})
        </div>
      )}
      
      <div className="mt-2 text-xs text-purple-400/70 italic">
        ⚠️ Taking damage requires a Constitution save (DC 10 or half damage)
      </div>
    </div>
  );
};
