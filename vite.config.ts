import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
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
  },
});
