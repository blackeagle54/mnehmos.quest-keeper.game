import React, { useState, useEffect } from 'react';
import { usePartyStore, MemberRole, CharacterType } from '../../stores/partyStore';

interface CharacterPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  partyId?: string;
}

const ROLE_OPTIONS: { value: MemberRole; label: string; description: string }[] = [
  { value: 'leader', label: 'Лидер', description: 'Командует группой' },
  { value: 'member', label: 'Участник', description: 'Полный участник группы' },
  { value: 'companion', label: 'Спутник', description: 'Союзник без доли добычи' },
  { value: 'hireling', label: 'Наемник', description: 'Оплачиваемый помощник' },
  { value: 'prisoner', label: 'Пленник', description: 'Пленный' },
  { value: 'mount', label: 'Маунт', description: 'Ездовое животное' },
];

const CHARACTER_TYPE_FILTERS: { value: CharacterType | 'all'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'pc', label: 'Игроки' },
  { value: 'npc', label: 'NPCs' },
  { value: 'neutral', label: 'Нейтральные' },
  { value: 'enemy', label: 'Враги' },
];

export const CharacterPickerModal: React.FC<CharacterPickerModalProps> = ({
  isOpen,
  onClose,
  partyId,
}) => {
  // Multi-select state
  const [selectedCharacters, setSelectedCharacters] = useState<Set<string>>(new Set());
  
  const [selectedRole, setSelectedRole] = useState<MemberRole>('member');
  const [typeFilter, setTypeFilter] = useState<CharacterType | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePartyId = usePartyStore((state) => state.activePartyId);
  const unassignedCharacters = usePartyStore((state) => state.unassignedCharacters);
  const syncUnassignedCharacters = usePartyStore((state) => state.syncUnassignedCharacters);
  const addMember = usePartyStore((state) => state.addMember);

  const targetPartyId = partyId || activePartyId;

  // Sync unassigned characters when modal opens
  useEffect(() => {
    if (isOpen) {
      syncUnassignedCharacters();
      setSelectedCharacters(new Set());
      setSelectedRole('member');
      setSearchQuery('');
      setError(null);
    }
  }, [isOpen, syncUnassignedCharacters]);

  if (!isOpen) return null;

  // Filter characters
  const filteredCharacters = unassignedCharacters.filter((char) => {
    // Type filter
    if (typeFilter !== 'all' && char.characterType !== typeFilter) {
      return false;
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        char.name.toLowerCase().includes(query) ||
        char.class.toLowerCase().includes(query) ||
        (char.race && char.race.toLowerCase().includes(query))
      );
    }

    return true;
  });

  const toggleSelection = (charId: string) => {
    const newSet = new Set(selectedCharacters);
    if (newSet.has(charId)) {
      newSet.delete(charId);
    } else {
      newSet.add(charId);
    }
    setSelectedCharacters(newSet);
  };

  const handleAddMember = async () => {
    if (!targetPartyId || selectedCharacters.size === 0) {
      setError('Выбери хотя бы одного персонажа');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let successCount = 0;
      const errors: string[] = [];

      // Add all selected characters
      for (const charId of selectedCharacters) {
        try {
          const success = await addMember(targetPartyId, charId, selectedRole);
          if (success) successCount++;
          else errors.push(`Не удалось добавить персонажа ${charId}`);
        } catch (e: any) {
           errors.push(e.message || `Ошибка при добавлении ${charId}`);
        }
      }
      
      if (successCount === selectedCharacters.size) {
        onClose();
      } else {
         setError(`Добавлено ${successCount}/${selectedCharacters.size}. Ошибки: ${errors.join(', ')}`);
      }
    } catch (err: any) {
      setError(err.message || 'Не удалось добавить участников');
    } finally {
      setLoading(false);
    }
  };

  const getTypeColor = (type: CharacterType) => {
    switch (type) {
      case 'pc':
        return 'text-terminal-green';
      case 'npc':
        return 'text-blue-400';
      case 'neutral':
        return 'text-gray-400';
      case 'enemy':
        return 'text-red-400';
      default:
        return 'text-terminal-green';
    }
  };

  const getTypeLabel = (type: CharacterType) => {
    switch (type) {
      case 'pc':
        return 'PC';
      case 'npc':
        return 'NPC';
      case 'neutral':
        return 'Нейтральный';
      case 'enemy':
        return 'Враг';
      default:
        return type;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/95 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-terminal-black border-2 border-terminal-green rounded-xl w-full max-w-md max-h-[85vh] overflow-hidden shadow-glow-xl flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-terminal-green/30 bg-terminal-green/5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-terminal-green">+ ДОБАВИТЬ УЧАСТНИКА</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full border border-terminal-green/50 text-terminal-green hover:bg-terminal-green/20 transition-colors flex items-center justify-center"
            >
              X
            </button>
          </div>
        </div>

        {/* Search & Filter */}
        <div className="p-3 border-b border-terminal-green/20 space-y-3">
          {/* Search */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск персонажей..."
            className="w-full bg-terminal-black border border-terminal-green/50 text-terminal-green px-3 py-2 rounded-lg focus:outline-none focus:border-terminal-green text-sm"
          />

          {/* Type Filter */}
          <div className="flex gap-1 flex-wrap">
            {CHARACTER_TYPE_FILTERS.map((filter) => (
              <button
                key={filter.value}
                onClick={() => setTypeFilter(filter.value)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  typeFilter === filter.value
                    ? 'bg-terminal-green text-black font-bold'
                    : 'bg-terminal-green/10 text-terminal-green hover:bg-terminal-green/20'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {/* Character List */}
        <div className="flex-1 overflow-y-auto">
          {filteredCharacters.length > 0 ? (
            <div className="divide-y divide-terminal-green/10">
              {filteredCharacters.map((char) => (
                <button
                  key={char.id}
                  onClick={() => toggleSelection(char.id)}
                  className={`w-full p-3 text-left transition-colors ${
                    selectedCharacters.has(char.id)
                      ? 'bg-terminal-green/20'
                      : 'hover:bg-terminal-green/10'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* Selection Indicator - CHECKBOX */}
                    <div
                      className={`w-5 h-5 border-2 flex items-center justify-center transition-all rounded ${
                        selectedCharacters.has(char.id)
                          ? 'border-terminal-green bg-terminal-green'
                          : 'border-terminal-green/50'
                      }`}
                    >
                      {selectedCharacters.has(char.id) && (
                         <span className="text-black font-bold text-xs">✓</span>
                      )}
                    </div>

                    {/* Character Info */}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-terminal-green truncate">{char.name}</div>
                      <div className="text-xs text-terminal-green/60">
                        Ур. {char.level} {char.class}
                        {char.race && ` · ${char.race}`}
                      </div>
                    </div>

                    {/* Type Badge */}
                    <span className={`text-xs px-2 py-0.5 rounded ${getTypeColor(char.characterType)} bg-current/10`}>
                      {getTypeLabel(char.characterType)}
                    </span>

                    {/* HP */}
                    <div className="text-xs text-terminal-green/60 text-right">
                      <div>ОЗ</div>
                      <div>
                        {char.hp}/{char.maxHp}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center">
              <div className="text-terminal-green/50 text-sm mb-2">
                {unassignedCharacters.length === 0
                  ? 'Нет свободных персонажей'
                  : 'Нет персонажей по этому поиску'}
              </div>
              {unassignedCharacters.length === 0 && (
                <div className="text-xs text-terminal-green/30">
                  Все персонажи уже состоят в группах
                </div>
              )}
            </div>
          )}
        </div>

        {/* Role Selection (shown when ANY selected) */}
        {selectedCharacters.size > 0 && (
          <div className="p-3 border-t border-terminal-green/20 bg-terminal-green/5">
            <div className="flex justify-between items-center mb-2">
              <label className="text-xs font-bold text-terminal-green/70 uppercase">
                Назначить роль ({selectedCharacters.size})
              </label>
              <button 
                 onClick={() => setSelectedCharacters(new Set())}
                 className="text-xs text-terminal-green/50 hover:text-terminal-green underline cursor-pointer"
              >
                 Очистить
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {ROLE_OPTIONS.map((role) => (
                <button
                  key={role.value}
                  onClick={() => setSelectedRole(role.value)}
                  className={`px-2 py-2 text-xs rounded transition-all ${
                    selectedRole === role.value
                      ? role.value === 'leader'
                        ? 'bg-yellow-500/20 border-2 border-yellow-500 text-yellow-400'
                        : 'bg-terminal-green/20 border-2 border-terminal-green text-terminal-green'
                      : 'bg-black/30 border border-terminal-green/30 text-terminal-green/70 hover:border-terminal-green/50'
                  }`}
                >
                  {role.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-900/30 border-t border-red-500/50 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-terminal-green/30 flex gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-terminal-green/50 text-terminal-green rounded-lg hover:bg-terminal-green/10 transition-colors"
          >
            Отмена
          </button>
          <div className="flex-1" />
          <button
            onClick={handleAddMember}
            disabled={selectedCharacters.size === 0 || loading}
            className="px-6 py-2 bg-terminal-green text-black font-bold rounded-lg hover:bg-terminal-green-bright transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(0,255,0,0.3)] flex items-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin">*</span>
                Добавление...
              </>
            ) : (
              <>+ Добавить {selectedCharacters.size > 0 ? `(${selectedCharacters.size})` : ''} в группу</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CharacterPickerModal;
