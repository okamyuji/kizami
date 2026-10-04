import { parseTranscript } from '@/parser/transcript';
import { buildTurns, turnToText } from '@/parser/chunker';
import type { ResolvedSession } from '@/archive/resolve';
import { redactTurnText } from '@/archive/deletions';

const TURN_SEPARATOR = '\n\n---\n\n';

function pickTail(texts: string[], maxChars: number): string[] {
  if (maxChars <= 0) return texts;
  const kept: string[] = [];
  let used = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (used + texts[i].length > maxChars) break;
    kept.unshift(texts[i]);
    used += texts[i].length + TURN_SEPARATOR.length;
  }
  if (kept.length === 0 && texts.length > 0) {
    kept.push(texts[texts.length - 1].slice(-maxChars));
  }
  return kept;
}

export async function renderSession(
  session: ResolvedSession,
  maxChars: number,
  deletedChunkDigests: Set<string> = new Set()
): Promise<string> {
  const messages = await parseTranscript(session.path);
  const texts = buildTurns(messages).map((turn) =>
    redactTurnText(turnToText(turn), deletedChunkDigests)
  );
  const stamps = messages.map((m) => m.timestamp).filter((t): t is string => !!t);
  const kept = pickTail(texts, maxChars);
  const omittedEarlier = texts.length - kept.length;

  const header = [
    `Session: ${session.sessionId}`,
    `Cwd: ${session.cwd ?? '(unknown)'}`,
    `Branch: ${session.gitBranch ?? '(unknown)'}`,
    `Period: ${stamps[0] ?? '?'} .. ${stamps[stamps.length - 1] ?? '?'}`,
    `Turns: ${texts.length}`,
  ];
  if (omittedEarlier > 0) {
    header.push(`Omitted ${omittedEarlier} earlier turn(s). Pass --max-chars 0 to show all.`);
  }
  return `${header.join('\n')}\n\n${kept.join(TURN_SEPARATOR)}\n`;
}
