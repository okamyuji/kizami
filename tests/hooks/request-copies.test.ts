import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import { recoverTranscripts } from '../../src/hooks/recover';
import { deleteChunkEverywhere } from '../../src/archive/deletions';
import { loadConfig, getDefaultConfig } from '../../src/config';
import { repairRequestCopies, stripRequestCopy } from '../../src/hooks/request-copies';
import { foldCanonicalHistory } from '../../src/jsonl/fold';
import { listJsonlFiles } from '../../src/jsonl/path';
import { checkpointStop } from '../../src/checkpoint/service';
import { parseTranscript } from '../../src/parser/transcript';
import { buildChunks } from '../../src/parser/chunker';
import { chunksToJsonlRecords } from '../../src/jsonl/converter';
import { JsonlWriter } from '../../src/jsonl/writer';

describe('stripRequestCopy', () => {
  it('drops the reminders at the head of the user part and keeps the prompt and the answer', () => {
    expect(
      stripRequestCopy(
        '[User]\n<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>\nq\n\n[Assistant]\nanswer'
      )
    ).toEqual({ prompt: 'q', assistant: 'answer' });
  });

  it('cuts through the last closing tag of the user part, so a tag quoted inside a reminder does not stop it', () => {
    expect(
      stripRequestCopy(
        '[User]\n<system-reminder>see </system-reminder> here SECRET</system-reminder>\nq\n\n[Assistant]\nx </system-reminder> y'
      )
    ).toEqual({ prompt: 'q', assistant: 'x </system-reminder> y' });
  });

  it('keeps no prompt when only reminders were sent, and no answer when none was given', () => {
    expect(stripRequestCopy('[User]\n<system-reminder>a</system-reminder>')).toEqual({
      prompt: '',
      assistant: '',
    });
  });

  it('keeps a prompt that no answer follows', () => {
    expect(stripRequestCopy('[User]\n<system-reminder>a</system-reminder>\nq')).toEqual({
      prompt: 'q',
      assistant: '',
    });
  });

  it('reads a text that starts with the answer and a closing tag at the very start', () => {
    expect(stripRequestCopy('\n\n[Assistant]\nx')).toEqual({ prompt: '', assistant: 'x' });
    expect(stripRequestCopy('</system-reminder>q')).toEqual({ prompt: 'q', assistant: '' });
    expect(stripRequestCopy('\n\n[Assistant]\n</system-reminder>x')).toEqual({
      prompt: '',
      assistant: '</system-reminder>x',
    });
  });

  it('drops the whole user part when the reminder was never closed', () => {
    expect(stripRequestCopy('[User]\n<system-reminder>SECRET\n\n[Assistant]\nanswer')).toEqual({
      prompt: '',
      assistant: 'answer',
    });
  });
});

