import React from 'react';
import { useTheme } from '../context/ThemeContext';

type ThemeKey = 'dark' | 'terminal' | 'fantasy' | 'light';

interface ThemeMeta {
  key: ThemeKey;
  label: string;
  icon: string;
  bg: string;
  panel: string;
  accent: string;
  text: string;
  border: string;
}

const THEMES: ThemeMeta[] = [
  { key: 'dark',     label: 'Тёмная',   icon: '🌙', bg: '#181825', panel: '#313244', accent: '#b4befe', text: '#cdd6f4', border: '#52546a' },
  { key: 'terminal', label: 'Терминал', icon: '💻', bg: '#0a0a0a', panel: '#1a1a1a', accent: '#00ff41', text: '#00ff41', border: '#00451a' },
  { key: 'fantasy',  label: 'Фэнтези',  icon: '📜', bg: '#f0e6d2', panel: '#e6dcc8', accent: '#8b0000', text: '#2c241b', border: '#8c806e' },
  { key: 'light',    label: 'Светлая',  icon: '☀️', bg: '#faf8f6', panel: '#f0efeb', accent: '#da7756', text: '#2d2d2d', border: '#d0ccc6' },
];

export const ThemeSelector: React.FC = () => {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-3">
      <label className="block text-sm font-bold text-terminal-green tracking-wide">ВИЗУАЛЬНАЯ ТЕМА</label>
      <div className="grid grid-cols-2 gap-3">
        {THEMES.map((t) => {
          const active = theme === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTheme(t.key)}
              aria-pressed={active}
              className={`group relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-all duration-200 ${
                active
                  ? 'border-terminal-green-bright ring-1 ring-terminal-green-bright bg-terminal-green/10'
                  : 'border-terminal-green-dim hover:border-terminal-green/50 bg-terminal-dim hover:-translate-y-0.5'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg leading-none">{t.icon}</span>
                <span className="font-bold text-sm text-terminal-green">{t.label}</span>
                {active && <span className="ml-auto text-terminal-green-bright text-xs leading-none">●</span>}
              </div>

              {/* Mini preview window — uses each theme's real palette */}
              <div
                className="rounded-md overflow-hidden border shadow-sm"
                style={{ backgroundColor: t.bg, borderColor: t.border }}
              >
                <div className="flex items-center gap-1 px-2 py-1.5" style={{ backgroundColor: t.panel }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.accent }} />
                  <span className="h-1 w-8 rounded-full" style={{ backgroundColor: t.text, opacity: 0.45 }} />
                </div>
                <div className="px-2 py-2 space-y-1.5">
                  <span className="block h-1 w-full rounded-full" style={{ backgroundColor: t.text, opacity: 0.85 }} />
                  <span className="block h-1 w-2/3 rounded-full" style={{ backgroundColor: t.text, opacity: 0.35 }} />
                  <span className="block h-1 w-5/12 rounded-full" style={{ backgroundColor: t.accent }} />
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-terminal-green-dim">
        Выберите визуальный стиль интерфейса. По умолчанию — мягкая тёмная тема.
      </p>
    </div>
  );
};
