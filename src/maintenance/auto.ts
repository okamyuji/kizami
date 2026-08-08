import type { Store } from '@/db/store';
import type { EngramConfig } from '@/config';

export interface MaintenanceResult {
  skipped: boolean;
  reason?: string;
  chunksDeleted: number;
  executionObservationsDeleted: number;
  orphanedSessionsDeleted: number;
  bytesFreed: number;
}

function shouldRunMaintenance(store: Store, intervalHours: number): boolean {
  const lastRun = store.getLastMaintenanceTime();
  if (!lastRun) return true;

  const lastRunTime = new Date(lastRun + 'Z').getTime();
  const now = Date.now();
  const elapsedHours = (now - lastRunTime) / (1000 * 60 * 60);
  return elapsedHours >= intervalHours;
}

export function runAutoMaintenance(store: Store, config: EngramConfig): MaintenanceResult {
  if (!config.maintenance.enabled) {
    return {
      skipped: true,
      reason: 'disabled',
      chunksDeleted: 0,
      executionObservationsDeleted: 0,
      orphanedSessionsDeleted: 0,
      bytesFreed: 0,
    };
  }

  if (!shouldRunMaintenance(store, config.maintenance.intervalHours)) {
    return {
      skipped: true,
      reason: 'interval',
      chunksDeleted: 0,
      executionObservationsDeleted: 0,
      orphanedSessionsDeleted: 0,
      bytesFreed: 0,
    };
  }

  const statsBefore = store.getStats();
  let totalChunksDeleted = 0;

  // 1. 古いチャンクを削除
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.maintenance.maxChunkAgeDays);
  const cutoffStr = cutoffDate
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');
  const ageDeleted = store.deleteChunksBefore(cutoffStr);
  let totalObservationsDeleted = store.deleteExecutionObservationsBefore(cutoffDate.toISOString());
  totalChunksDeleted += ageDeleted;

  // 2. DBサイズ上限を超えていたら古い順に追加削除
  const maxBytes = config.maintenance.maxDbSizeMB * 1024 * 1024;
  const statsAfterAge = store.getStats();
  if (statsAfterAge.dbSizeBytes > maxBytes) {
    const sizeDeleted = deleteBySizeLimit(store, maxBytes);
    totalChunksDeleted += sizeDeleted.chunks;
    totalObservationsDeleted += sizeDeleted.observations;
  }

  // 3. 孤立セッションを削除
  const orphaned = store.deleteOrphanedSessions();

  // 4. WALチェックポイント
  store.vacuum();

  const statsAfter = store.getStats();
  const bytesFreed = Math.max(0, statsBefore.dbSizeBytes - statsAfter.dbSizeBytes);

  store.logMaintenance('auto', totalChunksDeleted, bytesFreed);

  return {
    skipped: false,
    chunksDeleted: totalChunksDeleted,
    executionObservationsDeleted: totalObservationsDeleted,
    orphanedSessionsDeleted: orphaned,
    bytesFreed,
  };
}

export interface SizeLimitStore {
  vacuum(): void;
  getStats(): {
    dbSizeBytes: number;
    totalChunks: number;
    explicitExecutionObservations: number;
    unknownExecutionObservations: number;
  };
  deleteOldestChunks(count: number): number;
  deleteOldestExecutionObservations(count: number): number;
  deleteOrphanedSessions(): number;
}

export function deleteBySizeLimit(
  store: SizeLimitStore,
  maxBytes: number
): { chunks: number; observations: number } {
  const deleted = { chunks: 0, observations: 0 };
  for (let i = 0; i < 10; i++) {
    // VACUUMで解放ページを反映してからサイズを測定
    store.vacuum();
    const stats = store.getStats();
    if (stats.dbSizeBytes <= maxBytes) break;

    const totalExecutions =
      stats.explicitExecutionObservations + stats.unknownExecutionObservations;
    // chunk優先だと観測が大量に残るDBを上限内へ収められないため、多い方から削除する
    let batch: number;
    if (stats.totalChunks >= totalExecutions && stats.totalChunks > 0) {
      const batchSize = Math.max(1, Math.ceil(stats.totalChunks * 0.1));
      batch = store.deleteOldestChunks(batchSize);
      deleted.chunks += batch;
      store.deleteOrphanedSessions();
    } else if (totalExecutions > 0) {
      const batchSize = Math.max(1, Math.ceil(totalExecutions * 0.1));
      batch = store.deleteOldestExecutionObservations(batchSize);
      deleted.observations += batch;
    } else {
      break;
    }
    if (batch === 0) break;
  }
  return deleted;
}
