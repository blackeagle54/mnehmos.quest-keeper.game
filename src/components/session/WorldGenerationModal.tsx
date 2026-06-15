import React, { useState, useEffect, useRef, useCallback } from 'react';
import { mcpManager } from '../../services/mcpClient';
import { extractEmbeddedJson } from '../../utils/mcpUtils';
import { llmService } from '../../services/llm/LLMService';
import { useSettingsStore } from '../../stores/settingsStore';

// ============================================
// Types
// ============================================

interface GenerationLog {
  id: number;
  message: string;
  type: 'info' | 'success' | 'lore' | 'error';
  timestamp: number;
}

interface GeneratedPOI {
  type: string;
  name: string;
  x: number;
  y: number;
  location?: { x: number; y: number };
  description?: string;
  score?: number;
}

interface WorldGenerationModalProps {
  isOpen: boolean;
  seed?: string;
  worldName: string;
  onComplete: (worldId: string) => void;
  onCancel: () => void;
}

// ============================================
// Generation Phases
// ============================================

const GENERATION_PHASES = [
  { id: 'init', label: 'Инициализация сида мира...', duration: 300 },
  { id: 'tectonic', label: 'Тектонические плиты приходят в движение...', duration: 500 },
  { id: 'heightmap', label: 'Горы поднимаются из глубин...', duration: 600 },
  { id: 'climate', label: 'Ветра несут влагу через земли...', duration: 500 },
  { id: 'biomes', label: 'Формируются леса, пустыни и тундры...', duration: 600 },
  { id: 'rivers', label: 'Реки прорезают долины...', duration: 500 },
  { id: 'lakes', label: 'Озера наполняют горные чаши...', duration: 400 },
  { id: 'regions', label: 'Древние королевства заявляют права на земли...', duration: 600 },
  { id: 'structures', label: 'Города растут вдоль торговых путей...', duration: 800 },
  { id: 'lore', label: 'Легенды записываются...', duration: 0 }, // Duration handled by LLM
  { id: 'complete', label: 'Генерация мира завершена!', duration: 500 },
];

// ============================================
// Component
// ============================================

