import * as fs from 'node:fs';
import * as path from 'node:path';

export const RECALL_SKILL_NAME = 'kizami-recall';
const MARKER = '<!-- kizami-managed -->';

export function renderRecallSkill(cmd: string): string {
  return `---
name: ${RECALL_SKILL_NAME}
description: Recall past Claude Code sessions saved by kizami. Use when the user asks to remember, look up, or continue something from an earlier session, in any language — 「あれ思い出して」「前に〜したやつ」「以前のセッションで」「前回の続き」「〜ってどうしたっけ」, "remember when", "previous session", "what did we decide last time". Searches this project first, then other projects.
allowed-tools: Bash(${cmd} search:*), Bash(${cmd} show:*)
---
${MARKER}

# kizami-recall

If this skill was invoked with arguments, use them as the search keywords: $ARGUMENTS

1. Pick 1-3 distinctive keywords from the request: names, error text, file names, or technical terms. Run \`${cmd} search "<keywords>"\`. The command searches this project, then other projects, then old archived transcripts on its own.
2. Each hit starts with \`[YYYY-MM-DD <id> ...]\`; \`from=<project>\` means another project. Pick the session that fits. If nothing fits, retry with other keywords (synonyms, the other language) up to 3 times, then tell the user it was not found.
3. Read the session: \`${cmd} show <id>\`. Long sessions show only the latest turns. Add \`--max-chars 0\` only when the part you need is missing.
4. Answer from what the log says. Name the session id and date. Do not add details the log does not contain.
5. If the user wants to continue that session itself, tell them to run \`${cmd} resume <id>\` in a terminal. A session cannot be resumed from inside another session.
`;
}

function isManaged(file: string): boolean {
  return fs.existsSync(file) && fs.readFileSync(file).includes(MARKER);
}

export function installRecallSkill(skillsDir: string, kizamiCommand: string): string {
  const file = path.join(skillsDir, RECALL_SKILL_NAME, 'SKILL.md');
  if (fs.existsSync(file) && !isManaged(file)) {
    throw new Error(`${file} exists and is not managed by kizami. Remove or rename it first.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderRecallSkill(kizamiCommand));
  return file;
}

export function removeRecallSkill(skillsDir: string): boolean {
  const dir = path.join(skillsDir, RECALL_SKILL_NAME);
  const file = path.join(dir, 'SKILL.md');
  if (!isManaged(file)) return false;
  fs.rmSync(file);
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  return true;
}
