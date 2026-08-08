import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: {
    include: [
      'tests/execution/**/*.test.ts',
      'tests/checkpoint/identity.test.ts',
      'tests/checkpoint/apply.test.ts',
      'tests/checkpoint/coordinator.test.ts',
      'tests/checkpoint/adapters/claude.test.ts',
      'tests/checkpoint/recovery.test.ts',
      'tests/jsonl/fold.test.ts',
      'tests/jsonl/transaction-writer.test.ts',
      'tests/jsonl/writer-reader.test.ts',
      'tests/parser/chunker.test.ts',
      'tests/storage/permissions.test.ts',
      'tests/jsonl/rebuild.test.ts',
      'tests/jsonl/rebuild-vec0.test.ts',
      'tests/store.test.ts',
      'tests/schema.test.ts',
      'tests/maintenance/auto.test.ts',
      'tests/parser/transcript.test.ts',
    ],
  },
});
