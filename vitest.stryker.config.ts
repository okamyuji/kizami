import { defineConfig } from 'vitest/config';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: {
    env: { KIZAMI_TRANSCRIPT_ARCHIVE_DIR: join(tmpdir(), 'kizami-test-transcripts') },
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
      'tests/config.test.ts',
      'tests/cli.test.ts',
      'tests/archive/store.test.ts',
      'tests/archive/resolve.test.ts',
      'tests/archive/show.test.ts',
      'tests/archive/resume.test.ts',
      'tests/hooks/save.test.ts',
      'tests/search/archive-scan.test.ts',
    ],
  },
});
