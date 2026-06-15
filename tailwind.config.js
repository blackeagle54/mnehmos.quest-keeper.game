/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          black: 'rgb(var(--bg-primary) / <alpha-value>)',
          dim: 'rgb(var(--bg-secondary) / <alpha-value>)',
          green: {
            DEFAULT: 'rgb(var(--text-primary) / <alpha-value>)',
            dim: 'rgb(var(--text-secondary) / <alpha-value>)',
            bright: 'rgb(var(--text-highlight) / <alpha-value>)',
          },
          amber: 'rgb(var(--color-amber) / <alpha-value>)',
          cyan: 'rgb(var(--color-cyan) / <alpha-value>)',
          purple: 'rgb(var(--color-purple) / <alpha-value>)',
          red: 'rgb(var(--color-red) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', '"Courier New"', 'monospace'],
        display: ['Cinzel', '"Philosopher"', 'Georgia', 'serif'],
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'fade-in-up': 'fadeInUp 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
}
