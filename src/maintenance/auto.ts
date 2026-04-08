import type { Store } from '@/db/store';
import type { EngramConfig } from '@/config';

export interface MaintenanceResult {
  skipped: boolean;
  reason?: string;
  chunksDeleted: number;
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
      orphanedSessionsDeleted: 0,
      bytesFreed: 0,
    };
  }

  if (!shouldRunMaintenance(store, config.maintenance.intervalHours)) {
    return {
      skipped: true,
      reason: 'interval',
      chunksDeleted: 0,
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
  totalChunksDeleted += ageDeleted;

  // 2. DBサイズ上限を超えていたら古い順に追加削除
  const maxBytes = config.maintenance.maxDbSizeMB * 1024 * 1024;
  const statsAfterAge = store.getStats();
  if (statsAfterAge.dbSizeBytes > maxBytes && statsAfterAge.totalChunks > 0) {
    const sizeDeleted = deleteBySizeLimit(store, maxBytes);
    totalChunksDeleted += sizeDeleted;
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
    orphanedSessionsDeleted: orphaned,
    bytesFreed,
  };
}

function deleteBySizeLimit(store: Store, maxBytes: number): number {
  let deleted = 0;
  for (let i = 0; i < 10; i++) {
    // VACUUMで解放ページを反映してからサイズを測定
    store.vacuum();
    const stats = store.getStats();
    if (stats.dbSizeBytes <= maxBytes || stats.totalChunks === 0) break;

    const batchSize = Math.max(1, Math.ceil(stats.totalChunks * 0.1));
    const batch = store.deleteOldestChunks(batchSize);
    deleted += batch;
    if (batch === 0) break;
  }
  return deleted;
}
