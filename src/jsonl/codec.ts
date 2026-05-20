/**
 * Float32Array <-> hex 文字列の変換。
 * - 1次元あたり 4byte → 8 hex chars なので 256dim でも 2048 chars と現実的
 * - SQLite BLOB との往復より、可読性とテキストdiff親和性を優先
 */
export function float32ToHex(vec: Float32Array): string {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  return buf.toString('hex');
}

export function hexToFloat32(hex: string): Float32Array {
  const buf = Buffer.from(hex, 'hex');
  // Buffer は SharedArrayBuffer を返しうるので、ArrayBuffer をコピーで取得
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
