import { describe, it, expect } from 'vitest';
import { float32ToHex, hexToFloat32 } from '@/jsonl/codec';

describe('jsonl/codec', () => {
  it('roundtrips Float32Array via hex', () => {
    const original = new Float32Array([0, 1, -1, 3.14, 1e-10, 1e10]);
    const hex = float32ToHex(original);
    const back = hexToFloat32(hex);
    expect(back.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(back[i]).toBeCloseTo(original[i]);
    }
  });

  it('handles empty array', () => {
    const original = new Float32Array(0);
    const hex = float32ToHex(original);
    expect(hex).toBe('');
    expect(hexToFloat32(hex).length).toBe(0);
  });

  it('encodes 256-dim vectors compactly (kizami default)', () => {
    const original = new Float32Array(256);
    for (let i = 0; i < 256; i++) original[i] = Math.sin(i);
    const hex = float32ToHex(original);
    // 256 floats * 4 bytes * 2 hex chars = 2048 chars
    expect(hex.length).toBe(2048);
    const back = hexToFloat32(hex);
    expect(back.length).toBe(256);
    expect(back[10]).toBeCloseTo(original[10]);
  });
});
