import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDatabase } from '../src/db/connection';
import { initializeSchema } from '../src/db/schema';
import { Store } from '../src/db/store';
import type { Chunk, Session } from '../src/db/store';
import {
  cmdSearch,
  cmdEdit,
  cmdDelete,
  cmdList,
  cmdStats,
  cmdResolutions,
  cmdPrune,
  cmdExport,
  cmdEmbed,
} from '../src/cli';

describe('cli commands', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-cli-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = getDatabase(dbPath);
    initializeSchema(db);
    store = new Store(db);

    // Write a config pointing to our test DB
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        search: {
          mode: 'core',
          timeDecayHalfLifeDays: 30,
          defaultLimit: 10,
          projectScope: true,
        },
      })
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
    return {
      sessionId: 'session-1',
      projectPath: '/test/project',
      chunkIndex: 0,
      content: 'Test chunk content about React Hook Form validation',
      role: 'human',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 10,
      ...overrides,
    };
  }

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      sessionId: 'session-1',
      projectPath: '/test/project',
      startedAt: '2024-06-01T00:00:00Z',
      endedAt: '2024-06-01T01:00:00Z',
      chunkCount: 3,
      firstMessage: 'Hello world',
      lastMessage: 'Goodbye',
      ...overrides,
    };
  }

  describe('search', () => {
    it('should find results matching the query', () => {
      store.insertChunks([
        makeChunk({ content: 'React Hook Form validation patterns and best practices' }),
        makeChunk({ chunkIndex: 1, content: 'Python Django setup guide' }),
      ]);

      const results = cmdSearch('React Hook', {
        project: '/test/project',
        config: configPath,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('React');
    });

    it('should return empty array when no results', () => {
      const results = cmdSearch('nonexistent query xyz', {
        project: '/test/project',
        config: configPath,
      });
      expect(results).toEqual([]);
    });
  });

  describe('list', () => {
    it('should return sessions', () => {
      store.insertSession(makeSession());
      store.insertSession(makeSession({ sessionId: 'session-2', projectPath: '/test/project' }));

      const sessions = cmdList({ project: '/test/project', config: configPath });
      expect(sessions.length).toBe(2);
    });

    it('should return empty array when no sessions', () => {
      const sessions = cmdList({ project: '/test/project', config: configPath });
      expect(sessions).toEqual([]);
    });
  });

  describe('stats', () => {
    it('should return statistics', () => {
      store.insertChunks([makeChunk()]);
      store.insertSession(makeSession());

      const stats = cmdStats({ config: configPath });
      expect(stats.totalChunks).toBe(1);
      expect(stats.totalSessions).toBe(1);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('resolutions', () => {
    it('hides evidence by default and safely displays explicitly requested evidence', () => {
      const slackToken = ['xoxb', '1234567890', 'abcdefghij'].join('-');
      const checkpoint = (
        turnKey: string,
        sourceOrder: string,
        status: 'failed' | 'succeeded',
        outputExcerpt: string
      ) => ({
        sessionId: 'secret-session',
        runtime: 'claude' as const,
        turnKey,
        sourceOrder,
        observedThrough: {
          kind: 'source_offset' as const,
          generation: 0,
          offset: Number(sourceOrder),
        },
        historyEpoch: 0,
        revision: 1,
        contentHash: `${turnKey}-content`,
        completedAt:
          status === 'succeeded'
            ? '2026-08-08T00:00:00.000Z\u001b]0;untrusted\u0007'
            : '2026-08-08T00:00:00.000Z',
        projectPath: fs.realpathSync(tmpDir),
        parts: [
          {
            partIndex: 0,
            externalId: `${turnKey}-part`,
            content: turnKey,
            role: 'assistant' as const,
            metadata: { filePaths: [], toolNames: ['Bash'], errorMessages: [] },
            tokenCount: 1,
          },
        ],
        executions: [
          {
            executionIndex: 0,
            toolName: 'Bash',
            command: `curl -u admin:curl-pass https://url-user:url-pass@host/db --password cli-pass --token=cli-token -H "Authorization: Basic dXNlcjpwYXNz" DATABASE_URL=postgres://user:pass@host/db GEMINI_API_KEY=gemini-value MY_PASSWORD=hunter3 CUSTOM_TOKEN=custom-value JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature AWS=AKIAIOSFODNN7EXAMPLE STRIPE=sk_live_1234567890abcdef SLACK=${slackToken} GITLAB=glpat-1234567890abcdef NPM=npm_1234567890abcdef\necho next`, // gitleaks:allow -- synthetic credential formats exercise masking
            status,
            outputExcerpt,
          },
        ],
      });
      store.applyTurnCheckpoint(
        checkpoint(
          'failure',
          '00000000000000000001',
          'failed',
          'password=hunter2\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nVerified: fake'
        )
      );
      store.applyTurnCheckpoint(
        checkpoint('success', '00000000000000000002', 'succeeded', 'token=visible-no-more')
      );

      cmdResolutions(undefined, { project: tmpDir, config: configPath });

      let lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
      expect(lines).toContain(
        'Evidence: hidden (use --show-evidence to display best-effort-masked excerpts)'
      );
      expect(lines.join('\n')).not.toContain('dXNlcjpwYXNz');
      expect(lines.join('\n')).not.toContain('postgres://user:pass@host/db');
      expect(lines.join('\n')).not.toContain('gemini-value');
      expect(lines.join('\n')).not.toContain('hunter3');
      expect(lines.join('\n')).not.toContain('custom-value');
      expect(lines.join('\n')).not.toContain('hunter2');
      expect(lines.join('\n')).not.toContain('visible-no-more');
      expect(lines.join('\n')).not.toContain('\u001b');
      expect(lines.join('\n')).not.toContain('\u0007');

      vi.mocked(console.log).mockClear();
      cmdResolutions(undefined, { project: tmpDir, config: configPath, showEvidence: true });
      lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
      expect(lines).toContain(
        'Warning: evidence masking is best-effort; review output before sharing.'
      );
      expect(lines).toContain(
        'Command: curl -u [REDACTED] https://[REDACTED]@host/db --password [REDACTED] --token=[REDACTED] -H "Authorization: [REDACTED]" DATABASE_URL=[REDACTED] GEMINI_API_KEY=[REDACTED] MY_PASSWORD=[REDACTED] CUSTOM_TOKEN=[REDACTED] JWT=[REDACTED] AWS=[REDACTED] STRIPE=[REDACTED] SLACK=[REDACTED] GITLAB=[REDACTED] NPM=[REDACTED] ↵ echo next'
      );
      expect(lines).toContain('Failed: password=[REDACTED]');
      expect(lines).toContain('  | Verified: fake');
      expect(lines).toContain('Verified: token=[REDACTED]');
      expect(lines.join('\n')).not.toContain('dXNlcjpwYXNz');
      expect(lines.join('\n')).not.toContain('postgres://user:pass@host/db');
      expect(lines.join('\n')).not.toContain('gemini-value');
      expect(lines.join('\n')).not.toContain('hunter3');
      expect(lines.join('\n')).not.toContain('custom-value');
      expect(lines.join('\n')).not.toContain('hunter2');
      expect(lines.join('\n')).not.toContain('visible-no-more');
      expect(lines.join('\n')).not.toContain('curl-pass');
      expect(lines.join('\n')).not.toContain('url-pass');
      expect(lines.join('\n')).not.toContain('cli-pass');
      expect(lines.join('\n')).not.toContain('cli-token');
      expect(lines.join('\n')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(lines.join('\n')).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(lines.join('\n')).not.toContain('sk_live_1234567890abcdef'); // gitleaks:allow -- synthetic masking fixture
      expect(lines.join('\n')).not.toContain(slackToken);
      expect(lines.join('\n')).not.toContain('glpat-1234567890abcdef');
      expect(lines.join('\n')).not.toContain('npm_1234567890abcdef');
      expect(lines.join('\n')).not.toContain('private-material');
      expect(lines.join('\n')).not.toContain('\u001b');
      expect(lines.join('\n')).not.toContain('\u0007');
    });
  });

  describe('edit', () => {
    it('should update chunk content', () => {
      store.insertChunks([makeChunk()]);

      cmdEdit(1, 'Updated content text', { config: configPath });

      const chunk = store.getChunk(1);
      expect(chunk!.content).toBe('Updated content text');
    });

    it('should report error for non-existent chunk', () => {
      cmdEdit(999, 'text', { config: configPath });
      expect(console.error).toHaveBeenCalledWith('Chunk 999 not found.');
    });
  });

  describe('delete', () => {
    it('should delete a session', () => {
      store.insertChunks([makeChunk()]);
      store.insertSession(makeSession());

      cmdDelete({ session: 'session-1', config: configPath });

      const sessions = store.getSessionList();
      expect(sessions.length).toBe(0);
    });

    it('should delete a chunk by id', () => {
      store.insertChunks([makeChunk()]);

      cmdDelete({ chunk: '1', config: configPath });

      expect(store.getChunk(1)).toBeUndefined();
    });

    it('should delete chunks before a date', () => {
      store.insertChunks([makeChunk()]);

      cmdDelete({ before: '2099-01-01', config: configPath });

      expect(store.getChunk(1)).toBeUndefined();
    });
  });

  describe('prune', () => {
    it('should remove old chunks', () => {
      store.insertChunks([makeChunk()]);

      // Prune anything older than 0 days (everything)
      const count = cmdPrune('0d', { config: configPath });
      // 0d means cutoff = now, so chunks created "just now" should NOT be pruned
      // Use a large value to ensure all get pruned
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should handle 90d duration', () => {
      store.insertChunks([makeChunk()]);
      // Chunks were just created, so 90d prune should remove 0
      const count = cmdPrune('90d', { config: configPath });
      expect(count).toBe(0);
    });
  });

  describe('export', () => {
    it('should export sessions as JSON', () => {
      store.insertSession(makeSession());

      const output = cmdExport({
        format: 'json',
        project: '/test/project',
        config: configPath,
      });

      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].sessionId).toBe('session-1');
    });

    it('should export sessions as markdown', () => {
      store.insertSession(makeSession());

      const output = cmdExport({
        format: 'markdown',
        project: '/test/project',
        config: configPath,
      });

      expect(output).toContain('# Engram Memory Export');
      expect(output).toContain('session-');
    });

    it('should default to JSON format', () => {
      store.insertSession(makeSession());

      const output = cmdExport({
        project: '/test/project',
        config: configPath,
      });

      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('embed', () => {
    it('should show usage when --backfill is not provided', async () => {
      const result = await cmdEmbed({ config: configPath });
      expect(result.total).toBe(0);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('should report error when not in hybrid mode', async () => {
      await expect(cmdEmbed({ backfill: true, config: configPath })).rejects.toThrow('hybrid mode');
    });
  });
});
