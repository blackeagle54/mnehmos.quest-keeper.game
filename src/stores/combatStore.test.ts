/**
 * Tests for combatStore combat-log state. [COMBAT-001]
 * Exercises the real store; mcpClient is mocked so importing the store has no
 * sidecar side effects (mcpManager is constructed at module load).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { callToolMock } = vi.hoisted(() => ({ callToolMock: vi.fn() }));

vi.mock('../services/mcpClient', () => ({
  mcpManager: {
    combatClient: { callTool: callToolMock },
  },
}));

import { useCombatStore, recordCombatLog, recordAoePreview } from './combatStore';
import type { CombatLogEntryInput } from '../utils/combatLog';
import type { Point } from '../utils/aoe';

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

describe('combatStore — recordCombatLog (live pipeline)', () => {
  beforeEach(() => {
    useCombatStore.setState({ combatLog: [] });
  });

  it('derives and appends entries from an MCP-wrapped combat result', () => {
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            actionType: 'attack',
            hit: true,
            damage: 5,
            attackerName: 'Hero',
            targetName: 'Goblin',
          }),
        },
      ],
    };
    recordCombatLog('execute_combat_action', result);

    const log = useCombatStore.getState().combatLog;
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('attack-hit');
    expect(log[0].message).toContain('Hero');
    expect(log[0].amount).toBe(5);
  });

  it('handles direct (unwrapped) JSON results', () => {
    recordCombatLog('advance_turn', { nextParticipant: { name: 'Goblin' }, round: 2, newRound: true });
    expect(useCombatStore.getState().combatLog.map((e) => e.type)).toEqual(['round', 'turn']);
  });

  it('is a no-op for non-combat tools', () => {
    recordCombatLog('get_inventory', { content: [{ type: 'text', text: '{"items":[]}' }] });
    expect(useCombatStore.getState().combatLog).toEqual([]);
  });

  it('is a no-op for pre-formatted text responses without structured data', () => {
    recordCombatLog('execute_combat_action', {
      content: [{ type: 'text', text: '⚔️ HIT! Hero strikes Goblin!' }],
    });
    expect(useCombatStore.getState().combatLog).toEqual([]);
  });
});

describe('combatStore — requestMove (click-to-move) [COMBAT-002]', () => {
  beforeEach(() => {
    callToolMock.mockClear();
    useCombatStore.setState({
      activeEncounterId: 'enc-1',
      activeEncounterSessionId: null,
      isSyncing: false,
      lastSyncTime: 0,
    });
  });

  it('issues an execute_combat_action move for the entity to the target MCP tile', async () => {
    await useCombatStore.getState().requestMove('hero-1', 12, 8);
    expect(callToolMock).toHaveBeenCalledWith('execute_combat_action', {
      encounterId: 'enc-1',
      action: 'move',
      actorId: 'hero-1',
      targetPosition: { x: 12, y: 8 },
    });
  });

  it('skips the move when the token is already on the target tile (dedup) [COMBAT-002]', async () => {
    // viz (2,_,-2) → mcp tile (12, 8); requesting a move to that same tile is a no-op.
    useCombatStore.setState({ entities: [{ id: 'hero-1', position: { x: 2, y: 0.4, z: -2 } }] as any });
    await useCombatStore.getState().requestMove('hero-1', 12, 8);
    expect(callToolMock).not.toHaveBeenCalledWith('execute_combat_action', expect.anything());
  });

  it('does nothing when there is no active encounter', async () => {
    useCombatStore.setState({ activeEncounterId: null });
    await useCombatStore.getState().requestMove('hero-1', 12, 8);
    expect(callToolMock).not.toHaveBeenCalledWith('execute_combat_action', expect.anything());
  });
});

describe('combatStore — AoE preview [COMBAT-003]', () => {
  beforeEach(() => {
    useCombatStore.setState({ aoePreview: null });
  });

  it('starts with no AoE preview', () => {
    expect(useCombatStore.getState().aoePreview).toBeNull();
  });

  it('setAoePreview stores tiles and a color', () => {
    const tiles: Point[] = [{ x: 10, y: 10 }, { x: 11, y: 10 }];
    useCombatStore.getState().setAoePreview(tiles, '#ff0000');
    expect(useCombatStore.getState().aoePreview).toEqual({ tiles, color: '#ff0000' });
  });

  it('clearAoePreview removes the preview', () => {
    useCombatStore.getState().setAoePreview([{ x: 0, y: 0 }]);
    useCombatStore.getState().clearAoePreview();
    expect(useCombatStore.getState().aoePreview).toBeNull();
  });

  it('clearCombat also clears the AoE preview', () => {
    useCombatStore.getState().setAoePreview([{ x: 0, y: 0 }]);
    useCombatStore.getState().clearCombat();
    expect(useCombatStore.getState().aoePreview).toBeNull();
  });

  it('recordAoePreview parses affectedTiles (string + object forms) from a tool result', () => {
    const result = {
      content: [
        { type: 'text', text: JSON.stringify({ affectedTiles: [{ x: 10, y: 10 }, '11,10', { x: 12, y: 11 }] }) },
      ],
    };
    recordAoePreview(result);
    expect(useCombatStore.getState().aoePreview?.tiles).toEqual([
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 11 },
    ]);
  });

  it('recordAoePreview is a no-op when the result has no affectedTiles', () => {
    recordAoePreview({ content: [{ type: 'text', text: '{"message":"ok"}' }] });
    expect(useCombatStore.getState().aoePreview).toBeNull();
  });
});
