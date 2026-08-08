import type { StoredExecutionObservation, VerifiedErrorResolution } from './types';

function groupKey(observation: StoredExecutionObservation): string {
  return JSON.stringify([
    observation.runtime,
    observation.projectPath,
    observation.sessionId,
    observation.command,
  ]);
}

export function resolveVerifiedErrors(
  observations: StoredExecutionObservation[]
): VerifiedErrorResolution[] {
  const ordered = [...observations].sort((a, b) => {
    if (a.historyEpoch !== b.historyEpoch) return a.historyEpoch - b.historyEpoch;
    const sourceOrder = a.sourceOrder.localeCompare(b.sourceOrder);
    if (sourceOrder !== 0) return sourceOrder;
    return a.executionIndex - b.executionIndex;
  });
  const pending = new Map<string, StoredExecutionObservation[]>();
  const resolutions: VerifiedErrorResolution[] = [];

  for (const observation of ordered) {
    const key = groupKey(observation);
    if (observation.status === 'failed') {
      const failures = pending.get(key) ?? [];
      failures.push(observation);
      pending.set(key, failures);
      continue;
    }
    if (observation.status !== 'succeeded') continue;
    const failures = pending.get(key);
    if (!failures?.length) continue;
    const first = failures[0];
    const last = failures[failures.length - 1];
    resolutions.push({
      runtime: observation.runtime,
      projectPath: observation.projectPath,
      sessionId: observation.sessionId,
      command: observation.command,
      firstFailureTurnKey: first.turnKey,
      firstFailureExecutionIndex: first.executionIndex,
      lastFailureTurnKey: last.turnKey,
      lastFailureExecutionIndex: last.executionIndex,
      failureCount: failures.length,
      failureOutputExcerpt: last.outputExcerpt,
      successTurnKey: observation.turnKey,
      successExecutionIndex: observation.executionIndex,
      successOutputExcerpt: observation.outputExcerpt,
      verifiedAt: observation.completedAt,
    });
    pending.delete(key);
  }

  return resolutions;
}
