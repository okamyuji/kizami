import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURE = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');

/** 保持期間内に収まるよう、fixture の日付を今日に差し替えて書き出す。 */
export function copyRecentTranscript(dest: string): void {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(dest, fs.readFileSync(FIXTURE, 'utf-8').replaceAll('2024-06-15', today));
}
