/**
 * Tests for skillStore.ts
 *
 * Zustand persist store for the OSRS-style skill system. Talks to the engine
 * via the single mcpManager bridge (skill_manage tool). Mock the bridge BEFORE
 * importing the store so the lazy `import('../services/mcpClient')` resolves to
 * the mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP client bridge before importing the store.
vi.mock('../services/mcpClient', () => ({
  mcpManager: {
    gameStateClient: {
      callTool: vi.fn(),
    },
  },
}));

import { useSkillStore } from './skillStore';
import { mcpManager } from '../services/mcpClient';
import { SKILL_NAMES } from '../data/skills';

const callTool = mcpManager.gameStateClient.callTool as ReturnType<typeof vi.fn>;

// The engine wraps the JSON payload in markdown + an embedded comment block
// (RichFormatter.embedJson(parsed, 'SKILL_MANAGE')). Shape responses the way the
// live tool actually returns them so the store's extraction path is exercised.
function wrapSkillResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Some markdown\n<!-- SKILL_MANAGE_JSON\n${JSON.stringify(payload)}\nSKILL_MANAGE_JSON -->\n`,
      },
    ],
  };
}

function freshSkills() {
  const skills: Record<string, { xp: number; level: number }> = {};
  for (const name of SKILL_NAMES) skills[name] = { xp: 0, level: 1 };
  return skills;
}

describe('skillStore', () => {
  beforeEach(() => {
    useSkillStore.setState({
      skillsByCharacter: {},
      selectedSkill: null,
      isLoading: false,
      error: null,
      lastResult: null,
    });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('has the expected defaults', () => {
      const s = useSkillStore.getState();
      expect(s.skillsByCharacter).toEqual({});
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
    });
  });

  describe('syncSkills', () => {
    it('calls skill_manage get_skills and populates the skills map', async () => {
      callTool.mockResolvedValueOnce(
        wrapSkillResponse({
          success: true,
          actionType: 'get_skills',
          characterId: 'char-1',
          skills: freshSkills(),
        })
      );

      await useSkillStore.getState().syncSkills('char-1');

      expect(callTool).toHaveBeenCalledWith('skill_manage', {
        action: 'get_skills',
        characterId: 'char-1',
      });

      const skills = useSkillStore.getState().skillsByCharacter['char-1'];
      expect(skills).toBeDefined();
      expect(Object.keys(skills)).toEqual([...SKILL_NAMES]);
      expect(skills.combat).toEqual({ xp: 0, level: 1 });
      expect(useSkillStore.getState().isLoading).toBe(false);
    });
  });

  describe('grantXp', () => {
    it('calls skill_manage grant_xp with the right args and updates state', async () => {
      callTool.mockResolvedValueOnce(
        wrapSkillResponse({
          success: true,
          actionType: 'grant_xp',
          characterId: 'char-1',
          skill: 'combat',
          amount: 100,
          oldXp: 0,
          newXp: 100,
          oldLevel: 1,
          newLevel: 2,
          leveledUp: true,
        })
      );

      await useSkillStore.getState().grantXp('char-1', 'combat', 100);

      expect(callTool).toHaveBeenCalledWith('skill_manage', {
        action: 'grant_xp',
        characterId: 'char-1',
        skill: 'combat',
        amount: 100,
      });

      // The store reflects the new xp/level for that skill from the response.
      const skills = useSkillStore.getState().skillsByCharacter['char-1'];
      expect(skills.combat).toEqual({ xp: 100, level: 2 });
      expect(useSkillStore.getState().lastResult?.leveledUp).toBe(true);
    });
  });

  describe('setLevel', () => {
    it('calls skill_manage set_level with the right args', async () => {
      callTool.mockResolvedValueOnce(
        wrapSkillResponse({
          success: true,
          actionType: 'set_level',
          characterId: 'char-1',
          skill: 'magic',
          level: 10,
          xp: 1154,
        })
      );

      await useSkillStore.getState().setLevel('char-1', 'magic', 10);

      expect(callTool).toHaveBeenCalledWith('skill_manage', {
        action: 'set_level',
        characterId: 'char-1',
        skill: 'magic',
        level: 10,
      });

      const skills = useSkillStore.getState().skillsByCharacter['char-1'];
      expect(skills.magic).toEqual({ xp: 1154, level: 10 });
    });
  });

  describe('checkRequirement', () => {
    it('calls skill_manage check_requirement and returns the result', async () => {
      callTool.mockResolvedValueOnce(
        wrapSkillResponse({
          success: true,
          actionType: 'check_requirement',
          characterId: 'char-1',
          skill: 'crafting',
          currentLevel: 5,
          requiredLevel: 10,
          met: false,
          shortfall: 5,
        })
      );

      const result = await useSkillStore.getState().checkRequirement('char-1', 'crafting', 10);

      expect(callTool).toHaveBeenCalledWith('skill_manage', {
        action: 'check_requirement',
        characterId: 'char-1',
        skill: 'crafting',
        level: 10,
      });
      expect(result?.met).toBe(false);
      expect(result?.shortfall).toBe(5);
    });
  });

  describe('error handling (callTool rejects, not returns)', () => {
    it('syncSkills catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce({ code: -32603, message: 'JSON-RPC error: boom' });

      // Must NOT throw — a thrown rejection into a React setter would crash render.
      await expect(useSkillStore.getState().syncSkills('char-1')).resolves.toBeUndefined();

      const s = useSkillStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
    });

    it('grantXp catches a rejection and sets error without throwing', async () => {
      callTool.mockRejectedValueOnce(new Error('network down'));

      await expect(
        useSkillStore.getState().grantXp('char-1', 'combat', 50)
      ).resolves.toBeUndefined();

      expect(useSkillStore.getState().error).toBeTruthy();
      expect(useSkillStore.getState().isLoading).toBe(false);
    });
  });

  describe('persist partialize', () => {
    it('persists only ids/prefs, never the server-derived skills list', async () => {
      const persistApi = (useSkillStore as unknown as {
        persist: { getOptions: () => { partialize?: (s: any) => any } };
      }).persist;
      const partialize = persistApi.getOptions().partialize;
      expect(partialize).toBeTypeOf('function');

      const partial = partialize!({
        skillsByCharacter: { 'char-1': freshSkills() },
        selectedSkill: 'combat',
        isLoading: true,
        error: 'x',
        lastResult: { actionType: 'grant_xp' },
      });

      expect(partial).not.toHaveProperty('skillsByCharacter');
      expect(partial).not.toHaveProperty('lastResult');
      expect(partial).not.toHaveProperty('isLoading');
      expect(partial.selectedSkill).toBe('combat');
    });
  });
});
