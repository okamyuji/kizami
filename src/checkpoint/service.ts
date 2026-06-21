import type { HookRuntime, CheckpointCommitResult } from './types';
import { commitCheckpointBatch, recoverPreparedCheckpoints } from './coordinator';

export async function capturePendingPrompt(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<void> {
  void runtime;
  void raw;
  void configPath;
  // ponytail: adapter-specific dispatch wired in Task 10-12
}

export async function checkpointStop(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<CheckpointCommitResult[]> {
  void runtime;
  void raw;
  void configPath;
  // ponytail: adapter-specific dispatch wired in Task 10-12
  return [];
}

export async function checkpointSessionEnd(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<CheckpointCommitResult[]> {
  void runtime;
  void raw;
  void configPath;
  // ponytail: adapter-specific dispatch wired in Task 10-12
  return [];
}

export { commitCheckpointBatch, recoverPreparedCheckpoints };
