/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: {
        surface: {
          bg: '#0e0d15',
          card: '#1b1a26',
          raise: '#262433',
          line: '#2e2b3e',
        },
        ink: {
          DEFAULT: '#f4f3f8',
          mid: '#a3a0b8',
          dim: '#6c6885',
        },
        data: {
          win: '#34d399',
          loss: '#f87171',
          // A game in progress. Shares the loss hue because red-for-live is the
          // convention every sports app has trained people on, but it is named
          // separately so the code never implies a result where there is none.
          live: '#f87171',
        },
        gold: '#f5c451',
      },
      borderRadius: {
        card: '14px',
      },
    },
  },
}
