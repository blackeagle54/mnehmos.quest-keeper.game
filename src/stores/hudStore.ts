import { create } from 'zustand';

interface HudState {
  // Panel Visibility
  isInventoryOpen: boolean;
  isSpellbookOpen: boolean;
  isRestPanelOpen: boolean;
  isLootPanelOpen: boolean;
  isCombatLogOpen: boolean;
  activePanel: 'none' | 'character' | 'inventory' | 'spellbook' | 'party';
  
  // Selection mirrors combatStore but manages UI-specifics
  selectedEntityId: string | null;
  
  // Quick Action / Intent Input
  quickActionText: string | null;

  // Actions
  toggleInventory: () => void;
  toggleSpellbook: () => void;
  toggleRestPanel: () => void;
  toggleLootPanel: () => void;
  toggleCombatLog: () => void;
  setActivePanel: (panel: HudState['activePanel']) => void;
  setSelectedEntityId: (id: string | null) => void;
  setQuickActionText: (text: string | null) => void;
  
  // Computed helpers could go here or as separate hooks
}

export const useHudStore = create<HudState>((set) => ({
  isInventoryOpen: false,
  isSpellbookOpen: false,
  isRestPanelOpen: false,
  isLootPanelOpen: false,
  isCombatLogOpen: false,
  activePanel: 'none',
  selectedEntityId: null,
  quickActionText: null,

  toggleInventory: () => set((state) => ({ 
    isInventoryOpen: !state.isInventoryOpen,
    isSpellbookOpen: false, // Close spellbook when opening inventory
    activePanel: !state.isInventoryOpen ? 'inventory' : 'none'
  })),

  toggleSpellbook: () => set((state) => ({ 
    isSpellbookOpen: !state.isSpellbookOpen,
    isInventoryOpen: false, // Close inventory when opening spellbook
    activePanel: !state.isSpellbookOpen ? 'spellbook' : 'none'
  })),

  toggleRestPanel: () => set((state) => ({ 
    isRestPanelOpen: !state.isRestPanelOpen 
  })),

  toggleLootPanel: () => set((state) => ({ 
    isLootPanelOpen: !state.isLootPanelOpen 
  })),

  toggleCombatLog: () => set((state) => ({
    isCombatLogOpen: !state.isCombatLogOpen
  })),

  setActivePanel: (panel) => set({ activePanel: panel }),
  
  setSelectedEntityId: (id) => set({ selectedEntityId: id }),
  
  setQuickActionText: (text) => set({ quickActionText: text })
}));
