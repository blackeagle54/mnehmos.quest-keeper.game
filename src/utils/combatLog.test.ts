/**
 * Tests for combatLog.ts — pure derivation of structured combat-log entries
 * from MCP combat-tool response data. [COMBAT-001]
 *
 * Mirrors the data shapes consumed by toolResponseFormatter.ts combat formatters.
 */

import { describe, it, expect } from 'vitest';
import { deriveCombatLogEntries } from './combatLog';

describe('deriveCombatLogEntries', () => {
  describe('encounter start', () => {
    it('emits one encounter-start entry naming the combatant count', () => {
      const entries = deriveCombatLogEntries('create_encounter', {
        encounterId: 'enc-1',
        participants: [{ name: 'Hero' }, { name: 'Goblin' }],
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('encounter-start');
      expect(entries[0].message).toMatch(/combat/i);
      expect(entries[0].message).toContain('2');
    });

    it('treats start_combat as an alias', () => {
      const entries = deriveCombatLogEntries('start_combat', { participants: [{ name: 'Hero' }] });
      expect(entries[0].type).toBe('encounter-start');
    });
  });

  describe('attacks', () => {
    it('emits an attack-hit with actor, target and damage amount', () => {
      const entries = deriveCombatLogEntries('execute_combat_action', {
        actionType: 'attack',
        hit: true,
        damage: 7,
        attackerName: 'Hero',
        targetName: 'Goblin',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('attack-hit');
      expect(entries[0].actor).toBe('Hero');
      expect(entries[0].target).toBe('Goblin');
      expect(entries[0].amount).toBe(7);
      expect(entries[0].message).toContain('Hero');
      expect(entries[0].message).toContain('Goblin');
      expect(entries[0].message).toContain('7');
    });

    it('emits an attack-miss when the attack fails', () => {
      const entries = deriveCombatLogEntries('execute_combat_action', {
        actionType: 'attack',
        hit: false,
        attackerName: 'Hero',
        targetName: 'Goblin',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('attack-miss');
      expect(entries[0].message).toMatch(/miss/i);
    });

    it('appends a defeat entry when the target drops to 0 HP', () => {
      const entries = deriveCombatLogEntries('execute_combat_action', {
        actionType: 'attack',
        hit: true,
        damage: 9,
        attackerName: 'Hero',
        targetName: 'Goblin',
        target: { hp: 0, maxHp: 7 },
      });
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe('attack-hit');
      expect(entries[1].type).toBe('defeat');
      expect(entries[1].target).toBe('Goblin');
      expect(entries[1].message).toMatch(/defeat/i);
    });

    it('accepts combat_action as an alias for execute_combat_action', () => {
      const entries = deriveCombatLogEntries('combat_action', {
        actionType: 'attack',
        hit: false,
        attackerName: 'Hero',
        targetName: 'Goblin',
      });
      expect(entries[0].type).toBe('attack-miss');
    });
  });

  describe('heals and abilities', () => {
    it('emits a heal entry with the recovered amount', () => {
      const entries = deriveCombatLogEntries('execute_combat_action', {
        actionType: 'heal',
        healing: 10,
        targetName: 'Cleric',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('heal');
      expect(entries[0].target).toBe('Cleric');
      expect(entries[0].amount).toBe(10);
      expect(entries[0].message).toMatch(/recover|heal/i);
      expect(entries[0].message).toContain('10');
    });

    it('emits an ability entry naming the ability used', () => {
      const entries = deriveCombatLogEntries('execute_combat_action', {
        actionType: 'spell',
        abilityName: 'Fireball',
        attackerName: 'Mage',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('ability');
      expect(entries[0].actor).toBe('Mage');
      expect(entries[0].message).toContain('Fireball');
    });
  });

  describe('turn / round advancement', () => {
    it('emits a single turn entry on a normal advance', () => {
      const entries = deriveCombatLogEntries('advance_turn', {
        nextParticipant: { name: 'Hero', isEnemy: false },
        round: 1,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('turn');
      expect(entries[0].actor).toBe('Hero');
      expect(entries[0].round).toBe(1);
    });

    it('emits a round entry then a turn entry when a new round begins', () => {
      const entries = deriveCombatLogEntries('advance_turn', {
        nextParticipant: { name: 'Goblin', isEnemy: true },
        round: 2,
        newRound: true,
      });
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe('round');
      expect(entries[0].round).toBe(2);
      expect(entries[0].message).toMatch(/round\s*2/i);
      expect(entries[1].type).toBe('turn');
      expect(entries[1].actor).toBe('Goblin');
    });
  });

  describe('encounter end', () => {
    it('emits an encounter-end entry reflecting victory and XP', () => {
      const entries = deriveCombatLogEntries('end_encounter', {
        outcome: 'victory',
        xpAwarded: 150,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('encounter-end');
      expect(entries[0].message).toMatch(/victory/i);
      expect(entries[0].message).toContain('150');
    });
  });

  describe('non-combat tools', () => {
    it('returns an empty array for unrelated tools so the log stays clean', () => {
      expect(deriveCombatLogEntries('get_inventory', { items: [] })).toEqual([]);
      expect(deriveCombatLogEntries('list_characters', { characters: [] })).toEqual([]);
    });

    it('returns an empty array for null/garbage data without throwing', () => {
      expect(deriveCombatLogEntries('execute_combat_action', null)).toEqual([]);
      expect(deriveCombatLogEntries('advance_turn', undefined)).toEqual([]);
    });
  });
});
