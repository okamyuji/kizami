import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/hooks');

const PARTIAL_TAIL_FIXTURES = new Set([
  'claude/partial-final-line.jsonl',
  'kimi-0.18.0/partial-line.jsonl',
  'kimi-0.18.0/truncation.jsonl',
]);

const COMPLETION_BOUNDARY_FIXTURE = 'kimi-0.18.0/explicit-completion.jsonl';

interface FixtureFile {
  name: string;
  relativePath: string;
  absolutePath: string;
}

function listFixtures(subdir: string, extensions: string[]): FixtureFile[] {
  const dir = path.join(FIXTURES_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => extensions.some((ext) => f.endsWith(ext)))
    .map((f) => ({
      name: f,
      relativePath: path.join(subdir, f),
      absolutePath: path.join(dir, f),
    }));
}

function collectStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') out.push(value);
    return out;
  }
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, seen);
  } else {
    for (const v of Object.values(value)) collectStrings(v, out, seen);
  }
  return out;
}

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\/home\//i, label: 'home directory (/home/)' },
  { pattern: /\/Users\//i, label: 'home directory (/Users/)' },
  { pattern: /\bapi_key\b/i, label: 'credential key (api_key)' },
  { pattern: /\bapikey\b/i, label: 'credential key (apikey)' },
  { pattern: /\btoken\b/i, label: 'credential key (token)' },
  { pattern: /\bpassword\b/i, label: 'credential key (password)' },
  { pattern: /\bsecret\b/i, label: 'credential key (secret)' },
  { pattern: /Bearer /i, label: 'bearer token' },
  { pattern: /Authorization/i, label: 'authorization header' },
  { pattern: /sk-/i, label: 'API key prefix (sk-)' },
  { pattern: /sk_live/i, label: 'live API key prefix (sk_live)' },
];

function scanForSecrets(parsed: unknown, filePath: string): string[] {
  const strings = collectStrings(parsed);
  const findings: string[] = [];
  for (const s of strings) {
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(s)) {
        findings.push(`${filePath}: contains ${label}: ${JSON.stringify(s)}`);
      }
    }
  }
  return findings;
}

function parseJsonFile(fixture: FixtureFile): unknown {
  const content = fs.readFileSync(fixture.absolutePath, 'utf-8');
  return JSON.parse(content);
}

interface JsonlParseResult {
  rows: Array<{ line: string; parsed: unknown }>;
  partialTail: string | null;
}

