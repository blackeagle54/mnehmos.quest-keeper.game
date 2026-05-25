/**
 * Tests for hudStore.ts
 * 
 * Testing Zustand store for HUD UI state management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useHudStore } from './hudStore';

describe('hudStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useHudStore.setState({
      isInventoryOpen: false,
      activePanel: 'none',
      selectedEntityId: null,
      quickActionText: null,
      isCombatLogOpen: false,
    });
  });

  describe('Initial State', () => {
    it('has correct initial state', () => {
      const state = useHudStore.getState();
      
      expect(state.isInventoryOpen).toBe(false);
      expect(state.activePanel).toBe('none');
      expect(state.selectedEntityId).toBeNull();
      expect(state.quickActionText).toBeNull();
    });
  });

  describe('toggleInventory', () => {
    it('opens inventory when closed', () => {
      const { toggleInventory } = useHudStore.getState();
      
      toggleInventory();
      
      const state = useHudStore.getState();
      expect(state.isInventoryOpen).toBe(true);
      expect(state.activePanel).toBe('inventory');
    });

    it('closes inventory when open', () => {
      useHudStore.setState({ isInventoryOpen: true, activePanel: 'inventory' });
      
      const { toggleInventory } = useHudStore.getState();
      toggleInventory();
      
      const state = useHudStore.getState();
      expect(state.isInventoryOpen).toBe(false);
      expect(state.activePanel).toBe('none');
    });

    it('toggles correctly multiple times', () => {
      const { toggleInventory } = useHudStore.getState();
      
      // Open
      toggleInventory();
      expect(useHudStore.getState().isInventoryOpen).toBe(true);
      
      // Close
      toggleInventory();
      expect(useHudStore.getState().isInventoryOpen).toBe(false);
      
      // Open again
      toggleInventory();
      expect(useHudStore.getState().isInventoryOpen).toBe(true);
    });
  });

  describe('setActivePanel', () => {
    it('sets active panel to character', () => {
      const { setActivePanel } = useHudStore.getState();
      
      setActivePanel('character');
      
      expect(useHudStore.getState().activePanel).toBe('character');
    });

    it('sets active panel to inventory', () => {
      const { setActivePanel } = useHudStore.getState();
      
      setActivePanel('inventory');
      
      expect(useHudStore.getState().activePanel).toBe('inventory');
    });

    it('sets active panel to party', () => {
      const { setActivePanel } = useHudStore.getState();
      
      setActivePanel('party');
      
      expect(useHudStore.getState().activePanel).toBe('party');
    });

    it('resets active panel to none', () => {
      useHudStore.setState({ activePanel: 'character' });
      
      const { setActivePanel } = useHudStore.getState();
      setActivePanel('none');
      
      expect(useHudStore.getState().activePanel).toBe('none');
    });
  });

  describe('setSelectedEntityId', () => {
    it('sets selected entity id', () => {
      const { setSelectedEntityId } = useHudStore.getState();
      
      setSelectedEntityId('entity-123');
      
      expect(useHudStore.getState().selectedEntityId).toBe('entity-123');
    });

    it('can clear selected entity', () => {
      useHudStore.setState({ selectedEntityId: 'entity-123' });
      
      const { setSelectedEntityId } = useHudStore.getState();
      setSelectedEntityId(null);
      
      expect(useHudStore.getState().selectedEntityId).toBeNull();
    });

    it('updates when selecting different entities', () => {
      const { setSelectedEntityId } = useHudStore.getState();
      
      setSelectedEntityId('entity-1');
      expect(useHudStore.getState().selectedEntityId).toBe('entity-1');
      
      setSelectedEntityId('entity-2');
      expect(useHudStore.getState().selectedEntityId).toBe('entity-2');
    });
  });

  describe('setQuickActionText', () => {
    it('sets quick action text for chat prefill', () => {
      const { setQuickActionText } = useHudStore.getState();
      
      setQuickActionText('I attack the goblin with my sword');
      
      expect(useHudStore.getState().quickActionText).toBe('I attack the goblin with my sword');
    });

    it('can clear quick action text', () => {
      useHudStore.setState({ quickActionText: 'Some action' });
      
      const { setQuickActionText } = useHudStore.getState();
      setQuickActionText(null);
      
      expect(useHudStore.getState().quickActionText).toBeNull();
    });

    it('can set inventory item usage text', () => {
      const { setQuickActionText } = useHudStore.getState();
      
      setQuickActionText('I use my Potion of Healing');
      
      expect(useHudStore.getState().quickActionText).toBe('I use my Potion of Healing');
    });
  });

  describe('Combined Scenarios', () => {
    it('selecting entity and opening inventory works together', () => {
      const state = useHudStore.getState();
      
      state.setSelectedEntityId('monster-1');
      state.toggleInventory();
      
      const newState = useHudStore.getState();
      expect(newState.selectedEntityId).toBe('monster-1');
      expect(newState.isInventoryOpen).toBe(true);
      expect(newState.activePanel).toBe('inventory');
    });

    it('setting quick action while entity is selected', () => {
      const state = useHudStore.getState();
      
      state.setSelectedEntityId('goblin-1');
      state.setQuickActionText('I attack the selected enemy');
      
      const newState = useHudStore.getState();
      expect(newState.selectedEntityId).toBe('goblin-1');
      expect(newState.quickActionText).toBe('I attack the selected enemy');
    });

    it('switching panels preserves entity selection', () => {
      const state = useHudStore.getState();
      
      state.setSelectedEntityId('npc-1');
      state.setActivePanel('character');
      
      expect(useHudStore.getState().selectedEntityId).toBe('npc-1');
      
      state.setActivePanel('party');
      
      expect(useHudStore.getState().selectedEntityId).toBe('npc-1');
    });
  });

  describe('toggleCombatLog', () => {
    it('is closed initially', () => {
      expect(useHudStore.getState().isCombatLogOpen).toBe(false);
    });

    it('opens the combat log when closed', () => {
      useHudStore.getState().toggleCombatLog();
      expect(useHudStore.getState().isCombatLogOpen).toBe(true);
    });

    it('closes the combat log when open', () => {
      useHudStore.setState({ isCombatLogOpen: true });
      useHudStore.getState().toggleCombatLog();
      expect(useHudStore.getState().isCombatLogOpen).toBe(false);
    });
  });
});
