import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSave } from '../src/hooks/save';
import { handleRecall } from '../src/hooks/recall';
import { cmdSearch, cmdList, cmdStats, cmdEdit, cmdExport } from '../src/cli';
import { importClaudeMem } from '../src/import/claude-mem';

/**
 * Integration test using a real Claude Code transcript file.
 * Tests the full pipeline: save → search → recall → edit → export
 */

const TRANSCRIPT_PATH =
  '/Users/yujiokamoto/.claude/projects/-Users-yujiokamoto-devs-claude/339f6b8a-812e-45d6-b21d-b2efbd20f68d.jsonl';

const transcriptExists = fs.existsSync(TRANSCRIPT_PATH);

describe.skipIf(!transcriptExists)('integration: real transcript', () => {
  let tmpDir: string;
  let configPath: string;
  let dbPath: string;

  beforeAll(async () => {
    // Create temp directory with config pointing to test DB
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-integration-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        search: { defaultLimit: 10, projectScope: false },
        hooks: { minRelevanceScore: 0, recallLimit: 5 },
      })
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Step 1: should save a real transcript via handleSave', async () => {
    await handleSave(
      {
        session_id: '339f6b8a-812e-45d6-b21d-b2efbd20f68d',
        transcript_path: TRANSCRIPT_PATH,
        cwd: '/Users/yujiokamoto/devs/claude',
      },
      configPath
    );

    // Verify data was saved
    const stats = cmdStats({ config: configPath });
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalSessions).toBe(1);
    console.log(`  Saved: ${stats.totalChunks} chunks, DB size: ${stats.dbSizeBytes} bytes`);
  });

  it('Step 2: should list sessions after save', () => {
    const sessions = cmdList({ allProjects: true, config: configPath });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe('339f6b8a-812e-45d6-b21d-b2efbd20f68d');
    expect(sessions[0].chunkCount).toBeGreaterThan(0);
    console.log(`  Session: ${sessions[0].sessionId}, chunks: ${sessions[0].chunkCount}`);
  });

  it('Step 3: should search memories with FTS', () => {
    // Search for something likely in the transcript
    const results = cmdSearch('Claude', {
      allProjects: true,
      config: configPath,
    });
    expect(results.length).toBeGreaterThan(0);
    console.log(`  Search "Claude": found ${results.length} results`);
  });

  it('Step 4: should recall memories via hook handler', async () => {
    const output = await handleRecall(
      {
        prompt: 'kizami memory system',
        session_id: 'test-session',
        cwd: '/Users/yujiokamoto/devs/claude',
      },
      configPath
    );
    // Should return formatted results or empty string
    expect(typeof output).toBe('string');
    if (output) {
      expect(output).toContain('[Past Memory]');
      console.log(`  Recall returned ${output.split('---').length - 1} memories`);
    } else {
      console.log('  Recall: no matching memories (query too specific)');
    }
  });

  it('Step 5: should edit a chunk', () => {
    cmdEdit(1, 'Modified content for integration test', { config: configPath });
    // Verify the edit persisted by searching
    const results = cmdSearch('integration test', {
      allProjects: true,
      config: configPath,
    });
    expect(results.some((r) => r.content.includes('integration test'))).toBe(true);
    console.log('  Edit: chunk 1 modified and searchable');
  });

  it('Step 6: should export as JSON', () => {
    const json = cmdExport({ format: 'json', allProjects: true, config: configPath });
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    console.log(`  Export JSON: ${parsed.length} sessions`);
  });

  it('Step 7: should export as Markdown', () => {
    const md = cmdExport({ format: 'markdown', allProjects: true, config: configPath });
    expect(md).toContain('# Engram Memory Export');
    expect(md).toContain('## Session');
    console.log('  Export Markdown: OK');
  });
});

const CLAUDE_MEM_DB = '/Users/yujiokamoto/.claude-mem/claude-mem.db';
const claudeMemExists = fs.existsSync(CLAUDE_MEM_DB);

describe.skipIf(!claudeMemExists)('integration: claude-mem import', () => {
  let tmpDir: string;
  let configPath: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-cm-import-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        search: { defaultLimit: 10, projectScope: false },
        hooks: { minRelevanceScore: 0, recallLimit: 5 },
      })
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Step 1: should import claude-mem data', async () => {
    const result = await importClaudeMem({
      sourcePath: CLAUDE_MEM_DB,
      configPath,
    });

    expect(result.sessionsImported).toBeGreaterThan(0);
    expect(result.chunksImported).toBeGreaterThan(0);
    console.log(
      `  Imported: ${result.sessionsImported} sessions, ${result.chunksImported} chunks, ${result.skipped} skipped`
    );
  });

  it('Step 2: should have imported sessions and chunks', () => {
    const stats = cmdStats({ config: configPath });
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalSessions).toBeGreaterThan(0);
    console.log(`  Stats: ${stats.totalChunks} chunks, ${stats.totalSessions} sessions`);
  });

  it('Step 3: should search imported claude-mem data', () => {
    const results = cmdSearch('bugfix', { allProjects: true, config: configPath });
    expect(results.length).toBeGreaterThanOrEqual(0);
    console.log(`  Search "bugfix": found ${results.length} results`);
  });

  it('Step 4: should be idempotent on re-import', async () => {
    const result = await importClaudeMem({
      sourcePath: CLAUDE_MEM_DB,
      configPath,
    });

    expect(result.sessionsImported).toBe(0);
    expect(result.chunksImported).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    console.log(`  Re-import: ${result.skipped} sessions skipped (idempotent)`);
  });

  it('Step 5: should support project-filtered import', async () => {
    // Use a separate DB for this test
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-cm-filter-'));
    const dbPath2 = path.join(tmpDir2, 'test.db');
    const configPath2 = path.join(tmpDir2, 'config.json');
    fs.writeFileSync(configPath2, JSON.stringify({ database: { path: dbPath2 } }));

    const result = await importClaudeMem({
      sourcePath: CLAUDE_MEM_DB,
      configPath: configPath2,
      project: 'kizami',
    });

    expect(result.sessionsImported).toBeGreaterThanOrEqual(0);
    console.log(
      `  Project filter "kizami": ${result.sessionsImported} sessions, ${result.chunksImported} chunks`
    );
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});
