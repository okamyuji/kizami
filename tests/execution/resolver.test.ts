import { describe, expect, it } from 'vitest';
import { resolveVerifiedErrors } from '@/execution/resolver';
import type { StoredExecutionObservation } from '@/execution/types';

function observation(
  status: StoredExecutionObservation['status'],
  sourceOrder: string,
  overrides: Partial<StoredExecutionObservation> = {}
): StoredExecutionObservation {
  return {
    runtime: 'claude',
    projectPath: '/project',
    sessionId: 'session',
    turnKey: `turn-${sourceOrder}`,
    sourceOrder,
    historyEpoch: 0,
    revision: 1,
    executionIndex: 0,
    toolName: 'Bash',
    command: 'pnpm test',
    status,
    outputExcerpt: status,
    completedAt: `2026-08-08T00:00:0${sourceOrder}Z`,
    ...overrides,
  };
}

describe('resolveVerifiedErrors', () => {
  it('resolves consecutive failures with a later success', () => {
    const result = resolveVerifiedErrors([
      observation('failed', '1'),
      observation('failed', '2'),
      observation('succeeded', '3'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ failureCount: 2, successTurnKey: 'turn-3' });
  });

  it('ignores success-only and unknown observations', () => {
    expect(
      resolveVerifiedErrors([observation('unknown', '1'), observation('succeeded', '2')])
    ).toEqual([]);
  });

  it.each([
    { projectPath: '/other' },
    { sessionId: 'other' },
    { runtime: 'codex' as const },
    { command: 'other' },
  ])('does not cross the resolver boundary %o', (overrides) => {
    expect(
      resolveVerifiedErrors([observation('failed', '1'), observation('succeeded', '2', overrides)])
    ).toEqual([]);
  });

  it('does not let an earlier success resolve a later failure', () => {
    expect(
      resolveVerifiedErrors([observation('succeeded', '1'), observation('failed', '2')])
    ).toEqual([]);
  });

  it('sorts by epoch, source order, and execution index before resolving', () => {
    const success = observation('succeeded', '2', { executionIndex: 1 });
    const failure = observation('failed', '2', { executionIndex: 0, turnKey: 'turn-failure' });
    expect(resolveVerifiedErrors([success, failure])).toHaveLength(1);

    const nextEpochSuccess = observation('succeeded', '1', { historyEpoch: 1 });
    const oldEpochFailure = observation('failed', '9', { historyEpoch: 0 });
    expect(resolveVerifiedErrors([nextEpochSuccess, oldEpochFailure])).toHaveLength(1);

    expect(
      resolveVerifiedErrors([observation('succeeded', '3'), observation('failed', '2')])
    ).toHaveLength(1);
  });

  it('does not treat unknown as a success when failures are pending', () => {
    expect(
      resolveVerifiedErrors([observation('failed', '1'), observation('unknown', '2')])
    ).toEqual([]);
  });
});
