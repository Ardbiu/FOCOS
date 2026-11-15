import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { htmlText } from './scripts/html-text.mjs';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const english = JSON.parse(readFileSync(page('src/i18n/en.json'), 'utf8'));

// The site is served at https://ardbiu.github.io/FOCOS/, so every asset and
// every data request is relative to this base.
export default defineConfig({
  base: '/FOCOS/',
  // The page opens in English: the description and share text in the HTML head come from en.json.
  plugins: [htmlText(english)],
  build: {
    rollupOptions: {
      input: {
        main: page('index.html'),
        method: page('method.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