describe('recoverTranscripts removes api-request-blob copies saved as turns', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonlDir: string;
  let configPath: string;
  let projectsDir: string;
  let cwd: string;
  let file: string;
  const SID = 'blobfix-0001';
  const COPY =
    '<system-reminder>requestcopy</system-reminder>\n<system-reminder>b</system-reminder>';
  type Line = [
    type: 'user' | 'assistant' | 'api-request-blob',
    role: 'user' | 'assistant',
    text: string,
  ];

  const entry = (sid: string, [type, role, text]: Line, asBefore: boolean) =>
    JSON.stringify({
      type: asBefore && type === 'api-request-blob' ? role : type,
      sessionId: sid,
      cwd,
      timestamp: new Date().toISOString(),
      message:
        role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    });
  const transcriptOf = (sid: string) => path.join(projectsDir, '-work', `${sid}.jsonl`);
  const write = (lines: Line[], asBefore = false, sid = SID) => {
    const target = transcriptOf(sid);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lines.map((l) => entry(sid, l, asBefore)).join('\n') + '\n');
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-copies-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonlDir = path.join(tmpDir, 'jsonl');
    const archiveDir = path.join(tmpDir, 'archive');
    // vitest の設定は保管先を共有の一時フォルダへ向けるので、このテストのフォルダに向け直す
    vi.stubEnv('KIZAMI_TRANSCRIPT_ARCHIVE_DIR', archiveDir);
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        storage: { jsonlDir, transcriptArchiveDir: archiveDir },
        maintenance: { enabled: false },
      })
    );
    cwd = path.join(tmpDir, 'work');
    fs.mkdirSync(cwd);
    projectsDir = path.join(tmpDir, 'projects');
    file = transcriptOf(SID);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const withStore = <T>(fn: (store: Store) => T): T => {
    const db = getDatabase(dbPath);
    try {
      initializeSchema(db);
      return fn(new Store(db));
    } finally {
      db.close();
    }
  };
  const query = <T>(sql: string, ...params: string[]): T[] => {
    const db = getDatabase(dbPath);
    try {
      initializeSchema(db);
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  };
  const contents = () =>
    query<{ content: string }>('SELECT content FROM chunks')
      .map((r) => r.content)
      .join('\n');
  const jsonlText = () =>
    listJsonlFiles(jsonlDir)
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('');
  const folded = async () => {
    const history = await foldCanonicalHistory(listJsonlFiles(jsonlDir));
    expect(history.errors).toEqual([]);
    return JSON.stringify([history.legacyChunks, [...history.turns.values()]]);
  };
  const stateFile = () => path.join(tmpDir, 'recover-request-copies.json');
  const recover = () => recoverTranscripts(configPath, projectsDir);

  const stop = (sid = SID) =>
    checkpointStop(
      'claude',
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: sid,
        transcript_path: transcriptOf(sid),
        cwd,
      }),
      configPath
    );

  // 0.8.5 以前は blob 行を発言として読んだ。その読み方の生ログを Stop hook に保存させてから、生ログを本来の形に戻す。
  async function saveAsBefore(lines: Line[], sid = SID): Promise<void> {
    write(lines, true, sid);
    await stop(sid);
    write(lines, false, sid);
  }

  // Stop hook は最後のターンだけを保存するので、前のターンを先に保存させる
  async function saveTwoTurnsAsBefore(first: Line[]): Promise<void> {
    write(first);
    await stop();
    await saveAsBefore([...first, ...polluted]);
  }

  // 0.8.5 以前の recover は v1 の行として取り込んだ。その取り込みを再現する。
  async function importAsBefore(lines: Line[]): Promise<void> {
    write(lines, true);
    const chunks = buildChunks(await parseTranscript(file), SID, cwd);
    new JsonlWriter(jsonlDir).appendRecords(chunksToJsonlRecords(chunks));
    withStore((store) => {
      store.insertChunks(chunks);
      store.insertSession({ sessionId: SID, projectPath: cwd, chunkCount: chunks.length });
    });
    write(lines);
  }

  // 実データの blob 行は、system-reminder のブロックの後ろに本物のプロンプトを続けて持つ
  const polluted: Line[] = [
    ['user', 'user', 'retry question'],
    ['api-request-blob', 'user', `${COPY}\nretry question`],
    ['assistant', 'assistant', 'retry answer'],
  ];

  it('removes the copy from the saved turn and the JSONL store and keeps the prompt and the answer', async () => {
    await saveAsBefore(polluted);
    expect(contents()).toContain('requestcopy');

    const result = await recover();

    expect(result.repaired).toBe(1);
    expect(result.details).toEqual(['blobfix- (trimmed 1 turn)']);
    expect(contents()).not.toContain('requestcopy');
    expect(contents()).toContain('[User]\nretry question\n\n[Assistant]\nretry answer');
    expect(jsonlText()).not.toContain('requestcopy');
    const canonical = await folded();
    expect(canonical).not.toContain('requestcopy');
    expect(canonical).toContain('retry answer');
    expect(fs.statSync(stateFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(tmpDir, 'recover-state.json')).mode & 0o777).toBe(0o600);
  });

  const para = 'CLAUDE.md line '.repeat(40);
  const longCopy = `<system-reminder>\n${Array(12).fill(para).join('\n\n')}\n\nTAILSECRET\n</system-reminder>`;

  it('keeps the prompt and a long answer of a v2 turn whose copy spans several parts', async () => {
    const answer = Array(3).fill('ANSWERWORD '.repeat(300)).join('\n\n');
    await saveAsBefore([
      ['user', 'user', 'long question'],
      ['api-request-blob', 'user', `${longCopy}\nlong question`],
      ['assistant', 'assistant', answer],
    ]);

    await recover();

    expect(contents()).not.toContain('CLAUDE.md line');
    expect(contents()).not.toContain('TAILSECRET');
    expect(query('SELECT content FROM chunks WHERE part_index = 0')).toEqual([
      { content: '[User]\nlong question' },
    ]);
    expect(contents()).toContain('[Assistant]\nANSWERWORD');
    expect(contents().split('ANSWERWORD').length - 1).toBe(900);
  });

  it('keeps out of the DB the part at the place of one deleted by hand', async () => {
    const answer = Array(3).fill('ANSWERWORD '.repeat(300)).join('\n\n');
    await saveAsBefore([
      ['user', 'user', 'long question'],
      ['api-request-blob', 'user', `${longCopy}\nlong question`],
      ['assistant', 'assistant', answer],
    ]);
    const [second] = query<{ id: number; external_id: string }>(
      'SELECT id, external_id FROM chunks WHERE part_index = 1'
    );
    withStore((store) =>
      deleteChunkEverywhere(store, loadConfig(configPath), {
        ...store.getChunk(second.id)!,
        id: second.id,
      })
    );

    await recover();

    expect(query('SELECT id FROM chunks WHERE external_id = ?', second.external_id)).toEqual([]);
    expect(contents()).toContain('[User]\nlong question');
  });

  it('writes the v1 rows left after the copy under the numbers of the rows they replace', async () => {
    const longPrompt = Array(3).fill('PROMPTWORD '.repeat(300)).join('\n\n');
    await importAsBefore([
      ['user', 'user', 'real question'],
      ['assistant', 'assistant', 'real answer'],
      ['api-request-blob', 'user', `${longCopy}\n${longPrompt}`],
      ['assistant', 'assistant', 'second answer'],
      ['user', 'user', 'third question'],
      ['assistant', 'assistant', Array(3).fill('thirdword '.repeat(300)).join('\n\n')],
    ]);
    fs.rmSync(file);
    const third = () =>
      query<{ external_id: string; chunk_index: number; content: string }>(
        "SELECT external_id, chunk_index, content FROM chunks WHERE instr(content, 'third') > 0"
      );
    const before = third();

    await recover();

    expect(third()).toEqual(before);
    const trimmed = query<{ chunk_index: number }>(
      "SELECT chunk_index FROM chunks WHERE instr(content, 'PROMPTWORD') > 0 ORDER BY chunk_index"
    );
    expect(trimmed.map((r) => r.chunk_index)).toEqual([1, 2, 3]);
    expect(contents()).not.toContain('TAILSECRET');
  });

  it('does not put back a session the DB no longer holds', async () => {
    await saveAsBefore(polluted);
    fs.rmSync(file);
    withStore((store) => store.deleteSession(SID));

    expect((await recover()).repaired).toBe(1);

    expect(query('SELECT session_id FROM sessions')).toEqual([]);
    expect(contents()).toBe('');
    expect(await folded()).toContain('retry answer');
  });

  it('adds the errors of the repair to the result of recover', async () => {
    await saveAsBefore(polluted);
    const [month] = listJsonlFiles(jsonlDir);
    fs.renameSync(month, `${month}.real`);
    fs.symlinkSync(`${month}.real`, month);

    const result = await recover();

    expect(result.errors).toBeGreaterThan(0);
    expect(result.details.some((d) => d.includes('error'))).toBe(true);
  });

  it('does not put back into the DB v1 rows it no longer holds', async () => {
    await importAsBefore(polluted);
    fs.rmSync(file);
    withStore((store) => store.deleteChunksBefore('9999-01-01'));

    expect((await recover()).repaired).toBe(1);

    expect(contents()).toBe('');
    expect(await folded()).toContain('retry answer');
  });

  it('removes every piece of a long copy that a v1 import split into several chunks', async () => {
    const para = 'CLAUDE.md line '.repeat(40);
    const longCopy = `<system-reminder>\n${Array(12).fill(para).join('\n\n')}\n\nTAILSECRET\n</system-reminder>`;
    await importAsBefore([
      ['user', 'user', 'real question'],
      ['assistant', 'assistant', 'real answer'],
      ['api-request-blob', 'user', `${longCopy}\nsecond question`],
      ['assistant', 'assistant', 'second answer'],
    ]);
    fs.rmSync(file);
    expect(query('SELECT id FROM chunks WHERE instr(content, ?) > 0', 'TAILSECRET')).toHaveLength(
      1
    );

    const result = await recover();

    expect(result.details).toEqual(['blobfix- (trimmed 1 turn)']);
    expect(contents()).not.toContain('CLAUDE.md line');
    expect(contents()).not.toContain('TAILSECRET');
    expect(contents()).toContain('[User]\nsecond question\n\n[Assistant]\nsecond answer');
    expect(contents()).toContain('real answer');
    expect(jsonlText()).not.toContain('TAILSECRET');
    expect(await folded()).toContain('second answer');
  });

  it('removes the copy from the JSONL store without bringing back turns the DB no longer holds', async () => {
    await saveAsBefore(polluted);
    withStore((store) => store.deleteChunksBefore('9999-01-01'));

    const result = await recover();

    expect(result.details).toEqual(['blobfix- (trimmed 1 turn)']);
    expect(contents()).toBe('');
    expect(jsonlText()).not.toContain('requestcopy');
    expect(await folded()).toContain('retry answer');
    // 次の回は直すものが無い
    expect((await recover()).repaired).toBe(0);
  });

  it('keeps out of the DB a turn deleted there only, while trimming the copy turn', async () => {
    await saveTwoTurnsAsBefore([
      ['user', 'user', 'old question OLDSECRET'],
      ['assistant', 'assistant', 'old answer'],
    ]);
    const [old] = query<{ id: number }>(
      "SELECT id FROM chunks WHERE instr(content, 'OLDSECRET') > 0"
    );
    withStore((store) => store.deleteChunk(old.id));

    await recover();

    expect(contents()).not.toContain('OLDSECRET');
    expect(contents()).not.toContain('requestcopy');
    expect(contents()).toContain('retry answer');
  });

  it('keeps a chunk deleted by hand deleted', async () => {
    await saveTwoTurnsAsBefore([
      ['user', 'user', 'first question'],
      ['assistant', 'assistant', 'first answer HANDDELETED'],
    ]);
    const [hand] = query<{ id: number }>(
      "SELECT id FROM chunks WHERE instr(content, 'HANDDELETED') > 0"
    );
    withStore((store) =>
      deleteChunkEverywhere(store, loadConfig(configPath), store.getChunk(hand.id)!)
    );

    await recover();

    expect(contents()).not.toContain('HANDDELETED');
    expect(await folded()).not.toContain('HANDDELETED');
    expect(contents()).toContain('retry answer');
  });

  it('does not bring back a copy turn deleted by hand when the transcript grows afterwards', async () => {
    const lines: Line[] = [
      ['user', 'user', 'q1'],
      ['assistant', 'assistant', 'a1'],
      ['user', 'user', 'q2'],
      ['api-request-blob', 'user', `${COPY}\nq2`],
      ['assistant', 'assistant', 'a2 HANDDELETED'],
    ];
    await importAsBefore(lines);
    const [hand] = query<{ id: number }>(
      "SELECT id FROM chunks WHERE instr(content, 'HANDDELETED') > 0"
    );
    withStore((store) =>
      deleteChunkEverywhere(store, loadConfig(configPath), store.getChunk(hand.id)!)
    );
    write([...lines, ['user', 'user', 'q3'], ['assistant', 'assistant', 'a3']]);

    await recover();

    expect(contents()).not.toContain('HANDDELETED');
  });

  it('removes from the DB a turn it refuses, since the JSONL store keeps the text', async () => {
    await saveAsBefore(polluted);
    const db = getDatabase(dbPath);
    try {
      // DB だけが 1 つ先の revision を持つ状態。書き直した revision と同じ番号で中身が違う
      db.prepare('UPDATE chunks SET revision = revision + 1').run();
    } finally {
      db.close();
    }

    const result = await recover();

    expect(result.errors).toBe(0);
    expect(contents()).not.toContain('requestcopy');
    expect(contents()).not.toContain('retry answer');
    expect(await folded()).toContain('retry answer');
    expect(fs.existsSync(stateFile())).toBe(true);
  });

  it('leaves a session that only talks about system-reminder tags', async () => {
    await saveAsBefore([
      ['user', 'user', 'what does <system-reminder> mean'],
      ['assistant', 'assistant', 'a tag'],
    ]);

    expect((await recover()).repaired).toBe(0);
    expect(contents()).toContain('<system-reminder> mean');
  });

  it('does not read the JSONL store again while it holds nothing new', async () => {
    await saveAsBefore(polluted);
    await recover();
    // 正本を通さずに DB へ写しを入れる。全件を読み直せば見つかる
    withStore((store) =>
      store.insertChunks([
        {
          sessionId: 'db-only',
          projectPath: cwd,
          chunkIndex: 0,
          content: `[User]\n${COPY}`,
          role: 'human',
          metadata: { filePaths: [], toolNames: [], errorMessages: [] },
          tokenCount: 1,
          createdAt: new Date().toISOString(),
        },
      ])
    );

    expect((await recover()).repaired).toBe(0);
  });

  it('finds copies added to the JSONL store after a run that left nothing to do', async () => {
    await saveAsBefore(polluted);
    await recover();
    write(
      [
        ['user', 'user', 'plain'],
        ['assistant', 'assistant', 'plain answer'],
      ],
      false,
      'other-1'
    );
    await stop('other-1');
    expect((await recover()).repaired).toBe(0);

    await saveAsBefore(polluted, 'other-2');

    expect((await recover()).details).toEqual(['other-2 (trimmed 1 turn)']);
    expect(jsonlText()).not.toContain('requestcopy');
  });

  it('finds copies in a JSONL file replaced after a run that left nothing to do', async () => {
    await recover();
    await saveAsBefore(polluted);

    expect((await recover()).repaired).toBe(1);
  });

  it.each([
    ['is broken', '{oops'],
    ['holds null', 'null'],
    ['holds a list', '[]'],
    ['has the form of an earlier build', '{"retry":[],"compact":[]}'],
    ['holds an empty entry', '{"files":[null]}'],
    ['holds a file entry of the wrong shape', '{"files":[{"file":1}]}'],
  ])('reads the whole JSONL store when the state file %s', async (_n, text) => {
    await saveAsBefore(polluted);
    fs.writeFileSync(stateFile(), text);

    expect((await recover()).repaired).toBe(1);
  });

  it('reports a failure and reads the whole store again on the next run', async () => {
    await saveAsBefore(polluted);
    for (const f of listJsonlFiles(jsonlDir)) fs.chmodSync(f, 0o000);

    const result = await recover();

    for (const f of listJsonlFiles(jsonlDir)) fs.chmodSync(f, 0o600);
    expect(result.details).toContainEqual(expect.stringMatching(/^request copies: error - /));
    expect(result.errors).toBe(1);
    expect(fs.existsSync(stateFile())).toBe(false);
    expect((await recover()).repaired).toBe(1);
  });
});

