import React from 'react';
import { useGameStateStore } from '../../stores/gameStateStore';
import { usePartyStore } from '../../stores/partyStore';
import {
  useQuestChainStore,
  type ChainGraph,
  type ChainQuestNode,
  type UnlockState,
} from '../../stores/questChainStore';

// Per-unlock-state flavor for the terminal UI. Keyed by UnlockState so it can
// never drift from the engine's derived states.
const UNLOCK_META: Record<UnlockState, { label: string; icon: string; cls: string }> = {
  completed: {
    label: 'Completed',
    icon: '✓',
    cls: 'bg-terminal-green text-terminal-black',
  },
  active: {
    label: 'Active',
    icon: '▶',
    cls: 'bg-terminal-green/20 text-terminal-green border border-terminal-green',
  },
  available: {
    label: 'Available',
    icon: '○',
    cls: 'bg-terminal-black text-terminal-green border border-terminal-green/60',
  },
  locked: {
    label: 'Locked',
    icon: '🔒',
    cls: 'bg-terminal-black text-terminal-green/40 border border-terminal-green/20',
  },
};

interface ChainQuestNodeProps {
  node: ChainQuestNode;
  /** Whether this character has reached (completed) this branch point. */
  branchesReachable: boolean;
  onSelectBranch: (questId: string, choiceId: string) => void;
}

