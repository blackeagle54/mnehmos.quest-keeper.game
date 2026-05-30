import React, { useState, useCallback } from 'react';
import { useGameStateStore, InventoryItem } from '../../stores/gameStateStore';
import { mcpManager } from '../../services/mcpClient';

interface InventoryViewProps {
  onClose?: () => void;
}

type EquipSlot = 'mainhand' | 'offhand' | 'armor' | 'head' | 'feet' | 'accessory';

const SLOT_LABELS: Record<EquipSlot, string> = {
  mainhand: '⚔️ Main Hand',
  offhand: '🛡️ Off Hand',
  armor: '🛡️ Armor',
  head: '👑 Head',
  feet: '👢 Feet',
  accessory: '💍 Accessory'
};

// Determine which slots an item can be equipped to based on its type
function getAvailableSlots(item: InventoryItem): EquipSlot[] {
  const type = item.type.toLowerCase();
  const name = item.name.toLowerCase();
  
  // Weapons go in mainhand or offhand
  if (type.includes('weapon') || type.includes('melee') || type.includes('ranged')) {
    return ['mainhand', 'offhand'];
  }
  
  // Shields go in offhand only
  if (type === 'shield' || name.includes('shield')) {
    return ['offhand'];
  }
  
  // Armor goes in armor slot
  if (type === 'armor' || type.includes('heavy') || type.includes('medium') || type.includes('light armor')) {
    return ['armor'];
  }
  
  // Helmets/hats
  if (name.includes('helm') || name.includes('hat') || name.includes('hood') || name.includes('crown')) {
    return ['head'];
  }
  
  // Boots/shoes
  if (name.includes('boot') || name.includes('shoe') || name.includes('sandal')) {
    return ['feet'];
  }
  
  // Rings/amulets/accessories
  if (name.includes('ring') || name.includes('amulet') || name.includes('cloak') || name.includes('bracelet')) {
    return ['accessory'];
  }
  
  // Default for misc equippable gear
  if (type !== 'consumable' && type !== 'quest' && type !== 'misc' && type !== 'scroll') {
    return ['accessory'];
  }
  
  return [];
}

