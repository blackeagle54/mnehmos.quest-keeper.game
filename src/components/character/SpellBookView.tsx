import React, { useState } from 'react';
import { SpellSlots, PactMagicSlots, usePartyStore } from '../../stores/partyStore';
import { useGameStateStore } from '../../stores/gameStateStore';
import { SpellSlotsDisplay } from './SpellSlotsDisplay';
import { mcpManager } from '../../services/mcpClient';
import { useCombatStore } from '../../stores/combatStore';

interface SpellBookViewProps {
  characterId: string;
  spellSlots?: SpellSlots;
  pactMagicSlots?: PactMagicSlots;
  knownSpells?: string[];
  preparedSpells?: string[];
  cantripsKnown?: string[];
  spellSaveDC?: number;
  spellAttackBonus?: number;
  spellcastingAbility?: string;
  readOnly?: boolean;
}

export const SpellBookView: React.FC<SpellBookViewProps> = ({
  characterId,
  spellSlots,
  pactMagicSlots,
  knownSpells = [],
  preparedSpells = [],
  cantripsKnown = [],
  spellSaveDC,
  spellAttackBonus,
  spellcastingAbility,
  readOnly = false
}) => {
  const [activeTab, setActiveTab] = useState<'prepared' | 'known'>('prepared');
  const activeEncounterId = useCombatStore(state => state.activeEncounterId);
  const { activePartyId, syncPartyDetails } = usePartyStore();

  // Get active character stats for spell calculation
  const activeCharacter = useGameStateStore(state => state.activeCharacter);

  // Auto-calculate spell stats if not provided
  const calculatedStats = React.useMemo(() => {
    // Get ability mod for spellcasting
    const abilityMap: Record<string, 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'> = {
      'strength': 'str', 'str': 'str',
      'dexterity': 'dex', 'dex': 'dex',
      'constitution': 'con', 'con': 'con',
      'intelligence': 'int', 'int': 'int',
      'wisdom': 'wis', 'wis': 'wis',
      'charisma': 'cha', 'cha': 'cha'
    };
    
    const ability = spellcastingAbility?.toLowerCase();
    const abilityKey = ability ? abilityMap[ability] : null;
    
    let mod = 0;
    if (abilityKey && activeCharacter?.stats?.[abilityKey]) {
      mod = Math.floor((activeCharacter.stats[abilityKey] - 10) / 2);
    }
    
    const profBonus = activeCharacter?.level ? Math.floor((activeCharacter.level - 1) / 4) + 2 : 2;
    
    return {
      saveDC: spellSaveDC ?? (ability ? 8 + profBonus + mod : null),
      attackBonus: spellAttackBonus ?? (ability ? profBonus + mod : null),
      ability: spellcastingAbility ?? null
    };
  }, [spellSaveDC, spellAttackBonus, spellcastingAbility, activeCharacter]);

  // Determine which tab to show by default
  // If prepared spells exist, default to 'prepared', else 'known'
  React.useEffect(() => {
    if (preparedSpells.length === 0 && knownSpells.length > 0) {
      setActiveTab('known');
    }
  }, [preparedSpells.length, knownSpells.length]);

  const handleCast = async (spellName: string) => {
    if (readOnly) return;

    if (!activeEncounterId) {
      // TODO: Implement OOC casting or just chat output
      alert(`Casting "${spellName}" requires an active combat encounter to resolve automatically.\n\nPlease manage spell slots manually for out-of-combat casting.`);
      return;
    }

    try {
      // Trigger the backend tool
      // Migrated: execute_combat_action -> combat_action. The 'action' field
      // ('cast_spell') is both the combat-action enum AND the router selector,
      // so it stays as-is. Param names (encounterId/actorId/spellName) unchanged.
      await mcpManager.combatClient.callTool('combat_action', {
        encounterId: activeEncounterId,
        action: 'cast_spell',
        actorId: characterId,
        spellName: spellName
      });
      
      // Sync party details to update spell slots
      if (activePartyId) {
        await syncPartyDetails(activePartyId);
      }
      
    } catch (error: any) {
      console.error('Failed to cast spell:', error);
      alert(`Failed to cast ${spellName}: ${error?.message || 'Unknown error'}`);
    }
  };

  return (
    <div className="flex flex-col h-full bg-terminal-black text-terminal-green">
      {/* Header Stats - Terminal Themed */}
      <div className="flex justify-around bg-black/60 p-3 border-b border-terminal-green/30">
        <div className="text-center">
          <div className="text-xs text-terminal-green/60 uppercase tracking-wider">Spell Attack</div>
          <div className="text-xl font-bold text-terminal-green-bright">
            {calculatedStats.attackBonus !== null 
              ? (calculatedStats.attackBonus >= 0 ? `+${calculatedStats.attackBonus}` : calculatedStats.attackBonus) 
              : '--'}
          </div>
        </div>
        <div className="text-center">
          <div className="text-xs text-terminal-green/60 uppercase tracking-wider">Save DC</div>
          <div className="text-xl font-bold text-terminal-green-bright">{calculatedStats.saveDC ?? '--'}</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-terminal-green/60 uppercase tracking-wider">Ability</div>
          <div className="text-xl font-bold text-terminal-green-bright capitalize">{calculatedStats.ability || '--'}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Spell Slots */}
        {(spellSlots || pactMagicSlots) && (
          <SpellSlotsDisplay 
            characterId={characterId} 
            slots={spellSlots} 
            pactMagicSlots={pactMagicSlots}
            readOnly={readOnly} 
          />
        )}

        {/* Spells List */}
        <div>
          <div className="flex border-b border-terminal-green/30 mb-4">
            {preparedSpells.length > 0 && (
              <button
                className={`px-4 py-2 font-medium transition-colors ${
                  activeTab === 'prepared' 
                    ? 'text-terminal-green-bright border-b-2 border-terminal-green' 
                    : 'text-terminal-green/50 hover:text-terminal-green'
                }`}
                onClick={() => setActiveTab('prepared')}
              >
                Prepared ({preparedSpells.length})
              </button>
            )}
            <button
              className={`px-4 py-2 font-medium transition-colors ${
                activeTab === 'known' 
                  ? 'text-terminal-green-bright border-b-2 border-terminal-green' 
                  : 'text-terminal-green/50 hover:text-terminal-green'
              }`}
              onClick={() => setActiveTab('known')}
            >
              Known Spells ({knownSpells.length})
            </button>
          </div>

          <div className="space-y-4">
            {/* Cantrips Section */}
            {cantripsKnown.length > 0 && (
              <div className="bg-black/40 rounded p-3 border border-terminal-green/30">
                <h4 className="text-sm font-bold text-terminal-green/70 mb-2 uppercase">Cantrips (At Will)</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {cantripsKnown.map((spell, idx) => (
                    <div 
                      key={idx} 
                      className="bg-terminal-green/5 p-2 rounded text-sm hover:bg-terminal-green/15 cursor-pointer transition-colors group flex justify-between items-center border border-terminal-green/20"
                      onClick={() => handleCast(spell)}
                    >
                      <span className="text-terminal-green">{spell}</span>
                      <span className="text-xs text-terminal-green-bright opacity-0 group-hover:opacity-100 transition-opacity">Cast</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Spells Section */}
            <div className="bg-black/40 rounded p-3 border border-terminal-green/30">
              <h4 className="text-sm font-bold text-terminal-green/70 mb-2 uppercase">
                {activeTab === 'prepared' ? 'Prepared Spells' : 'Known Spells'}
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {(activeTab === 'prepared' ? preparedSpells : knownSpells).map((spell, idx) => (
                  <div key={idx} className="bg-terminal-green/5 p-2 rounded text-sm hover:bg-terminal-green/15 cursor-pointer transition-colors flex justify-between items-center group border border-terminal-green/20">
                    <span className="text-terminal-green">{spell}</span>
                    <button 
                      className="text-xs bg-terminal-green/20 text-terminal-green px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-terminal-green/40"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCast(spell);
                      }}
                    >
                      Cast
                    </button>
                  </div>
                ))}
                {(activeTab === 'prepared' ? preparedSpells : knownSpells).length === 0 && (
                  <div className="col-span-2 text-terminal-green/40 text-center py-4 italic">
                    No spells found.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
