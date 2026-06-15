import React, { useState, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { usePartyStore, Party } from '../../stores/partyStore';
import { useGameStateStore } from '../../stores/gameStateStore';
import { mcpManager } from '../../services/mcpClient';
import { llmService } from '../../services/llm/LLMService';
import { WorldGenerationModal } from './WorldGenerationModal';
import { CharacterCreationModal } from '../party/CharacterCreationModal';
import { PartyCreatorModal } from '../party/PartyCreatorModal';

// ============================================
// Types
// ============================================

type WizardStep = 'selection' | 'details' | 'world' | 'party' | 'location' | 'launch';

interface WizardState {
  campaignName: string;
  description: string;
  worldId: string | null;
  partyId: string | null;
  activeCharacterId: string | null;
  startingLocationType: 'tavern' | 'road' | 'dungeon' | 'forest' | 'city' | 'custom';
  startingLocationName: string;
  startingContext: string;
}

interface CampaignSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (sessionId: string, initialPrompt: string) => void;
}

// ============================================
// Main Component
// ============================================

export const CampaignSetupWizard: React.FC<CampaignSetupWizardProps> = ({
  isOpen,
  onClose,
  onComplete,
}) => {
  const [currentStep, setCurrentStep] = useState<WizardStep>('details');
  const [showWorldGenModal, setShowWorldGenModal] = useState(false);
  const [showCharacterModal, setShowCharacterModal] = useState(false);
  const [showPartyModal, setShowPartyModal] = useState(false);
  const [newWorldName, setNewWorldName] = useState('');
  const [worldGenSeed, setWorldGenSeed] = useState('');
  const [isGeneratingContext, setIsGeneratingContext] = useState(false);
  const [wizardState, setWizardState] = useState<WizardState>({
    campaignName: '',
    description: '',
    worldId: null,
    partyId: null,
    activeCharacterId: null,
    startingLocationType: 'tavern',
    startingLocationName: '',
    startingContext: 'Приключение начинается...',
  });

  // Store selectors
  const worlds = useGameStateStore((state) => state.worlds);
  const parties = usePartyStore((state) => state.parties);
  const partyDetails = usePartyStore((state) => state.partyDetails);
  const unassignedCharacters = usePartyStore((state) => state.unassignedCharacters);
  const syncUnassignedCharacters = usePartyStore((state) => state.syncUnassignedCharacters);
  const syncParties = usePartyStore((state) => state.syncParties);
  const createSession = useSessionStore((state) => state.createSession);
  const sessions = useSessionStore((state) => state.sessions);
  const switchSession = useSessionStore((state) => state.switchSession);
  const deleteSession = useSessionStore((state) => state.deleteSession);

  // Party details are already available through partyDetails map
  // No need to fetch - the main view already loads them
  
  // Sync parties and unassigned characters when on party step
  useEffect(() => {
    if (isOpen && currentStep === 'party') {
      syncParties();
      syncUnassignedCharacters();
    }
  }, [isOpen, currentStep, syncParties, syncUnassignedCharacters]);

  // Reset wizard only when modal OPENS, not when stores sync
  const [hasInitialized, setHasInitialized] = useState(false);
  
  useEffect(() => {
    if (isOpen && !hasInitialized) {
      // If sessions exist, start at selection screen. Otherwise, start new campaign flow.
      setCurrentStep(sessions.length > 0 ? 'selection' : 'details');
      setWizardState({
        campaignName: '',
        description: '',
        worldId: worlds.length > 0 ? worlds[0].id : null,
        partyId: parties.length > 0 ? parties[0].id : null,
        activeCharacterId: null,
        startingLocationType: 'tavern',
        startingLocationName: '',
        startingContext: 'Приключение начинается...',
      });
      setHasInitialized(true);
    } else if (!isOpen) {
      setHasInitialized(false);
    }
  }, [isOpen, hasInitialized, worlds, parties]);

  // Update field helper
  const updateField = <K extends keyof WizardState>(key: K, value: WizardState[K]) => {
    setWizardState(prev => ({ ...prev, [key]: value }));
  };

  // Navigation
  const steps: WizardStep[] = ['details', 'world', 'party', 'location', 'launch'];
  const stepLabels: Record<WizardStep, string> = {
    selection: 'Выбор',
    details: 'Детали',
    world: 'Мир',
    party: 'Группа',
    location: 'Место',
    launch: 'Старт',
  };
  const currentIndex = steps.indexOf(currentStep);
  
  const goNext = () => {
    if (currentIndex < steps.length - 1) {
      setCurrentStep(steps[currentIndex + 1]);
    }
  };
  
  const goBack = () => {
    if (currentIndex > 0) {
      setCurrentStep(steps[currentIndex - 1]);
    } else if (currentStep === 'details' && sessions.length > 0) {
        // Allow going back to selection if we have sessions
        setCurrentStep('selection');
    }
  };

  // Launch campaign
  const handleLaunch = () => {
    // Create the session
    const sessionId = createSession({
      name: wizardState.campaignName || 'Новая кампания',
      description: wizardState.description,
      partyId: wizardState.partyId,
      worldId: wizardState.worldId,
      activeCharacterId: wizardState.activeCharacterId,
    });

    // Build the initial prompt for the LLM
    const locationLabel = getLocationLabel(wizardState.startingLocationType);
    const locationName = wizardState.startingLocationName || locationLabel;
    
    const initialPrompt = `
[CAMPAIGN START]
The party begins their adventure in ${locationName}.
Context: ${wizardState.startingContext}

Think and keep durable memory/state in English. Write the player-facing opening scene in Russian.
Generate an immersive opening scene in Russian. Describe the environment, atmosphere, and any immediate hooks or details that draw the party in. Set the tone for an epic adventure.
    `.trim();

    onComplete(sessionId, initialPrompt);
  };

  // Location type labels
  const getLocationLabel = (type: WizardState['startingLocationType']) => {
    const labels: Record<WizardState['startingLocationType'], string> = {
      tavern: 'уютная таверна',
      road: 'открытая дорога',
      dungeon: 'вход в подземелье',
      forest: 'таинственный лес',
      city: 'оживленный город',
      custom: 'свое место',
    };
    return labels[type];
  };

  if (!isOpen) return null;

  // Get selected party members
  const selectedParty = wizardState.partyId ? partyDetails[wizardState.partyId] : null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-terminal-black border-2 border-terminal-green rounded-lg w-full max-w-2xl mx-4 shadow-glow-lg">
        {/* Header */}
        <div className="border-b border-terminal-green p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-terminal-green">
            🎭 Настройка новой кампании
          </h2>
          <button
            onClick={onClose}
            className="text-terminal-green hover:text-terminal-green-bright text-2xl"
          >
            ×
          </button>
        </div>

        {/* Progress Bar (Hidden on selection step) */}
        {currentStep !== 'selection' && (
        <div className="px-4 py-2 border-b border-terminal-green/30">
          <div className="flex justify-between">
            {steps.map((step, idx) => (
              <div
                key={step}
                className={`flex-1 text-center text-sm ${
                  idx <= currentIndex ? 'text-terminal-green' : 'text-terminal-green/30'
                }`}
              >
                {idx < currentIndex ? '✓ ' : ''}
                {stepLabels[step]}
              </div>
            ))}
          </div>
          <div className="mt-2 h-1 bg-terminal-green/20 rounded">
            <div
              className="h-full bg-terminal-green rounded transition-all"
              style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }}
            />
          </div>
        </div>
        )}

        {/* Content */}
        <div className="p-6 min-h-[300px]">
          {/* Step 0: Selection */}
          {currentStep === 'selection' && (
            <div className="space-y-6">
                <div className="flex justify-between items-center">
                    <h3 className="text-lg font-bold text-terminal-green">
                        📂 Существующие кампании
                    </h3>
                    <button
                        onClick={() => setCurrentStep('details')}
                        className="px-4 py-2 bg-terminal-green text-terminal-black rounded font-bold hover:bg-terminal-green-bright transition-colors"
                    >
                        + Новая кампания
                    </button>
                </div>

                <div className="grid gap-3 max-h-[400px] overflow-y-auto pr-2">
                    {sessions.map((session) => (
                        <div 
                            key={session.id}
                            className="bg-terminal-green/5 border border-terminal-green/30 rounded-lg p-4 hover:border-terminal-green transition-all"
                        >
                            <div className="flex justify-between items-start">
                                <div>
                                    <h4 className="font-bold text-terminal-green text-lg mb-1">{session.name}</h4>
                                    <p className="text-terminal-green/60 text-xs mb-3">
                                        Последняя игра: {new Date(session.lastPlayedAt).toLocaleDateString()} в {new Date(session.lastPlayedAt).toLocaleTimeString()}
                                    </p>
                                    
                                    {/* Snapshot Badges */}
                                    <div className="flex flex-wrap gap-2 text-xs">
                                        <span className="px-2 py-1 bg-black/40 rounded text-terminal-green/80 border border-terminal-green/20">
                                            🌍 {session.snapshot?.locationName || 'неизвестно'}
                                        </span>
                                        <span className="px-2 py-1 bg-black/40 rounded text-terminal-green/80 border border-terminal-green/20">
                                            👥 {session.snapshot?.memberCount || 0} участник(ов)
                                        </span>
                                        <span className="px-2 py-1 bg-black/40 rounded text-terminal-green/80 border border-terminal-green/20">
                                            ⚔️ Ур. {session.snapshot?.level || 1}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex flex-col gap-2">
                                    <button 
                                        onClick={async () => {
                                            await switchSession(session.id);
                                            onClose();
                                        }}
                                        className="px-4 py-2 bg-terminal-green/20 border border-terminal-green text-terminal-green rounded hover:bg-terminal-green hover:text-terminal-black transition-colors text-sm font-bold"
                                    >
                                        Продолжить
                                    </button>
                                    <button 
                                        onClick={() => {
                                            if (confirm(`Удалить "${session.name}"? Это удалит все данные кампании.`)) {
                                                deleteSession(session.id);
                                            }
                                        }}
                                        className="px-4 py-1 bg-red-900/10 border border-red-500/30 text-red-400 rounded hover:bg-red-900/30 transition-colors text-xs"
                                    >
                                        Удалить
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                    {sessions.length === 0 && (
                         <div className="text-center py-10 text-terminal-green/40 italic">
                            Активных кампаний нет. Начни новое приключение.
                         </div>
                    )}
                </div>
            </div>
          )}

          {/* Step 1: Details */}
          {currentStep === 'details' && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-terminal-green mb-4">
                📜 Детали кампании
              </h3>
              <div>
                <label className="block text-terminal-green text-sm mb-1">
                  Название кампании *
                </label>
                <input
                  type="text"
                  value={wizardState.campaignName}
                  onChange={(e) => updateField('campaignName', e.target.value)}
                  placeholder="например, Проклятие Страда"
                  className="w-full bg-terminal-black border border-terminal-green rounded px-3 py-2 text-terminal-green focus:outline-none focus:border-terminal-green-bright"
                />
              </div>
              <div>
                <label className="block text-terminal-green text-sm mb-1">
                  Описание (необязательно)
                </label>
                <textarea
                  value={wizardState.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="Краткое описание кампании..."
                  rows={3}
                  className="w-full bg-terminal-black border border-terminal-green rounded px-3 py-2 text-terminal-green focus:outline-none focus:border-terminal-green-bright resize-none"
                />
              </div>
            </div>
          )}

          {/* Step 2: World */}
          {currentStep === 'world' && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-terminal-green mb-4">
                🌍 Выбор мира
              </h3>
              
              {/* Create New World Option */}
              <div className="border-2 border-dashed border-terminal-green/50 rounded p-4 mb-4">
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-2xl">✨</span>
                  <span className="text-terminal-green font-bold">Создать новый мир</span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newWorldName}
                    onChange={(e) => setNewWorldName(e.target.value)}
                    placeholder="Введите название мира..."
                    className="flex-1 bg-terminal-black border border-terminal-green rounded px-3 py-2 text-terminal-green text-sm focus:outline-none focus:border-terminal-green-bright"
                  />
                  <button
                    onClick={() => {
                      if (newWorldName) {
                        setWorldGenSeed(`${newWorldName}-${Date.now()}`);
                        setShowWorldGenModal(true);
                      }
                    }}
                    disabled={!newWorldName}
                    className="px-4 py-2 bg-terminal-green text-terminal-black rounded font-bold text-sm hover:bg-terminal-green-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    🌍 Создать
                  </button>
                </div>
              </div>

              {/* Existing Worlds */}
              {worlds.length === 0 ? (
                <p className="text-terminal-green/70 text-sm">
                  Готовых миров нет. Создай новый выше.
                </p>
              ) : (
                <>
                  <div className="text-terminal-green/60 text-xs uppercase tracking-wider mb-2">
                    Или выбери существующий мир:
                  </div>
                  <div className="grid gap-2 max-h-48 overflow-y-auto">
                    {worlds.map((world: any) => (
                      <div
                        key={world.id}
                        className={`p-3 border rounded transition-all flex items-center justify-between ${
                          wizardState.worldId === world.id
                            ? 'border-terminal-green bg-terminal-green/20'
                            : 'border-terminal-green/30 hover:border-terminal-green'
                        }`}
                      >
                        {/* World Info */}
                        <div 
                          className="flex-1 cursor-pointer"
                          onClick={() => updateField('worldId', world.id)}
                        >
                          <div className="font-bold text-terminal-green">
                            {world.name || 'Безымянный мир'}
                          </div>
                          <div className="text-sm text-terminal-green/60">
                            {world.width && world.height ? `${world.width}x${world.height}` : 'размер неизвестен'}
                          </div>
                        </div>
                        
                        {/* Action Buttons */}
                        <div className="flex gap-2 ml-3">
                          <button
                            onClick={() => {
                              updateField('worldId', world.id);
                              setCurrentStep('party');
                            }}
                            className="px-3 py-1 bg-terminal-green/20 border border-terminal-green text-terminal-green text-xs rounded hover:bg-terminal-green/30 transition-colors"
                            title="Загрузить этот мир и продолжить"
                          >
                            Загрузить
                          </button>
                          <button
                            onClick={async () => {
                              if (confirm(`Удалить мир "${world.name}"? Это действие нельзя отменить.`)) {
                                try {
                                  await mcpManager.gameStateClient.callTool('world_manage', { action: 'delete', id: world.id });
                                  // Refresh worlds list
                                  await useGameStateStore.getState().syncState(true);
                                  // Clear selection if deleted world was selected
                                  if (wizardState.worldId === world.id) {
                                    updateField('worldId', null);
                                  }
                                } catch (e) {
                                  console.error('Failed to delete world:', e);
                                  alert('Не удалось удалить мир');
                                }
                              }
                            }}
                            className="px-3 py-1 bg-red-900/30 border border-red-500/50 text-red-400 text-xs rounded hover:bg-red-900/50 transition-colors"
                            title="Удалить этот мир"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}


          {/* Step 3: Party */}
          {currentStep === 'party' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-terminal-green">
                  👥 Выбор группы
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowCharacterModal(true)}
                    className="px-3 py-1 bg-terminal-green/20 border border-terminal-green text-terminal-green text-xs rounded hover:bg-terminal-green/30 transition-colors"
                  >
                    + Новый персонаж
                  </button>
                  <button
                    onClick={() => setShowPartyModal(true)}
                    className="px-3 py-1 bg-terminal-green/20 border border-terminal-green text-terminal-green text-xs rounded hover:bg-terminal-green/30 transition-colors"
                  >
                    + Новая группа
                  </button>
                </div>
              </div>
              {parties.length === 0 ? (
                <div className="border-2 border-dashed border-terminal-green/40 rounded-lg p-6 text-center">
                  {unassignedCharacters.length > 0 ? (
                    <>
                      {/* Characters exist but no party yet */}
                      <div className="bg-terminal-green/10 border border-terminal-green/30 rounded p-3 mb-4">
                        <p className="text-terminal-green font-bold mb-2">
                          ✓ Готово персонажей: {unassignedCharacters.length}
                        </p>
                        <div className="flex flex-wrap gap-2 justify-center">
                          {unassignedCharacters.map(char => (
                            <span key={char.id} className="px-2 py-1 bg-terminal-green/20 rounded text-xs text-terminal-green">
                              {char.name} - ур. {char.level} {char.class}
                            </span>
                          ))}
                        </div>
                      </div>
                      <p className="text-terminal-green/70 mb-4">
                        Теперь создай группу для своих героев.
                      </p>
                      <div className="flex gap-3 justify-center">
                        <button
                          onClick={() => setShowPartyModal(true)}
                          className="px-4 py-2 bg-terminal-green text-terminal-black rounded font-bold text-sm hover:bg-terminal-green-bright transition-colors"
                        >
                          👥 Создать группу
                        </button>
                        <button
                          onClick={() => setShowCharacterModal(true)}
                          className="px-4 py-2 border border-terminal-green text-terminal-green rounded font-bold text-sm hover:bg-terminal-green/20 transition-colors"
                        >
                          + Добавить персонажа
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* No characters yet */}
                      <p className="text-terminal-green/70 mb-4">
                        Групп пока нет.
                      </p>
                      <p className="text-terminal-green/50 text-sm mb-4">
                        Сначала создай персонажа, затем группу.
                      </p>
                      <div className="flex gap-3 justify-center">
                        <button
                          onClick={() => setShowCharacterModal(true)}
                          className="px-4 py-2 bg-terminal-green text-terminal-black rounded font-bold text-sm hover:bg-terminal-green-bright transition-colors"
                        >
                          ⚔️ Создать персонажа
                        </button>
                        <button
                          onClick={() => setShowPartyModal(true)}
                          className="px-4 py-2 border border-terminal-green text-terminal-green rounded font-bold text-sm hover:bg-terminal-green/20 transition-colors"
                        >
                          👥 Создать группу
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid gap-2 mb-4">
                    {parties.map((party: Party) => (
                      <div
                        key={party.id}
                        className={`p-3 border rounded transition-all flex items-center justify-between ${
                          wizardState.partyId === party.id
                            ? 'border-terminal-green bg-terminal-green/20'
                            : 'border-terminal-green/30 hover:border-terminal-green'
                        }`}
                      >
                        <div 
                          className="flex-1 cursor-pointer"
                          onClick={() => updateField('partyId', wizardState.partyId === party.id ? null : party.id)}
                        >
                          <div className="font-bold text-terminal-green">{party.name}</div>
                          <div className="text-sm text-terminal-green/60">
                            Статус: {party.status}
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            if (confirm(`Удалить группу "${party.name}"? Это действие нельзя отменить.`)) {
                              try {
                                await mcpManager.gameStateClient.callTool('party_manage', { action: 'delete', partyId: party.id });
                                await usePartyStore.getState().syncParties();
                                if (wizardState.partyId === party.id) {
                                  updateField('partyId', null);
                                }
                              } catch (e) {
                                console.error('Failed to delete party:', e);
                                alert('Не удалось удалить группу');
                              }
                            }
                          }}
                          className="px-2 py-1 bg-red-900/30 border border-red-500/50 text-red-400 text-xs rounded hover:bg-red-900/50 transition-colors ml-2"
                          title="Удалить группу"
                        >
                          🗑️
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Character selector from party */}
                  {selectedParty && selectedParty.members.length > 0 && (
                    <div>
                      <label className="block text-terminal-green text-sm mb-2">
                        🎭 Играть за персонажа
                      </label>
                      <div className="grid gap-2">
                        {selectedParty.members.map((member) => (
                          <div
                            key={member.characterId}
                            className={`p-2 border rounded transition-all flex items-center justify-between ${
                              wizardState.activeCharacterId === member.characterId
                                ? 'border-terminal-green bg-terminal-green/20'
                                : 'border-terminal-green/30 hover:border-terminal-green'
                            }`}
                          >
                            <div 
                              className="flex-1 cursor-pointer text-sm text-terminal-green"
                              onClick={() => updateField('activeCharacterId', wizardState.activeCharacterId === member.characterId ? null : member.characterId)}
                            >
                              {member.character?.name || 'неизвестно'} - ур. {member.character?.level || '?'} {member.character?.class || ''}
                            </div>
                            <button
                              onClick={async () => {
                                if (confirm(`Убрать "${member.character?.name}" из группы?`)) {
                                  try {
                                    await mcpManager.gameStateClient.callTool('party_manage', {
                                      action: 'remove_member',
                                      partyId: selectedParty.id,
                                      characterId: member.characterId
                                    });
                                    await usePartyStore.getState().syncPartyDetails(selectedParty.id);
                                    if (wizardState.activeCharacterId === member.characterId) {
                                      updateField('activeCharacterId', null);
                                    }
                                  } catch (e) {
                                    console.error('Failed to remove member:', e);
                                    alert('Не удалось убрать персонажа из группы');
                                  }
                                }
                              }}
                              className="px-2 py-1 bg-red-900/30 border border-red-500/50 text-red-400 text-xs rounded hover:bg-red-900/50 transition-colors ml-2"
                              title="Убрать из группы"
                            >
                              🗑️
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 4: Location */}
          {currentStep === 'location' && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-terminal-green mb-4">
                📍 Начальная локация
              </h3>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {(['tavern', 'road', 'dungeon', 'forest', 'city', 'custom'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => updateField('startingLocationType', type)}
                    className={`p-3 border rounded text-center transition-all ${
                      wizardState.startingLocationType === type
                        ? 'border-terminal-green bg-terminal-green/20 text-terminal-green'
                        : 'border-terminal-green/30 text-terminal-green/70 hover:border-terminal-green'
                    }`}
                  >
                    {type === 'tavern' && '🍺 Таверна'}
                    {type === 'road' && '🛤️ Дорога'}
                    {type === 'dungeon' && '🏰 Подземелье'}
                    {type === 'forest' && '🌲 Лес'}
                    {type === 'city' && '🏙️ Город'}
                    {type === 'custom' && '✏️ Своя'}
                  </button>
                ))}
              </div>

              {wizardState.startingLocationType === 'custom' && (
                <div>
                  <label className="block text-terminal-green text-sm mb-1">
                    Название локации
                  </label>
                  <input
                    type="text"
                    value={wizardState.startingLocationName}
                    onChange={(e) => updateField('startingLocationName', e.target.value)}
                    placeholder="например, Затонувший храм"
                    className="w-full bg-terminal-black border border-terminal-green rounded px-3 py-2 text-terminal-green focus:outline-none focus:border-terminal-green-bright"
                  />
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-terminal-green text-sm">
                    Стартовый контекст
                  </label>
                  <button
                    onClick={async () => {
                      setIsGeneratingContext(true);
                      try {
                        const locationType = wizardState.startingLocationType;
                        const partyName = selectedParty?.name || 'the adventuring party';
                        const characterName = selectedParty?.members.find(
                          m => m.characterId === wizardState.activeCharacterId
                        )?.character?.name || 'the hero';
                        
                        const prompt = `Generate a brief, atmospheric opening scene (2-3 sentences) for a D&D campaign.
The party "${partyName}" begins their adventure in a ${locationType}${wizardState.startingLocationName ? ` called "${wizardState.startingLocationName}"` : ''}.
The main POV character is ${characterName}.
Set the mood, describe the immediate surroundings, and hint at adventure to come.
Think and keep durable memory/state in English. Write the final scene in Russian.
Be evocative and concise.`;

                        const response = await llmService.sendMessage([
                          { role: 'user', content: prompt }
                        ]);
                        
                        updateField('startingContext', response.trim());
                      } catch (e) {
                        console.error('Failed to generate context:', e);
                        alert('Не удалось создать контекст. Проверь API-ключ в настройках.');
                      } finally {
                        setIsGeneratingContext(false);
                      }
                    }}
                    disabled={isGeneratingContext}
                    className="px-3 py-1 bg-terminal-green/20 border border-terminal-green text-terminal-green text-xs rounded hover:bg-terminal-green/30 transition-colors disabled:opacity-50 disabled:cursor-wait"
                  >
                    {isGeneratingContext ? '✨ Генерация...' : '✨ Сгенерировать AI'}
                  </button>
                </div>
                <textarea
                  value={wizardState.startingContext}
                  onChange={(e) => updateField('startingContext', e.target.value)}
                  placeholder="Что происходит в начале приключения?"
                  rows={3}
                  disabled={isGeneratingContext}
                  className="w-full bg-terminal-black border border-terminal-green rounded px-3 py-2 text-terminal-green focus:outline-none focus:border-terminal-green-bright resize-none disabled:opacity-50"
                />
              </div>
            </div>
          )}

          {/* Step 5: Launch */}
          {currentStep === 'launch' && (
            <div className="space-y-4 text-center">
              <h3 className="text-2xl font-bold text-terminal-green mb-4">
                🚀 Готово к запуску
              </h3>
              <div className="bg-terminal-green/10 border border-terminal-green/30 rounded p-4 text-left">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-terminal-green/70">Кампания:</div>
                  <div className="text-terminal-green font-bold">
                    {wizardState.campaignName || 'Безымянная кампания'}
                  </div>
                  <div className="text-terminal-green/70">Мир:</div>
                  <div className="text-terminal-green">
                    {worlds.find(w => w.id === wizardState.worldId)?.name || 'по умолчанию'}
                  </div>
                  <div className="text-terminal-green/70">Группа:</div>
                  <div className="text-terminal-green">
                    {parties.find(p => p.id === wizardState.partyId)?.name || 'нет'}
                  </div>
                  <div className="text-terminal-green/70">Локация:</div>
                  <div className="text-terminal-green">
                    {wizardState.startingLocationName || getLocationLabel(wizardState.startingLocationType)}
                  </div>
                </div>
              </div>
              <p className="text-terminal-green/70 text-sm">
                Нажми «Начать приключение», чтобы запустить кампанию. AI создаст вступительную сцену на основе выбора.
              </p>
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div className="border-t border-terminal-green p-4 flex justify-between">
          <button
            onClick={currentIndex === 0 ? (sessions.length > 0 && currentStep === 'details' ? () => setCurrentStep('selection') : onClose) : goBack}
            className="px-4 py-2 border border-terminal-green/50 text-terminal-green/70 rounded hover:bg-terminal-green/10 transition-colors"
          >
            {currentIndex === 0 && (sessions.length === 0 || currentStep === 'selection') ? 'Отмена' : '← Назад'}
          </button>
          
          {currentStep === 'launch' ? (
            <button
              onClick={handleLaunch}
              disabled={!wizardState.campaignName}
              className="px-6 py-2 bg-terminal-green text-terminal-black rounded font-bold hover:bg-terminal-green-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🎮 Начать приключение
            </button>
          ) : (
            <button
              onClick={goNext}
              disabled={currentStep === 'details' && !wizardState.campaignName}
              className="px-4 py-2 border border-terminal-green text-terminal-green rounded hover:bg-terminal-green hover:text-terminal-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Далее →
            </button>
          )}
        </div>
      </div>

      {/* World Generation Modal */}
      <WorldGenerationModal
        isOpen={showWorldGenModal}
        seed={worldGenSeed}
        worldName={newWorldName}
        onComplete={(newWorldId) => {
          console.log('[CampaignWizard] World generation complete, ID:', newWorldId);
          setShowWorldGenModal(false);
          updateField('worldId', newWorldId);
          setNewWorldName('');
          setWorldGenSeed('');
          // Trigger state refresh to show new world in list
          useGameStateStore.getState().syncState(true).then(() => {
            console.log('[CampaignWizard] State synced, advancing to Party step');
            // Auto-advance to next step (Party)
            setCurrentStep('party');
          });
        }}
        onCancel={() => {
          setShowWorldGenModal(false);
          setWorldGenSeed('');
        }}
      />

      {/* Character Creation Modal */}
      <CharacterCreationModal
        isOpen={showCharacterModal}
        onClose={() => setShowCharacterModal(false)}
        onCreated={async (characterId) => {
          console.log('[CampaignWizard] Character created:', characterId);
          setShowCharacterModal(false);
          // Refresh party store to pick up new character
          await usePartyStore.getState().syncUnassignedCharacters();
          await useGameStateStore.getState().syncState(true);
        }}
      />

      {/* Party Creator Modal */}
      <PartyCreatorModal
        isOpen={showPartyModal}
        onClose={async () => {
          setShowPartyModal(false);
          // Refresh parties after modal closes
          await usePartyStore.getState().syncParties();
        }}
      />
    </div>
  );
};
