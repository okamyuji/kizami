import {
  buildTurns,
  turnToText,
  splitTurnText,
  estimateTokens,
  detectRole,
} from '@/parser/chunker';
import { extractMetadata } from '@/parser/metadata';
import type { AssistantMessage, TranscriptMessage } from '@/parser/transcript';
import { createPartExternalId } from './identity';
import type { TurnCheckpointCandidate, TurnPartV2 } from './types';

function synthesizeMessages(prompt: string, assistant: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  if (prompt) {
    messages.push({ kind: 'user', sessionId: '', text: prompt });
  }
  if (assistant) {
    messages.push({
      kind: 'assistant',
      sessionId: '',
      content: [{ type: 'text', text: assistant }],
      toolResults: [],
    } as AssistantMessage);
  }
  return messages;
}

export function buildCheckpointParts(candidate: TurnCheckpointCandidate): TurnPartV2[] {
  const messages =
    candidate.messages.length > 0
      ? candidate.messages
      : synthesizeMessages(candidate.prompt, candidate.assistant);

  const turns = buildTurns(messages);
  const parts: TurnPartV2[] = [];
  let partIndex = 0;

  for (const turn of turns) {
    const text = turnToText(turn);

    for (const content of splitTurnText(text, 512)) {
      const metadata = extractMetadata(content);
      const role = detectRole(content);
      const externalId = createPartExternalId(
        candidate.runtime,
        candidate.sessionId,
        candidate.turnKey,
        partIndex
      );

      parts.push({
        partIndex,
        externalId,
        content,
        role,
        metadata,
        tokenCount: estimateTokens(content),
      });
      partIndex++;
    }
  }

  return parts;
}