describe('repairRequestCopies with a compaction that does not finish', () => {
  let tmp: string;
  let close: () => void;
  let input: Parameters<typeof repairRequestCopies>[0];
  const stateFile = () => path.join(tmp, 'recover-request-copies.json');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-copies-compact-'));
    const d = getDefaultConfig();
    const config = {
      ...d,
      database: { path: path.join(tmp, 'memory.db') },
      storage: { ...d.storage, jsonlDir: path.join(tmp, 'jsonl') },
    };
    fs.mkdirSync(config.storage.jsonlDir, { recursive: true });
    // 写しの目印を本文の途中に含む記録は、直す対象ではないが圧縮の対象になる
    const record = {
      v: 1,
      type: 'chunk',
      id: 'c1',
      sessionId: 's1',
      projectPath: '/p',
      chunkIndex: 0,
      content: 'see [User]\n<system-reminder> here',
      role: 'human',
      metadata: null,
      tokenCount: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(config.storage.jsonlDir, '2026-10-host.jsonl'),
      JSON.stringify(record) + '\n',
      { mode: 0o600 }
    );
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    close = () => db.close();
    input = { config, store: new Store(db), compact: async () => 'compacted' };
  });
  afterEach(() => {
    close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('saves nothing when the swap was skipped, so the next run tries again', async () => {
    input.compact = async () => 'retry';

    expect(await repairRequestCopies(input)).toEqual({ repaired: 0, errors: 0, details: [] });
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('reports a compaction error and saves nothing', async () => {
    input.compact = async () => {
      throw new Error('broken store');
    };

    expect(await repairRequestCopies(input)).toEqual({
      repaired: 0,
      errors: 1,
      details: ['JSONL compaction: error - Error: broken store'],
    });
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('saves the files once the compaction finished', async () => {
    input.compact = async () => 'unchanged';

    await repairRequestCopies(input);

    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).files).toHaveLength(1);
  });
});
