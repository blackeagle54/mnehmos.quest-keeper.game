import { create } from 'zustand';
import { mcpManager } from '../services/mcpClient';
import { extractEmbeddedJson } from '../utils/mcpUtils';

/**
 * Extract the embedded NPC_MANAGE_JSON payload from a npc_manage tool response.
 *
 * The consolidated engine returns markdown text with the structured payload
 * embedded in a `<!-- NPC_MANAGE_JSON ... NPC_MANAGE_JSON -->` comment block, so
 * plain JSON.parse of the response text fails — we MUST extract the embedded
 * block. The bridge wraps results as { content: [{ type:'text', text }] }.
 */
function parseNpcResponse<T = any>(result: any): T | null {
  const text: string | undefined = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  return extractEmbeddedJson<T>(text, 'NPC_MANAGE_JSON');
}

// Types matching backend npc-memory.repo.ts
export type Familiarity = 'stranger' | 'acquaintance' | 'friend' | 'close_friend' | 'rival' | 'enemy';
export type Disposition = 'hostile' | 'unfriendly' | 'neutral' | 'friendly' | 'helpful';
export type Importance = 'low' | 'medium' | 'high' | 'critical';

export interface NpcRelationship {
  characterId: string;
  npcId: string;
  npcName?: string;  // Populated from character data
  familiarity: Familiarity;
  disposition: Disposition;
  notes: string | null;
  firstMetAt: string | null;
  lastInteractionAt: string | null;
  interactionCount: number;
}

export interface NpcMemory {
  id: number;
  characterId: string;
  npcId: string;
  npcName?: string;
  summary: string;
  importance: Importance;
  topics: string[];
  createdAt: string;
}

interface NpcState {
  // Data
  relationships: NpcRelationship[];
  memories: NpcMemory[];
  selectedNpcId: string | null;
  isLoading: boolean;
  
  // Actions
  setSelectedNpc: (npcId: string | null) => void;
  fetchRecentMemories: (characterId: string, limit?: number) => Promise<void>;
  fetchNpcHistory: (characterId: string, npcId: string) => Promise<void>;
  clearNpcData: () => void;
}

export const useNpcStore = create<NpcState>((set, _get) => ({
  relationships: [],
  memories: [],
  selectedNpcId: null,
  isLoading: false,

  setSelectedNpc: (npcId) => set({ selectedNpcId: npcId }),

  fetchRecentMemories: async (characterId, limit = 20) => {
    set({ isLoading: true });
    try {
      const result = await mcpManager.gameStateClient.callTool('npc_manage', {
        action: 'get_recent',
        characterId,
        limit
      });

      const data = parseNpcResponse<{ memories: NpcMemory[] }>(result);
      // null => the NPC_MANAGE_JSON envelope was missing/malformed (plain-text
      // or error payload), NOT an entity with zero memories. Treat as a failure:
      // preserve existing memories rather than clobbering them with [].
      if (data === null) {
        console.warn('[npcStore] fetchRecentMemories: malformed/missing NPC_MANAGE_JSON envelope; preserving existing memories');
        return;
      }
      // Envelope parsed successfully — apply the (possibly-empty) memories.
      set({ memories: data.memories ?? [] });
    } catch (e) {
      console.warn('[npcStore] Failed to fetch recent memories:', e);
    } finally {
      set({ isLoading: false });
    }
  },

  fetchNpcHistory: async (characterId, npcId) => {
    set({ isLoading: true, selectedNpcId: npcId });
    try {
      // Fetch relationship and history in parallel
      const [relResult, histResult] = await Promise.all([
        mcpManager.gameStateClient.callTool('npc_manage', { action: 'get_relationship', characterId, npcId }),
        mcpManager.gameStateClient.callTool('npc_manage', { action: 'get_history', characterId, npcId, limit: 50 })
      ]);

      // npc_manage/get_relationship spreads the relationship fields at the top
      // level of the payload (characterId, npcId, familiarity, disposition,
      // notes, firstMetAt, lastInteractionAt, interactionCount) alongside
      // success/actionType/isNew — so the parsed object IS the relationship.
      const relData = parseNpcResponse<NpcRelationship | null>(relResult);
      // npc_manage/get_history returns { ...meta, count, memories } — top-level memories.
      const histData = parseNpcResponse<{ memories: NpcMemory[] }>(histResult);

      // Update relationship in list
      if (relData) {
        set(state => ({
          relationships: state.relationships.some(r => r.npcId === npcId)
            ? state.relationships.map(r => r.npcId === npcId ? relData : r)
            : [...state.relationships, relData]
        }));
      }

      // Update memories for selected NPC.
      // null => the get_history NPC_MANAGE_JSON envelope was missing/malformed,
      // NOT zero history. Preserve existing memories instead of clobbering [].
      if (histData === null) {
        console.warn('[npcStore] fetchNpcHistory: malformed/missing NPC_MANAGE_JSON envelope for get_history; preserving existing memories');
      } else {
        set({ memories: histData.memories ?? [] });
      }
    } catch (e) {
      console.warn('[npcStore] Failed to fetch NPC history:', e);
    } finally {
      set({ isLoading: false });
    }
  },

  clearNpcData: () => set({
    relationships: [],
    memories: [],
    selectedNpcId: null
  })
}));

// Familiarity visual config
export const FAMILIARITY_CONFIG: Record<Familiarity, { color: string; icon: string; label: string }> = {
  stranger: { color: '#6b7280', icon: '👤', label: 'Stranger' },
  acquaintance: { color: '#3b82f6', icon: '🤝', label: 'Acquaintance' },
  friend: { color: '#22c55e', icon: '💚', label: 'Friend' },
  close_friend: { color: '#eab308', icon: '⭐', label: 'Close Friend' },
  rival: { color: '#f97316', icon: '⚔️', label: 'Rival' },
  enemy: { color: '#ef4444', icon: '💀', label: 'Enemy' }
};

// Disposition visual config
export const DISPOSITION_CONFIG: Record<Disposition, { icon: string; label: string }> = {
  hostile: { icon: '😡', label: 'Hostile' },
  unfriendly: { icon: '😒', label: 'Unfriendly' },
  neutral: { icon: '😐', label: 'Neutral' },
  friendly: { icon: '🙂', label: 'Friendly' },
  helpful: { icon: '😊', label: 'Helpful' }
};

// Importance visual config
export const IMPORTANCE_CONFIG: Record<Importance, { color: string; badge: string }> = {
  low: { color: '#6b7280', badge: '' },
  medium: { color: '#3b82f6', badge: '!' },
  high: { color: '#f97316', badge: '!!' },
  critical: { color: '#ef4444', badge: '!!!' }
};
