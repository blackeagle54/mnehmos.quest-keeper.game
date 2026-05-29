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

    it('sets error and does NOT clobber a populated map when the payload has no SKILL_MANAGE_JSON block', async () => {
      // Seed a previously-populated, valid map with non-default values.
      const populated = freshSkills();
      populated.combat = { xp: 5000, level: 30 };
      useSkillStore.setState({ skillsByCharacter: { 'char-1': populated as any } });

      // Response text has NO embedded SKILL_MANAGE_JSON block -> extract returns null.
      callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some markdown with no embedded payload at all.' }],
      });

      await useSkillStore.getState().syncSkills('char-1');

      const s = useSkillStore.getState();
      // Error surfaced, isLoading cleared.
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      // The previously-populated map was NOT overwritten with defaults.
      expect(s.skillsByCharacter['char-1'].combat).toEqual({ xp: 5000, level: 30 });
    });

    it('sets error and does NOT clobber a populated map when the payload is success:false', async () => {
      const populated = freshSkills();
      populated.magic = { xp: 1234, level: 12 };
      useSkillStore.setState({ skillsByCharacter: { 'char-1': populated as any } });

      callTool.mockResolvedValueOnce(
        wrapSkillResponse({
          success: false,
          actionType: 'get_skills',
          characterId: 'char-1',
        })
      );

      await useSkillStore.getState().syncSkills('char-1');

      const s = useSkillStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.skillsByCharacter['char-1'].magic).toEqual({ xp: 1234, level: 12 });
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

    it('sets error and does NOT corrupt state on a success:false payload', async () => {
      const populated = freshSkills();
      populated.combat = { xp: 4000, level: 25 };
      useSkillStore.setState({ skillsByCharacter: { 'char-1': populated as any } });

      callTool.mockResolvedValueOnce(
        wrapSkillResponse({
          success: false,
          actionType: 'grant_xp',
          characterId: 'char-1',
          skill: 'combat',
        })
      );

      await useSkillStore.getState().grantXp('char-1', 'combat', 50);

      const s = useSkillStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      // Existing skill untouched, lastResult not set to the bad payload.
      expect(s.skillsByCharacter['char-1'].combat).toEqual({ xp: 4000, level: 25 });
      expect(s.lastResult).toBeNull();
    });

    it('sets error and does NOT corrupt state on an unparseable payload', async () => {
      const populated = freshSkills();
      populated.combat = { xp: 4000, level: 25 };
      useSkillStore.setState({ skillsByCharacter: { 'char-1': populated as any } });

      callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'No embedded payload here.' }],
      });

      await useSkillStore.getState().grantXp('char-1', 'combat', 50);

      const s = useSkillStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.skillsByCharacter['char-1'].combat).toEqual({ xp: 4000, level: 25 });
      expect(s.lastResult).toBeNull();
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

    it('sets error and does NOT corrupt state on a success:false payload', async () => {
      const populated = freshSkills();
      populated.magic = { xp: 1234, level: 12 };
      useSkillStore.setState({ skillsByCharacter: { 'char-1': populated as any } });

      callTool.mockResolvedValueOnce(
        wrapSkillResponse({ success: false, actionType: 'set_level', characterId: 'char-1', skill: 'magic' })
      );

      await useSkillStore.getState().setLevel('char-1', 'magic', 10);

      const s = useSkillStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
      expect(s.skillsByCharacter['char-1'].magic).toEqual({ xp: 1234, level: 12 });
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

    it('sets error on a success:false payload', async () => {
      callTool.mockResolvedValueOnce(
        wrapSkillResponse({ success: false, actionType: 'check_requirement', characterId: 'char-1', skill: 'crafting' })
      );

      await useSkillStore.getState().checkRequirement('char-1', 'crafting', 10);

      const s = useSkillStore.getState();
      expect(s.error).toBeTruthy();
      expect(s.isLoading).toBe(false);
    });

    it('sets error and returns null on an unparseable payload', async () => {
      callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'No embedded payload here.' }] });

      const result = await useSkillStore.getState().checkRequirement('char-1', 'crafting', 10);

      expect(result).toBeNull();
      expect(useSkillStore.getState().error).toBeTruthy();
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
