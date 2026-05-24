/**
 * Tests for combatStore combat-log state. [COMBAT-001]
 * Exercises the real store; mcpClient is mocked so importing the store has no
 * sidecar side effects (mcpManager is constructed at module load).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/mcpClient', () => ({
  mcpManager: {
    combatClient: { callTool: vi.fn() },
  },
}));

import { useCombatStore } from './combatStore';
import type { CombatLogEntryInput } from '../utils/combatLog';

beforeEach(() => {
  useCombatStore.setState({ combatLog: [] });
});

describe('combatStore — combat log', () => {
  it('starts with an empty combat log', () => {
    expect(useCombatStore.getState().combatLog).toEqual([]);
  });

  it('appendCombatLog stamps each entry with a unique id and timestamp', () => {
    const entries: CombatLogEntryInput[] = [
      { type: 'attack-hit', actor: 'Hero', target: 'Goblin', amount: 7, message: 'Hero hits Goblin for 7 damage' },
      { type: 'defeat', target: 'Goblin', message: 'Goblin is defeated!' },
    ];
    useCombatStore.getState().appendCombatLog(entries);

    const log = useCombatStore.getState().combatLog;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ type: 'attack-hit', actor: 'Hero', message: 'Hero hits Goblin for 7 damage' });
    expect(typeof log[0].id).toBe('string');
    expect(typeof log[0].timestamp).toBe('number');
    // ids must be unique even when stamped within the same millisecond
    expect(log[0].id).not.toBe(log[1].id);
  });

  it('accumulates entries across multiple appends, preserving order', () => {
    useCombatStore.getState().appendCombatLog([{ type: 'turn', actor: 'Hero', message: "Hero's turn" }]);
    useCombatStore.getState().appendCombatLog([{ type: 'turn', actor: 'Goblin', message: "Goblin's turn" }]);
    expect(useCombatStore.getState().combatLog.map((e) => e.actor)).toEqual(['Hero', 'Goblin']);
  });

  it('ignores empty append calls', () => {
    useCombatStore.getState().appendCombatLog([]);
    expect(useCombatStore.getState().combatLog).toEqual([]);
  });

  it('caps the log length, keeping the most recent entries', () => {
    const many: CombatLogEntryInput[] = Array.from({ length: 600 }, (_, i) => ({
      type: 'info',
      message: `event ${i}`,
    }));
    useCombatStore.getState().appendCombatLog(many);

    const log = useCombatStore.getState().combatLog;
    expect(log.length).toBeLessThanOrEqual(500);
    expect(log[log.length - 1].message).toBe('event 599');
  });

  it('clearCombatLog empties the log', () => {
    useCombatStore.getState().appendCombatLog([{ type: 'info', message: 'x' }]);
    useCombatStore.getState().clearCombatLog();
    expect(useCombatStore.getState().combatLog).toEqual([]);
  });

  it('clearCombat also clears the combat log', () => {
    useCombatStore.getState().appendCombatLog([{ type: 'info', message: 'x' }]);
    useCombatStore.getState().clearCombat();
    expect(useCombatStore.getState().combatLog).toEqual([]);
  });
});