function parseJsonlFile(fixture: FixtureFile): JsonlParseResult {
  const content = fs.readFileSync(fixture.absolutePath, 'utf-8');
  const lines = content.split('\n');
  const hasTrailingNewline = content.endsWith('\n');
  const rows: Array<{ line: string; parsed: unknown }> = [];
  let partialTail: string | null = null;
  const allowPartialTail = PARTIAL_TAIL_FIXTURES.has(fixture.relativePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;

    if (isLastLine && line === '' && hasTrailingNewline) break;

    if (isLastLine && line !== '' && !hasTrailingNewline) {
      if (allowPartialTail) {
        partialTail = line;
        break;
      }
      throw new Error(
        `${fixture.relativePath}: line ${i + 1} is incomplete (no trailing newline): ${line.slice(0, 80)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `${fixture.relativePath}: line ${i + 1} is not valid JSON: ${line.slice(0, 80)} (${String(err)})`,
        { cause: err }
      );
    }
    rows.push({ line, parsed });
  }

  return { rows, partialTail };
}

function assertRequiredJsonFields(parsed: unknown, relativePath: string): void {
  const record = parsed as Record<string, unknown>;
  expect(typeof record.session_id, `${relativePath} session_id`).toBe('string');
  expect(
    (record.session_id as string).length,
    `${relativePath} session_id non-empty`
  ).toBeGreaterThan(0);
  expect(typeof record.hook_event_name, `${relativePath} hook_event_name`).toBe('string');
  expect(typeof record.cwd, `${relativePath} cwd`).toBe('string');
}

function expectCompleteJsonl(fixture: FixtureFile): JsonlParseResult {
  const { rows, partialTail } = parseJsonlFile(fixture);
  const allowPartialTail = PARTIAL_TAIL_FIXTURES.has(fixture.relativePath);
  if (allowPartialTail) {
    expect(partialTail, `${fixture.relativePath} has a partial final line`).not.toBeNull();
  } else {
    expect(partialTail, `${fixture.relativePath} has no partial tail`).toBeNull();
  }
  expect(rows.length, `${fixture.relativePath} non-empty`).toBeGreaterThan(0);
  return { rows, partialTail };
}

function scanJsonFixtures(fixtures: FixtureFile[]): string[] {
  const findings: string[] = [];
  for (const fixture of fixtures) {
    findings.push(...scanForSecrets(parseJsonFile(fixture), fixture.relativePath));
  }
  return findings;
}

function scanJsonlFixtures(fixtures: FixtureFile[]): string[] {
  const findings: string[] = [];
  for (const fixture of fixtures) {
    const { rows } = parseJsonlFile(fixture);
    for (const { parsed } of rows) {
      findings.push(...scanForSecrets(parsed, fixture.relativePath));
    }
  }
  return findings;
}

function assertJsonlRecordFields(rows: Array<{ parsed: unknown }>, relativePath: string): void {
  for (const { parsed } of rows) {
    const record = parsed as Record<string, unknown>;
    expect(typeof record.type, `${relativePath} record type`).toBe('string');
  }
}

function assertJsonlHasSessionId(rows: Array<{ parsed: unknown }>, relativePath: string): void {
  for (const { parsed } of rows) {
    const record = parsed as Record<string, unknown>;
    expect(typeof record.sessionId, `${relativePath} record sessionId`).toBe('string');
  }
}

describe('runtime hook fixture contracts', () => {
  describe('Claude fixtures', () => {
    const jsonFixtures = listFixtures('claude', ['.json']);
    const jsonlFixtures = listFixtures('claude', ['.jsonl']);

    it('has JSON hook payloads with required fields', () => {
      expect(jsonFixtures.length).toBeGreaterThan(0);
      for (const fixture of jsonFixtures) {
        assertRequiredJsonFields(parseJsonFile(fixture), fixture.relativePath);
      }
    });

    it('has JSONL transcripts with complete lines and required record fields', () => {
      expect(jsonlFixtures.length).toBeGreaterThan(0);
      for (const fixture of jsonlFixtures) {
        const { rows } = expectCompleteJsonl(fixture);
        assertJsonlRecordFields(rows, fixture.relativePath);
        assertJsonlHasSessionId(rows, fixture.relativePath);
      }
    });

    it('contains no secrets in Claude fixtures', () => {
      const findings: string[] = [
        ...scanJsonFixtures(jsonFixtures),
        ...scanJsonlFixtures(jsonlFixtures),
      ];
      expect(findings).toEqual([]);
    });
  });

  describe('Codex 0.141.0 fixtures', () => {
    const jsonFixtures = listFixtures('codex-0.141.0', ['.json']);

    it('has JSON payloads with required fields', () => {
      expect(jsonFixtures.length).toBeGreaterThan(0);
      for (const fixture of jsonFixtures) {
        assertRequiredJsonFields(parseJsonFile(fixture), fixture.relativePath);
      }
    });

    it('contains no secrets in Codex fixtures', () => {
      expect(scanJsonFixtures(jsonFixtures)).toEqual([]);
    });
  });

  describe('Kimi 0.18.0 fixtures', () => {
    const jsonFixtures = listFixtures('kimi-0.18.0', ['.json']);
    const jsonlFixtures = listFixtures('kimi-0.18.0', ['.jsonl']);

    it('has JSON hook payloads with required fields', () => {
      expect(jsonFixtures.length).toBeGreaterThan(0);
      for (const fixture of jsonFixtures) {
        assertRequiredJsonFields(parseJsonFile(fixture), fixture.relativePath);
      }
    });

    it('has JSONL wire files with complete lines', () => {
      expect(jsonlFixtures.length).toBeGreaterThan(0);
      for (const fixture of jsonlFixtures) {
        const { rows } = expectCompleteJsonl(fixture);
        assertJsonlRecordFields(rows, fixture.relativePath);
      }
    });

    it('contains no secrets in Kimi fixtures', () => {
      const findings: string[] = [
        ...scanJsonFixtures(jsonFixtures),
        ...scanJsonlFixtures(jsonlFixtures),
      ];
      expect(findings).toEqual([]);
    });

    it('recognizes an explicit completion boundary in the dedicated Kimi fixture', () => {
      const fixture = jsonlFixtures.find((f) => f.relativePath === COMPLETION_BOUNDARY_FIXTURE);
      expect(fixture, `${COMPLETION_BOUNDARY_FIXTURE} fixture exists`).toBeDefined();
      const { rows } = parseJsonlFile(fixture!);
      const hasCompletion = rows.some(({ parsed }) => {
        const event = (parsed as Record<string, unknown>)?.event as
          | Record<string, unknown>
          | undefined;
        if (!event || typeof event.type !== 'string') return false;
        return event.type === 'step.complete' || event.type === 'turn.complete';
      });
      expect(
        hasCompletion,
        `${COMPLETION_BOUNDARY_FIXTURE} contains step.complete or turn.complete`
      ).toBe(true);
    });
  });
});
