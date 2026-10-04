import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { builtinModules } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'node20',
    outDir: 'dist',
    lib: {
      entry: {
        cli: resolve(__dirname, 'src/cli.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        'better-sqlite3',
        'sqlite-vec',
        '@huggingface/transformers',
      ],
      output: {
        banner: (chunk) => {
          if (chunk.name === 'cli') {
            return '#!/usr/bin/env node';
          }
          return '';
        },
      },
    },
    minify: false,
    sourcemap: true,
  },
  test: {
    globals: true,
    env: {
      KIZAMI_TRANSCRIPT_ARCHIVE_DIR: join(tmpdir(), 'kizami-test-transcripts'),
    },
    exclude: [...configDefaults.exclude, '.stryker-tmp/**'],
  },
});