export const WorldGenerationModal: React.FC<WorldGenerationModalProps> = ({
  isOpen,
  seed,
  worldName,
  onComplete,
  onCancel,
}) => {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [progress, setProgress] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const logIdRef = useRef(0);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  const hasStartedRef = useRef(false);

  const selectedProvider = useSettingsStore((s) => s.selectedProvider);
  const selectedApiKey = useSettingsStore((s) => s.apiKeys[s.selectedProvider]);
  const hasAiProvider = selectedProvider === 'codex' || Boolean(selectedApiKey);

  // Add log entry
  const addLog = useCallback((message: string, type: GenerationLog['type'] = 'info') => {
    const newLog: GenerationLog = {
      id: logIdRef.current++,
      message,
      type,
      timestamp: Date.now(),
    };
    setLogs((prev) => [...prev.slice(-100), newLog]);
  }, []);

  // Scroll logs to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Context-aware LLM lore generation
  const generatePOILore = useCallback(async (
    poi: GeneratedPOI, 
    existingLore: string[], 
    worldContext: string
  ): Promise<{ name: string; description: string }> => {
    const loreContext = existingLore.length > 0
      ? `\n\nPreviously established lore:\n${existingLore.join('\n')}`
      : '';

    const prompt = `You are generating interconnected lore for a fantasy world called "${worldName}".

World Context: ${worldContext}
${loreContext}

Generate a name and one-sentence description for a ${poi.type.toLowerCase()} at coordinates (${poi.location?.x || poi.x}, ${poi.location?.y || poi.y}).

IMPORTANT: Reference existing locations if any for connected world-building.
Think and keep durable world-building notes in English. Write Name and Description for the player in Russian.

Respond in this exact format:
Name: [evocative fantasy name]
Description: [one atmospheric sentence]`;

    try {
      console.log('[WorldGen] Generating lore for:', poi.type);
      const response = await llmService.sendMessage([
        { role: 'user', content: prompt }
      ]);
      
      const nameMatch = response.match(/Name:\s*(.+)/i);
      const descMatch = response.match(/Description:\s*(.+)/i);
      
      return {
        name: nameMatch?.[1]?.trim() || poi.name,
        description: descMatch?.[1]?.trim() || ''
      };
    } catch (e) {
      console.warn('[WorldGen] LLM naming failed:', e);
      return { name: poi.name, description: '' };
    }
  }, [worldName]);

  // Main generation flow
  const runGeneration = useCallback(async () => {
    if (!isOpen || isGenerating || hasStartedRef.current) return;
    
    hasStartedRef.current = true;
    setIsGenerating(true);
    setError(null);
    abortRef.current = false;

    const actualSeed = seed || `world-${Date.now()}`;
    let worldId: string | null = null;
    let structures: GeneratedPOI[] = [];
    
    try {
      // Run visual phases before MCP call
      for (let i = 0; i <= 7; i++) { // Up to 'regions' phase
        if (abortRef.current) return;
        
        const phase = GENERATION_PHASES[i];
        setCurrentPhase(i);
        setProgress(Math.floor((i / 10) * 100));
        addLog(phase.label);
        await new Promise((r) => setTimeout(r, phase.duration));
      }

      // Structures phase - actual MCP call
      setCurrentPhase(8);
      setProgress(75);
      addLog('Города растут вдоль торговых путей...');
      addLog('Вызываю MCP world_manage/generate...', 'info');
      
      console.log('[WorldGen] Calling generate_world with seed:', actualSeed);
      
      const result = await mcpManager.gameStateClient.callTool('world_manage', {
        action: 'generate',
        seed: actualSeed,
        name: worldName,
        width: 100,
        height: 100,
      });

      console.log('[WorldGen] MCP result:', result);

      const content = result.content?.[0];
      if (content?.type === 'text') {
        // The engine wraps results in a RichFormatter envelope (human text + an
        // embedded <!-- WORLD_MANAGE_JSON ... --> block), so parse the embedded
        // payload — a raw JSON.parse would choke on the leading prose.
        const data = extractEmbeddedJson<any>(content.text, 'WORLD_MANAGE_JSON');
        if (!data) {
          throw new Error('Не удалось разобрать ответ world_manage/generate');
        }
        worldId = data.worldId || data.id;
        console.log('[WorldGen] World ID:', worldId);
        
        if (!worldId) {
          throw new Error('world_manage/generate не вернул ID мира');
        }
        
        // worldId is used directly in onComplete callback
        addLog(`Мир создан, ID: ${worldId.slice(0, 8)}...`, 'success');
        
        // world_manage generate returns structureCount (a number), not an array.
        // Fetch actual structures from world_map (action: tiles) for LLM lore.
        const structureCount = data.structureCount ?? data.stats?.structures ?? 0;
        addLog(`В мире точек интереса: ${structureCount}`, 'success');
        
        if (structureCount > 0) {
          addLog('Загружаю детали структур...', 'info');
          try {
            const tilesResult = await mcpManager.gameStateClient.callTool('world_map', {
              action: 'tiles',
              worldId: worldId,
            });
            const tilesContent = tilesResult.content?.[0];
            if (tilesContent?.type === 'text') {
              const tilesData = extractEmbeddedJson<any>(tilesContent.text, 'WORLD_MAP_JSON');
              // null => the response was plain-text / an error payload / malformed,
              // NOT a legitimately empty result. structureCount > 0 reported POIs,
              // so a null parse here is a FAILURE: throw and let the catch below
              // surface it instead of silently claiming "0 structures" succeeded.
              if (!tilesData) {
                throw new Error('Не удалось разобрать ответ world_map/tiles');
              }
              // Envelope parsed: trust its (possibly-empty) structures array.
              structures = Array.isArray(tilesData.structures) ? tilesData.structures : [];
              console.log('[WorldGen] Fetched structures:', structures.length);
              addLog(`Получено структур: ${structures.length}`, 'success');
            } else {
              throw new Error('Некорректный ответ world_map/tiles');
            }
          } catch (e) {
            console.warn('[WorldGen] Failed to fetch structure details:', e);
            addLog('⚠️ Не удалось загрузить детали структур', 'info');
          }
        }
      } else {
        throw new Error('Некорректный ответ generate_world');
      }

      // LLM Lore Generation Phase
      setCurrentPhase(9);
      setProgress(85);
      
      if (!abortRef.current && structures.length > 0 && hasAiProvider) {
        addLog('Летописцы начинают записывать легенды...', 'lore');
        
        const worldContext = `A newly formed world named "${worldName}" with diverse regions. Settlements favor rivers and coasts.`;
        const accumulatedLore: string[] = [];
        
        // Generate lore for top 5 POIs
        const poisToName = structures.slice(0, 5);
        
        for (let i = 0; i < poisToName.length; i++) {
          if (abortRef.current) break;
          
          const poi = poisToName[i];
          const poiType = poi.type?.toLowerCase() || 'location';
          addLog(`Описываю ${poiType}...`, 'info');
          
          try {
            const lore = await generatePOILore(poi, accumulatedLore, worldContext);
            accumulatedLore.push(`- ${lore.name}: ${lore.description}`);
            
            addLog(`📜 ${poi.type || 'Location'}: "${lore.name}"`, 'lore');
            if (lore.description) {
              addLog(`   ${lore.description}`, 'lore');
            }
            
            setProgress(85 + Math.floor((i / poisToName.length) * 10));
          } catch (e) {
            console.warn('[WorldGen] Lore generation failed for POI:', e);
            addLog(`⚠️ Использую стандартное имя для ${poi.type}`, 'info');
          }
          
          await new Promise((r) => setTimeout(r, 200));
        }
      } else if (!hasAiProvider) {
        addLog('⚠️ AI-провайдер не настроен, lore-генерация пропущена', 'info');
        addLog('Настрой API-ключ или Codex OAuth для расширенного lore', 'info');
      } else if (structures.length === 0) {
        addLog('⚠️ Нет структур для летописи', 'info');
      }

      // Complete phase
      setCurrentPhase(10);
      setProgress(100);
      addLog('✨ Генерация мира завершена!', 'success');
      addLog(`Новый мир "${worldName}" готов!`, 'success');

      // Call onComplete with the world ID after a brief delay
      if (worldId) {
        console.log('[WorldGen] Completing with worldId:', worldId);
        setTimeout(() => {
          console.log('[WorldGen] Calling onComplete callback');
          onComplete(worldId!);
        }, 1500);
      } else {
        throw new Error('Генерация мира завершилась, но ID мира отсутствует');
      }

    } catch (err) {
      console.error('[WorldGen] Generation error:', err);
      const errorMsg = err instanceof Error ? err.message : 'Генерация не удалась';
      setError(errorMsg);
      addLog(`❌ Error: ${errorMsg}`, 'error');
    } finally {
      setIsGenerating(false);
    }
  }, [isOpen, isGenerating, seed, worldName, hasAiProvider, addLog, generatePOILore, onComplete]);

  // Start generation when modal opens
  useEffect(() => {
    if (isOpen && !hasStartedRef.current) {
      runGeneration();
    }
  }, [isOpen, runGeneration]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setCurrentPhase(0);
      setLogs([]);
      setProgress(0);

      setError(null);
      setIsGenerating(false);
      abortRef.current = true;
      hasStartedRef.current = false;
    }
  }, [isOpen]);

  const handleCancel = () => {
    abortRef.current = true;
    onCancel();
  };

  if (!isOpen) return null;

  const currentPhaseLabel = GENERATION_PHASES[currentPhase]?.label || 'Обработка...';

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 font-mono">
      <div className="bg-terminal-black border-2 border-terminal-green rounded-lg w-full max-w-2xl mx-4 shadow-glow-xl">
        {/* Header */}
        <div className="border-b border-terminal-green p-4 text-center">
          <h2 className="text-2xl font-bold text-terminal-green animate-pulse">
            🌍 Создание "{worldName}"...
          </h2>
          <p className="text-terminal-green/60 text-sm mt-1">
            Сид: {seed || 'случайный'}
          </p>
        </div>

        {/* Log Area */}
        <div className="h-64 overflow-y-auto p-4 bg-black/50 border-b border-terminal-green/30">
          {logs.map((log) => (
            <div
              key={log.id}
              className={`text-sm mb-1 ${
                log.type === 'success'
                  ? 'text-green-400'
                  : log.type === 'lore'
                  ? 'text-yellow-400 italic'
                  : log.type === 'error'
                  ? 'text-red-400'
                  : 'text-terminal-green/80'
              }`}
            >
              <span className="text-terminal-green/40 mr-2">&gt;</span>
              {log.message}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>

        {/* Progress */}
        <div className="p-4 space-y-3">
          <div className="text-center text-terminal-green text-sm">
            {currentPhaseLabel}
          </div>
          
          <div className="h-3 bg-terminal-green/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-terminal-green transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          
          <div className="text-center text-terminal-green/60 text-xs">
            {progress}% готово
          </div>

          {error && (
            <div className="text-center text-red-500 text-sm mt-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-terminal-green p-4 flex justify-center">
          <button
            onClick={handleCancel}
            className="px-6 py-2 border border-terminal-green/50 text-terminal-green/70 rounded hover:bg-terminal-green/10 transition-colors"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
};

export default WorldGenerationModal;