export const InventoryView: React.FC<InventoryViewProps> = ({ onClose }) => {
  const inventory = useGameStateStore((state) => state.inventory);
  const activeCharacterId = useGameStateStore((state) => state.activeCharacterId);
  const syncState = useGameStateStore((state) => state.syncState);
  
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [isEquipping, setIsEquipping] = useState(false);
  const [equipError, setEquipError] = useState<string | null>(null);
  const [showSlotSelector, setShowSlotSelector] = useState(false);

  const handleEquip = useCallback(async (slot: EquipSlot) => {
    if (!selectedItem || !activeCharacterId) return;
    
    setIsEquipping(true);
    setEquipError(null);
    
    try {
      await mcpManager.gameStateClient.callTool('inventory_manage', {
        action: 'equip',
        characterId: activeCharacterId,
        itemId: selectedItem.id,
        slot
      });
      
      // Refresh inventory to show updated state
      await syncState(true);
      
      // Update selected item to reflect new state
      const updatedItem = useGameStateStore.getState().inventory.find(i => i.id === selectedItem.id);
      if (updatedItem) {
        setSelectedItem(updatedItem);
      }
      setShowSlotSelector(false);
    } catch (err: any) {
      console.error('[InventoryView] Equip failed:', err);
      setEquipError(err.message || 'Failed to equip item');
    } finally {
      setIsEquipping(false);
    }
  }, [selectedItem, activeCharacterId, syncState]);

  const handleUnequip = useCallback(async () => {
    if (!selectedItem || !activeCharacterId) return;
    
    setIsEquipping(true);
    setEquipError(null);
    
    try {
      await mcpManager.gameStateClient.callTool('inventory_manage', {
        action: 'unequip',
        characterId: activeCharacterId,
        itemId: selectedItem.id
      });
      
      // Refresh inventory to show updated state
      await syncState(true);
      
      // Update selected item to reflect new state
      const updatedItem = useGameStateStore.getState().inventory.find(i => i.id === selectedItem.id);
      if (updatedItem) {
        setSelectedItem(updatedItem);
      }
    } catch (err: any) {
      console.error('[InventoryView] Unequip failed:', err);
      setEquipError(err.message || 'Failed to unequip item');
    } finally {
      setIsEquipping(false);
    }
  }, [selectedItem, activeCharacterId, syncState]);

  const availableSlots = selectedItem ? getAvailableSlots(selectedItem) : [];
  const isEquippable = availableSlots.length > 0;

  return (
    <div className="h-full flex flex-col p-4 font-mono text-terminal-green overflow-hidden relative">
      <style>{`
        .inventory-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 255, 65, 0.6) rgba(0, 255, 65, 0.1);
        }
        .inventory-scroll::-webkit-scrollbar {
          width: 10px;
        }
        .inventory-scroll::-webkit-scrollbar-track {
          background: rgba(0, 255, 65, 0.15);
          border-radius: 5px;
          border: 1px solid rgba(0, 255, 65, 0.3);
        }
        .inventory-scroll::-webkit-scrollbar-thumb {
          background: rgba(0, 255, 65, 0.6);
          border-radius: 5px;
          border: 1px solid rgba(0, 255, 65, 0.8);
        }
        .inventory-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 255, 65, 0.9);
        }
      `}</style>
      
      <div className="flex justify-between items-center mb-4 border-b border-terminal-green-dim pb-2">
        <h2 className="text-xl font-bold uppercase tracking-wider text-glow flex-shrink-0">
          Inventory
        </h2>
        {onClose && (
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center border border-terminal-green/30 rounded hover:bg-terminal-green/20 text-terminal-green transition-colors"
          >
            ✕
          </button>
        )}
      </div>

      <div 
        className="flex-1 min-h-0 overflow-y-scroll pr-2 inventory-scroll border-r-2 border-terminal-green/20" 
        tabIndex={-1}
        style={{ outline: 'none', maxHeight: '100%' }}
      >
        {inventory.length === 0 ? (
          <div className="text-center opacity-50 py-8 italic">
            [NO_ITEMS_DETECTED]
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 pb-4">
            {inventory.map((item) => (
              <div
                key={item.id}
                onClick={() => setSelectedItem(item)}
                className="border border-terminal-green-dim bg-terminal-black/50 p-3 hover:bg-terminal-green/10 hover:border-terminal-green transition-all cursor-pointer group rounded-sm active:bg-terminal-green/20"
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1 mr-4">
                    <div className="font-bold text-terminal-green-bright flex items-center gap-2 flex-wrap">
                      <span className="text-lg group-hover:text-white transition-colors">{item.name}</span>
                      {item.equipped && (
                        <span className="text-[10px] bg-terminal-green text-terminal-black px-1.5 py-0.5 rounded uppercase font-bold tracking-wide">
                          {item.slot ? SLOT_LABELS[item.slot] : 'Equipped'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-terminal-green/60 mt-1 uppercase tracking-wider">{item.type}</div>
                  </div>
                  <div className="text-right flex-shrink-0 bg-terminal-green/10 px-3 py-1 rounded group-hover:bg-terminal-green/20 transition-colors">
                    <div className="font-bold text-lg">x{item.quantity}</div>
                    {item.weight && (
                      <div className="text-xs opacity-50">{item.weight} lbs</div>
                    )}
                  </div>
                </div>
                {item.description && item.description !== item.name && (
                  <div className="text-sm mt-2 text-terminal-green/80 border-t border-terminal-green-dim/30 pt-2 italic truncate">
                    {item.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Item Details Modal */}
      {selectedItem && (
        <div 
          className="fixed inset-0 bg-terminal-black/90 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200"
          onClick={() => { setSelectedItem(null); setShowSlotSelector(false); setEquipError(null); }}
        >
          <div 
            className="bg-terminal-black border-2 border-terminal-green p-6 max-w-md w-full shadow-glow-lg relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              onClick={(e) => { e.stopPropagation(); setSelectedItem(null); setShowSlotSelector(false); setEquipError(null); }}
              className="absolute top-2 right-2 text-terminal-green hover:text-white p-2"
            >
              ✕
            </button>
            
            <div className="text-center mb-6">
              <div className="text-xs text-terminal-green/60 uppercase tracking-wider mb-2">{selectedItem.type}</div>
              <h3 className="text-2xl font-bold text-white mb-2 text-glow">{selectedItem.name}</h3>
              {selectedItem.equipped && (
                <span className="inline-block bg-terminal-green text-terminal-black px-2 py-0.5 rounded uppercase font-bold text-xs tracking-wide">
                  {selectedItem.slot ? `Equipped: ${SLOT_LABELS[selectedItem.slot]}` : 'Currently Equipped'}
                </span>
              )}
            </div>

            <div className="space-y-4 border-t border-terminal-green/30 pt-4">
              <div className="grid grid-cols-2 gap-4 text-center">
                <div className="bg-terminal-green/5 p-2 rounded">
                  <div className="text-xs opacity-60 uppercase">Quantity</div>
                  <div className="text-xl font-bold">{selectedItem.quantity}</div>
                </div>
                {selectedItem.weight ? (
                  <div className="bg-terminal-green/5 p-2 rounded">
                    <div className="text-xs opacity-60 uppercase">Weight</div>
                    <div className="text-xl font-bold">{selectedItem.weight} <span className="text-xs font-normal opacity-50">lbs</span></div>
                  </div>
                ) : (
                  <div className="bg-terminal-green/5 p-2 rounded opacity-50">
                    <div className="text-xs opacity-60 uppercase">Weight</div>
                    <div className="text-xl font-bold">-</div>
                  </div>
                )}
              </div>

              {selectedItem.description && selectedItem.description !== selectedItem.name ? (
                <div className="bg-terminal-green/5 p-4 rounded min-h-[80px]">
                  <div className="text-xs opacity-60 uppercase mb-2">Description</div>
                  <p className="text-terminal-green-bright leading-relaxed">
                    {selectedItem.description}
                  </p>
                </div>
              ) : (
                <div className="bg-terminal-green/5 p-4 rounded min-h-[80px] flex items-center justify-center text-terminal-green/40 italic">
                  No additional details available.
                </div>
              )}

              {/* Error Display */}
              {equipError && (
                <div className="bg-red-900/30 border border-red-500 rounded p-2 text-red-400 text-sm">
                  ⚠️ {equipError}
                </div>
              )}

              {/* Slot Selector Dropdown */}
              {showSlotSelector && availableSlots.length > 0 && (
                <div className="bg-terminal-green/10 border border-terminal-green rounded p-3">
                  <div className="text-xs text-terminal-green/80 mb-2 uppercase">Select Slot:</div>
                  <div className="flex flex-wrap gap-2">
                    {availableSlots.map(slot => (
                      <button
                        key={slot}
                        onClick={() => handleEquip(slot)}
                        disabled={isEquipping}
                        className="px-3 py-2 bg-terminal-green/20 border border-terminal-green text-terminal-green rounded hover:bg-terminal-green hover:text-black transition-colors disabled:opacity-50 text-sm font-bold"
                      >
                        {SLOT_LABELS[slot]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="mt-6 flex justify-center gap-3 flex-wrap">
              {/* Equip/Unequip Buttons */}
              {isEquippable && !selectedItem.equipped && !showSlotSelector && (
                <button 
                  onClick={() => {
                    if (availableSlots.length === 1) {
                      // Only one option, equip directly
                      handleEquip(availableSlots[0]);
                    } else {
                      // Show slot selector
                      setShowSlotSelector(true);
                    }
                  }}
                  disabled={isEquipping}
                  className="px-6 py-2 bg-terminal-cyan text-black font-bold uppercase tracking-wider hover:bg-white transition-colors rounded-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {isEquipping ? (
                    <>
                      <span className="animate-spin">⚙️</span>
                      Equipping...
                    </>
                  ) : (
                    <>⚔️ Equip</>
                  )}
                </button>
              )}
              
              {selectedItem.equipped && (
                <button 
                  onClick={handleUnequip}
                  disabled={isEquipping}
                  className="px-6 py-2 bg-terminal-amber text-black font-bold uppercase tracking-wider hover:bg-white transition-colors rounded-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {isEquipping ? (
                    <>
                      <span className="animate-spin">⚙️</span>
                      Removing...
                    </>
                  ) : (
                    <>🔓 Unequip</>
                  )}
                </button>
              )}

              <button 
                onClick={() => { setSelectedItem(null); setShowSlotSelector(false); setEquipError(null); }}
                className="px-6 py-2 bg-terminal-green text-terminal-black font-bold uppercase tracking-wider hover:bg-white transition-colors rounded-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
