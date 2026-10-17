import { createReadStream } from 'node:fs';

/**
 * 行を \n だけで区切る。行末の \r は残す(JSON.parse は空白として読み飛ばし、バイト位置の計算も \r を含めて合う)。
 * readline は U+2028/U+2029 でも区切り、JSON 文字列中の生の U+2028 で行が割れるため使わない。
 * 改行の探索は新しい chunk だけに行い、改行の無い長い行でも線形で済ませる。呼び出し側が途中で抜けるとストリームも閉じる。
 */
export async function* readLines(filePath: string): AsyncGenerator<string> {
  const pending: string[] = [];
  for await (const chunk of createReadStream(filePath, { encoding: 'utf-8' })) {
    let from = 0;
    for (let at = chunk.indexOf('\n'); at !== -1; at = chunk.indexOf('\n', from)) {
      pending.push(chunk.slice(from, at));
      from = at + 1;
      const line = pending.join('');
      pending.length = 0;
      yield line;
    }
    pending.push(chunk.slice(from));
  }
  yield pending.join('');
}
