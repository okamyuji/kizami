import { createHash } from 'node:crypto';
import type { HookRuntime, ObservationBoundaryV2, TurnPartV2 } from './types';
import type { ExecutionObservationV1 } from '@/execution/types';

export function hashFields(...fields: Array<string | number>): string {
  const encoded = fields
    .map((field) => {
      const bytes = Buffer.from(String(field), 'utf-8');
      return `${bytes.length}:${bytes.toString('utf-8')}`;
    })
    .join('');
  return createHash('sha256').update(encoded, 'utf-8').digest('hex');
}

export function createTurnKey(
  runtime: HookRuntime,
  sessionId: string,
  sourceIdentity: string
): string {
  return hashFields(runtime, sessionId, sourceIdentity);
}

export function createPartExternalId(
  runtime: HookRuntime,
  sessionId: string,
  turnKey: string,
  partIndex: number
): string {
  return `${runtime}-${hashFields(sessionId, turnKey, partIndex)}`;
}

export function createContentHash(
  prompt: string,
  assistant: string,
  toolResults: string[],
  parts: TurnPartV2[],
  executions: ExecutionObservationV1[] = [],
  runtime: HookRuntime | '' = '',
  projectPath = ''
): string {
  const partFields: Array<string | number> = [];
  for (const part of parts) {
    partFields.push(part.content, part.role, part.tokenCount);
  }
  const executionFields: Array<string | number> = [];
  for (const execution of executions) {
    executionFields.push(
      execution.executionIndex,
      execution.toolName,
      execution.command,
      execution.status,
      execution.exitCode ?? 'null',
      execution.outputExcerpt
    );
  }
  return hashFields(
    runtime,
    projectPath,
    prompt,
    assistant,
    toolResults.length,
    ...toolResults,
    parts.length,
    ...partFields,
    executions.length,
    ...executionFields
  );
}

export function compareObservationBoundary(
  left: ObservationBoundaryV2,
  right: ObservationBoundaryV2
): 'older' | 'equal' | 'newer' | 'incomparable' {
  if (left.kind === 'source_offset' && right.kind === 'source_offset') {
    if (left.generation !== right.generation) {
      return left.generation < right.generation ? 'older' : 'newer';
    }
    if (left.offset !== right.offset) {
      return left.offset < right.offset ? 'older' : 'newer';
    }
    return 'equal';
  }

  if (left.kind === 'delivery_sequence' && right.kind === 'delivery_sequence') {
    if (left.sequence !== right.sequence) {
      return left.sequence < right.sequence ? 'older' : 'newer';
    }
    return 'equal';
  }

  return 'incomparable';
}
