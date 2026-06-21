import * as path from 'node:path';
import type { HookRuntime, CheckpointCommitResult } from './types';
import type { AdapterExtraction, AdapterEnvironment } from './adapter';
import { commitCheckpointBatch, recoverPreparedCheckpoints } from './coordinator';
import type { CheckpointBatch } from './coordinator';
import { loadConfig, type EngramConfig } from '@/config';
import { JsonlTransactionWriter } from '@/jsonl/writer';
import { claudeAdapter } from './adapters/claude';
import { codexAdapter } from './adapters/codex';
import { kimiAdapter } from './adapters/kimi';

function getStateRoot(config: EngramConfig): string {
  return path.dirname(config.database.path);
}

function makeEnv(config: EngramConfig, txWriter: JsonlTransactionWriter): AdapterEnvironment {
  const stateRoot = getStateRoot(config);
  return {
    config,
    stateRoot,
    now: () => new Date(),
    getOrCreateTurnSequence(runtime, sessionId, pendingKey) {
      return txWriter.withExclusiveTransaction((w) =>
        w.getOrCreateTurnSequence(runtime, sessionId, pendingKey)
      );
    },
    allocateTurnSequenceRange(runtime, sessionId, count) {
      return txWriter.withExclusiveTransaction((w) =>
        w.allocateTurnSequenceRange(runtime, sessionId, count)
      );
    },
    reserveObservationSequence(runtime, sessionId) {
      return txWriter.withExclusiveTransaction((w) =>
        w.reserveObservationSequence(runtime, sessionId)
      );
    },
    log(message) {
      process.stderr.write(`kizami: ${message}\n`);
    },
  };
}

export async function capturePendingPrompt(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<void> {
  const config = loadConfig(configPath);
  const txWriter = new JsonlTransactionWriter(config.storage.jsonlDir);
  try {
    const env = makeEnv(config, txWriter);
    if (runtime === 'claude') {
      const payload = claudeAdapter.parsePrompt(raw);
      if (payload) await claudeAdapter.capturePrompt(payload, env);
    } else if (runtime === 'codex') {
      const payload = codexAdapter.parsePrompt(raw);
      if (payload) await codexAdapter.capturePrompt(payload, env);
    } else if (runtime === 'kimi') {
      const payload = kimiAdapter.parsePrompt(raw);
      if (payload) await kimiAdapter.capturePrompt(payload, env);
    }
  } finally {
    txWriter.close();
  }
}

async function dispatchExtraction(
  runtime: HookRuntime,
  raw: string,
  config: EngramConfig,
  mode: 'stop' | 'session_end'
): Promise<CheckpointCommitResult[]> {
  const txWriter = new JsonlTransactionWriter(config.storage.jsonlDir);
  try {
    const env = makeEnv(config, txWriter);
    let extraction: AdapterExtraction | null = null;
    let sessionId = '';

    if (runtime === 'claude') {
      const payload =
        mode === 'stop' ? claudeAdapter.parseStop(raw) : claudeAdapter.parseSessionEnd(raw);
      if (!payload) return [];
      sessionId = payload.session_id;
      extraction =
        mode === 'stop'
          ? await claudeAdapter.extractStop(payload, env)
          : await claudeAdapter.extractSessionEnd(payload, env);
    } else if (runtime === 'codex') {
      const payload =
        mode === 'stop' ? codexAdapter.parseStop(raw) : codexAdapter.parseSessionEnd(raw);
      if (!payload) return [];
      sessionId = payload.session_id;
      extraction =
        mode === 'stop'
          ? await codexAdapter.extractStop(payload, env)
          : await codexAdapter.extractSessionEnd(payload, env);
    } else if (runtime === 'kimi') {
      if (mode === 'stop') {
        const payload = kimiAdapter.parseStop(raw);
        if (!payload) return [];
        sessionId = payload.session_id;
        extraction = await kimiAdapter.extractStop(payload, env);
      } else {
        const payload = kimiAdapter.parseSessionEnd(raw);
        if (!payload) return [];
        sessionId = payload.session_id;
        extraction = await kimiAdapter.extractSessionEnd(payload, env);
      }
    }

    if (!extraction || extraction.status === 'deferred') {
      if (extraction?.diagnostic) {
        process.stderr.write(`kizami: checkpoint deferred: ${extraction.diagnostic}\n`);
      }
      return [];
    }

    if (extraction.candidates.length === 0) return [];

    const batch: CheckpointBatch = {
      runtime,
      sessionId,
      candidates: extraction.candidates,
      finalization: extraction.finalization,
    };

    return commitCheckpointBatch(batch, config);
  } finally {
    txWriter.close();
  }
}

export async function checkpointStop(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<CheckpointCommitResult[]> {
  const config = loadConfig(configPath);
  return dispatchExtraction(runtime, raw, config, 'stop');
}

export async function checkpointSessionEnd(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<CheckpointCommitResult[]> {
  const config = loadConfig(configPath);
  return dispatchExtraction(runtime, raw, config, 'session_end');
}

export { commitCheckpointBatch, recoverPreparedCheckpoints };
