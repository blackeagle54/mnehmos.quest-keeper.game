import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { AdventureView } from '../adventure/AdventureView';
import { BattlemapCanvas } from '../viewport/BattlemapCanvas';
import { WorldMapCanvas } from '../viewport/WorldMapCanvas';
import { NpcJournalView } from '../viewport/NpcJournalView';
import { CharacterSheetView } from '../viewport/CharacterSheetView';
import { SkillsView } from '../viewport/SkillsView';
import { QuestChainView } from '../viewport/QuestChainView';
import { AchievementsView } from '../viewport/AchievementsView';
import { ReputationView } from '../viewport/ReputationView';
import { SettingsView } from '../viewport/SettingsView';

import { useTheme } from '../../context/ThemeContext';

interface MainViewportProps {
  className?: string;
}

export const MainViewport: React.FC<MainViewportProps> = ({ className }) => {
  const { activeTab } = useUIStore();
  const { theme } = useTheme();

  const renderContent = () => {
    switch (activeTab) {
      case 'adventure':
        return <AdventureView />;
      case 'combat':
        return null; // Handled separately to preserve WebGL context
      case 'character':
        return <CharacterSheetView />;
      case 'map':
        return <WorldMapCanvas />;
      case 'journal':
        return <NpcJournalView />;
      case 'skills':
        return <SkillsView />;
      case 'chains':
        return <QuestChainView />;
      case 'achievements':
        return <AchievementsView />;
      case 'reputation':
        return <ReputationView />;
      case 'settings':
        return <SettingsView />;
      default:
        return <div className="p-8 text-center text-terminal-green">Unknown View Module</div>;
    }
  };

  return (
    <div className={`flex flex-col bg-terminal-black h-full border-l border-terminal-green-dim ${className || ''}`}>
      {/* Content Area */}
      <div className={`flex-1 text-terminal-green font-mono flex relative overflow-hidden ${activeTab === 'combat' ? '' : 'bg-terminal-black'}`}>
        
        {/* Persistently mounted BattlemapCanvas to prevent WebGL context loss */}
        <BattlemapCanvas active={activeTab === 'combat'} />

        {/* CRT Grid Effect Background - Only for 3D view in Terminal theme */}
        {activeTab === 'combat' && theme === 'terminal' && (
          <div className="absolute inset-0 opacity-10 pointer-events-none z-10"
            style={{ backgroundImage: 'linear-gradient(0deg, transparent 24%, #003300 25%, #003300 26%, transparent 27%, transparent 74%, #003300 75%, #003300 76%, transparent 77%, transparent), linear-gradient(90deg, transparent 24%, #003300 25%, #003300 26%, transparent 27%, transparent 74%, #003300 75%, #003300 76%, transparent 77%, transparent)', backgroundSize: '50px 50px' }}>
          </div>
        )}

        {/* Other views are unmounted when not active */}
        {activeTab !== 'combat' && (
          <div className="absolute inset-0 flex flex-col w-full h-full bg-terminal-black z-20">
            {renderContent()}
          </div>
        )}
      </div>
    </div>
  );
};