const ChainQuestNodeCard: React.FC<ChainQuestNodeProps> = ({
  node,
  branchesReachable,
  onSelectBranch,
}) => {
  const meta = UNLOCK_META[node.unlockState] ?? UNLOCK_META.locked;
  const dimmed = node.unlockState === 'locked';

  return (
    <div
      data-testid="chain-quest-node"
      className={`border rounded p-4 ${
        dimmed
          ? 'border-terminal-green/20 bg-terminal-black'
          : 'border-terminal-green/40 bg-terminal-green/5'
      }`}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {node.order !== undefined && (
            <span className="text-xs text-terminal-green/40 shrink-0">#{node.order + 1}</span>
          )}
          <span
            className={`font-bold uppercase tracking-wider truncate ${
              dimmed ? 'text-terminal-green/40' : 'text-terminal-green'
            }`}
          >
            {node.name}
          </span>
        </div>
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${meta.cls}`}
          data-testid="chain-unlock-badge"
        >
          {meta.icon} {meta.label}
        </span>
      </div>

      {/* Skill / prerequisite gates surfaced ONLY for locked nodes so the player
          understands why a quest is gated. Once a quest is available/active/
          completed the gate is moot, so we don't show stale "Requires:" text. */}
      {dimmed && node.skillRequirements.length > 0 && (
        <div className="text-xs text-terminal-green/50 mb-1">
          Requires:{' '}
          {node.skillRequirements
            .map((r) => `${r.skill} Lv${r.level}`)
            .join(', ')}
        </div>
      )}

      {/* Branch choices: only offered when the source quest has been reached
          (completed) by this character. The button calls selectBranch with the
          SOURCE quest's id — the engine keys the decision on that quest. */}
      {node.branches.length > 0 && branchesReachable && (
        <div className="mt-3 border-t border-terminal-green/20 pt-3">
          <div className="text-xs text-terminal-green/60 uppercase tracking-wider mb-2">
            Choose your path
          </div>
          <div className="flex flex-col gap-2">
            {node.branches.map((branch) => (
              <button
                key={branch.choiceId}
                data-testid="chain-branch-button"
                onClick={() => onSelectBranch(node.id, branch.choiceId)}
                className="text-left text-sm border border-terminal-green/60 px-3 py-2 text-terminal-green hover:bg-terminal-green/10 transition-colors rounded"
              >
                {branch.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const QuestChainView: React.FC = () => {
  // Active character: gameStateStore is the POV source of truth; fall back to
  // the party's active member if gameState hasn't resolved one yet. (Identical
  // resolution to SkillsView.)
  const activeCharacterId = useGameStateStore((s) => s.activeCharacterId);
  const activeMember = usePartyStore((s) => s.getActiveCharacterMember());
  const characterId = activeCharacterId ?? activeMember?.characterId ?? null;

  const chainsByCharacter = useQuestChainStore((s) => s.chainsByCharacter);
  const chainList = useQuestChainStore((s) => s.chainList);
  const isLoading = useQuestChainStore((s) => s.isLoading);
  const error = useQuestChainStore((s) => s.error);
  const listChains = useQuestChainStore((s) => s.listChains);
  const loadChain = useQuestChainStore((s) => s.loadChain);
  const selectBranch = useQuestChainStore((s) => s.selectBranch);

  // On mount / character change: discover the chains, then load each chain's
  // per-character graph. listChains has no character axis; loadChain derives the
  // unlock states for the active character.
  React.useEffect(() => {
    if (characterId) {
      listChains();
    }
  }, [characterId, listChains]);

  React.useEffect(() => {
    if (!characterId) return;
    for (const summary of chainList) {
      loadChain(summary.chainId, characterId);
    }
  }, [characterId, chainList, loadChain]);

  const characterChains: Record<string, ChainGraph> | null = characterId
    ? chainsByCharacter[characterId] ?? null
    : null;

  const handleSelectBranch = React.useCallback(
    (questId: string, choiceId: string) => {
      if (!characterId) return;
      // Fire the engine mutation, then refresh the affected chain so the newly
      // unlocked branch target flips out of 'locked' for this character.
      // Promise.resolve() guards against a non-thenable return (and never lets a
      // rejection escape into the click handler).
      void Promise.resolve(selectBranch(questId, choiceId, characterId)).then(() => {
        for (const summary of chainList) {
          loadChain(summary.chainId, characterId);
        }
      });
    },
    [characterId, chainList, selectBranch, loadChain]
  );

  if (!characterId) {
    return (
      <div className="h-full w-full flex items-center justify-center p-8 text-terminal-green/60">
        <div className="text-center space-y-4">
          <p className="text-xl">NO CHARACTER SELECTED</p>
          <p className="text-sm">Select a character to view quest chains.</p>
        </div>
      </div>
    );
  }

  const graphs = characterChains ? Object.entries(characterChains) : [];

  return (
    <div className="h-full w-full overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-terminal-green/20 scrollbar-track-transparent">
      <div className="border-b-2 border-terminal-green pb-4 mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold uppercase tracking-widest text-terminal-green flex items-center gap-2">
          <span>🔗</span> Quest Chains
        </h2>
        <button
          onClick={() => characterId && listChains()}
          className="text-xs border border-terminal-green px-2 py-1 text-terminal-green hover:bg-terminal-green/10 transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 border border-terminal-red/50 bg-terminal-red/10 text-terminal-red px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}

      {isLoading && graphs.length === 0 && (
        <div className="text-terminal-green/60 mb-4">Loading chains…</div>
      )}

      {!isLoading && graphs.length === 0 && !error && (
        <div className="text-terminal-green/60">No quest chains discovered yet.</div>
      )}

      <div className="space-y-8">
        {graphs.map(([chainKey, graph]) => {
          // Key on the store's own map key (the chainId the store keyed this graph
          // under) — unique + stable by construction, so chainId-less graphs (even
          // ones whose quests[0].id collides) can never produce a duplicate React key.
          // A branch point is "reachable" once its source quest is completed by
          // this character (mirrors the engine's select_branch precondition).
          return (
            <section key={chainKey} data-testid="chain-section">
              <h3 className="text-lg font-bold uppercase tracking-wider text-terminal-green/80 mb-3">
                {graph.chainId ?? 'Quest'}
              </h3>
              <div className="space-y-3">
                {graph.quests.map((node) => (
                  <ChainQuestNodeCard
                    key={node.id}
                    node={node}
                    branchesReachable={node.unlockState === 'completed'}
                    onSelectBranch={handleSelectBranch}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};
