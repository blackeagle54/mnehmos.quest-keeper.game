/**
 * Combat log — pure derivation of structured, retainable log entries from MCP
 * combat-tool response data. [COMBAT-001]
 *
 * Companion to toolResponseFormatter.ts: that module renders combat data into
 * *ephemeral* chat markdown; this module distills the same data into *structured,
 * retained* entries so the combat log panel can show a scrollable history.
 *
 * Kept intentionally pure — `id` and `timestamp` are added downstream by the store
 * (see combatStore.appendCombatLog) so this function stays deterministic and testable.
 */

export type CombatLogEntryType =
  | 'encounter-start'
  | 'encounter-end'
  | 'attack-hit'
  | 'attack-miss'
  | 'damage'
  | 'heal'
  | 'ability'
  | 'turn'
  | 'round'
  | 'defeat'
  | 'info';

/** Content of a log entry, before the store stamps it with id + timestamp. */
export interface CombatLogEntryInput {
  type: CombatLogEntryType;
  message: string;
  round?: number;
  actor?: string;
  target?: string;
  amount?: number;
}

/** A combat log entry as stored/rendered. */
export interface CombatLogEntry extends CombatLogEntryInput {
  id: string;
  timestamp: number;
}

/** Normalize tool names: lowercase + dashes → underscores (matches formatCombatData). */
function normalize(toolName: string): string {
  return (toolName || '').toLowerCase().replace(/-/g, '_');
}

function deriveEncounterStart(data: any): CombatLogEntryInput[] {
  const participants = data.participants || data.encounter?.participants || [];
  return [
    {
      type: 'encounter-start',
      message: `Combat begins — ${participants.length} combatants roll initiative`,
    },
  ];
}

function deriveCombatAction(data: any): CombatLogEntryInput[] {
  const entries: CombatLogEntryInput[] = [];

  const actionType = data.actionType || data.action?.type || 'action';
  const attacker = data.attackerName || data.attacker?.name || 'Attacker';
  const target = data.targetName || data.target?.name || 'target';

  const isAttack = actionType === 'attack' || data.hit !== undefined;
  const isHeal = actionType === 'heal' || data.healing !== undefined;
  const isAbility = actionType === 'ability' || actionType === 'spell';

  if (isAttack) {
    const hit = data.success ?? data.hit ?? true;
    if (hit) {
      const damage = data.damage ?? data.totalDamage ?? 0;
      entries.push({
        type: 'attack-hit',
        actor: attacker,
        target,
        amount: damage > 0 ? damage : undefined,
        message: damage > 0 ? `${attacker} hits ${target} for ${damage} damage` : `${attacker} hits ${target}`,
      });
    } else {
      entries.push({
        type: 'attack-miss',
        actor: attacker,
        target,
        message: `${attacker} misses ${target}`,
      });
    }
  } else if (isHeal) {
    const healing = data.healing ?? data.damage ?? 0;
    entries.push({
      type: 'heal',
      target,
      amount: healing,
      message: `${target} recovers ${healing} HP`,
    });
  } else if (isAbility) {
    const ability = data.abilityName || 'an ability';
    entries.push({
      type: 'ability',
      actor: attacker,
      message: `${attacker} uses ${ability}`,
    });
  } else {
    entries.push({
      type: 'info',
      message: data.message || `${attacker} acts`,
    });
  }

  // Defeat is independent of action type — derived from the resulting HP.
  const hp = data.target?.hp ?? data.targetHp;
  if (typeof hp === 'number' && hp <= 0) {
    entries.push({
      type: 'defeat',
      target,
      message: `${target} is defeated!`,
    });
  }

  return entries;
}

function deriveAdvanceTurn(data: any): CombatLogEntryInput[] {
  const entries: CombatLogEntryInput[] = [];

  const next = data.nextParticipant || data.currentParticipant || {};
  const nextName = next.name || data.nextParticipantName || 'Unknown';
  const round = data.round || data.currentRound || 1;
  const newRound = data.newRound || data.roundAdvanced || false;

  if (newRound) {
    entries.push({ type: 'round', round, message: `Round ${round} begins` });
  }

  entries.push({ type: 'turn', actor: nextName, round, message: `${nextName}'s turn` });

  return entries;
}

function deriveEndEncounter(data: any): CombatLogEntryInput[] {
  let message: string;
  if (data.victory || data.outcome === 'victory') {
    message = 'Victory!';
  } else if (data.defeat || data.outcome === 'defeat') {
    message = 'Defeat';
  } else if (data.fled || data.outcome === 'fled') {
    message = 'Fled from battle';
  } else {
    message = 'Combat ended';
  }

  const xp = data.xpAwarded ?? data.experienceGained;
  if (xp) {
    message += ` (+${xp} XP)`;
  }

  return [{ type: 'encounter-end', message }];
}

/**
 * Derive structured combat-log entries from a combat tool's response data.
 * Returns `[]` for non-combat tools or unusable data so the log stays clean.
 */
export function deriveCombatLogEntries(toolName: string, data: any): CombatLogEntryInput[] {
  if (!data || typeof data !== 'object') return [];

  switch (normalize(toolName)) {
    case 'create_encounter':
    case 'start_combat':
      return deriveEncounterStart(data);
    case 'execute_combat_action':
    case 'combat_action':
      return deriveCombatAction(data);
    case 'advance_turn':
    case 'next_turn':
      return deriveAdvanceTurn(data);
    case 'end_encounter':
    case 'end_combat':
      return deriveEndEncounter(data);
    default:
      return [];
  }
}
