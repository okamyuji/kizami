import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RECALL_SKILL_NAME,
  renderRecallSkill,
  installRecallSkill,
  removeRecallSkill,
} from '../../src/hooks/skill';

describe('recall skill', () => {
  let tmp: string;
  beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-skill-'))));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('renders frontmatter with name, bilingual triggers and allowed-tools for the given command', () => {
    const md = renderRecallSkill("'/opt/node' '/x/cli.js'");
    expect(RECALL_SKILL_NAME).toBe('kizami-recall');
    expect(md.startsWith('---\nname: kizami-recall\ndescription: ')).toBe(true);
    expect(md).toContain('あれ思い出して');
    expect(md).toContain('previous session');
    expect(md).toContain(
      "\nallowed-tools: Bash('/opt/node' '/x/cli.js' search:*), Bash('/opt/node' '/x/cli.js' show:*)\n---\n<!-- kizami-managed -->\n"
    );
    expect(md).toContain("`'/opt/node' '/x/cli.js' search \"<keywords>\"`");
    expect(md).toContain("`'/opt/node' '/x/cli.js' show <id>`");
    expect(md).toContain("`'/opt/node' '/x/cli.js' resume <id>`");
    expect(md).toContain('$ARGUMENTS');
  });

  it('installs into <skillsDir>/kizami-recall/SKILL.md and removes only its own file', () => {
    const file = installRecallSkill(tmp, 'kizami');
    expect(file).toBe(path.join(tmp, 'kizami-recall', 'SKILL.md'));
    expect(fs.readFileSync(file, 'utf-8')).toBe(renderRecallSkill('kizami'));
    expect(removeRecallSkill(tmp)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'kizami-recall'))).toBe(false);
    expect(removeRecallSkill(tmp)).toBe(false);
  });

  it('keeps other files the user put in the skill directory on uninstall', () => {
    installRecallSkill(tmp, 'kizami');
    const extra = path.join(tmp, 'kizami-recall', 'notes.md');
    fs.writeFileSync(extra, 'mine');

    expect(removeRecallSkill(tmp)).toBe(true);

    expect(fs.existsSync(path.join(tmp, 'kizami-recall', 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(extra, 'utf-8')).toBe('mine');
  });

  it('overwrites its own earlier file when the command changes', () => {
    installRecallSkill(tmp, 'kizami');
    const file = installRecallSkill(tmp, '/new/kizami');
    expect(fs.readFileSync(file, 'utf-8')).toBe(renderRecallSkill('/new/kizami'));
  });

  it('refuses to overwrite or delete a user-authored skill of the same name', () => {
    const own = path.join(tmp, 'kizami-recall', 'SKILL.md');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'mine');
    expect(() => installRecallSkill(tmp, 'kizami')).toThrow(
      `${own} exists and is not managed by kizami. Remove or rename it first.`
    );
    expect(removeRecallSkill(tmp)).toBe(false);
    expect(fs.readFileSync(own, 'utf-8')).toBe('mine');
  });

  it('creates missing parent directories', () => {
    const nested = path.join(tmp, 'a', 'b');
    expect(fs.existsSync(installRecallSkill(nested, 'kizami'))).toBe(true);
  });
});
