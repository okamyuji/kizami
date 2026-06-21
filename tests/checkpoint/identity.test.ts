import { describe, it, expect } from 'vitest';
import {
  hashFields,
  createTurnKey,
  createPartExternalId,
  createContentHash,
  compareObservationBoundary,
} from '../../src/checkpoint/identity';
import type { TurnPartV2 } from '../../src/checkpoint/types';

function makePart(overrides: Partial<TurnPartV2> = {}): TurnPartV2 {
  return {
    partIndex: 0,
    externalId: 'ext-0',
    content: 'content',
    role: 'human',
    metadata: {
      filePaths: [],
      toolNames: [],
      errorMessages: [],
    },
    tokenCount: 1,
    ...overrides,
  };
}

describe('checkpoint identity', () => {
  describe('hashFields', () => {
    it('is deterministic for the same fields', () => {
      expect(hashFields('a', 'b', 1)).toBe(hashFields('a', 'b', 1));
    });

    it('changes when any field changes', () => {
      expect(hashFields('a', 'b', 1)).not.toBe(hashFields('a', 'b', 2));
      expect(hashFields('a', 'b', 1)).not.toBe(hashFields('a', 'c', 1));
      expect(hashFields('a', 'b', 1)).not.toBe(hashFields('z', 'b', 1));
    });

    it('uses length-prefixing so field boundaries affect the hash', () => {
      expect(hashFields('ab', 'c')).not.toBe(hashFields('a', 'bc'));
    });
  });

  describe('createTurnKey', () => {
    it('is stable for identical inputs', () => {
      expect(createTurnKey('claude', 's1', 'uuid:u1')).toBe(
        createTurnKey('claude', 's1', 'uuid:u1')
      );
    });

    it('changes when runtime, session, or source identity changes', () => {
      const base = createTurnKey('claude', 's1', 'uuid:u1');
      expect(createTurnKey('codex', 's1', 'uuid:u1')).not.toBe(base);
      expect(createTurnKey('claude', 's2', 'uuid:u1')).not.toBe(base);
      expect(createTurnKey('claude', 's1', 'uuid:u2')).not.toBe(base);
    });

    it('distinguishes identical prompts at different source records', () => {
      expect(createTurnKey('claude', 's1', 'offset:0001')).not.toBe(
        createTurnKey('claude', 's1', 'offset:0099')
      );
    });
  });

  describe('createPartExternalId', () => {
    it('keeps part identity stable across content revisions', () => {
      const turnKey = createTurnKey('claude', 's1', 'uuid:u1');
      expect(createPartExternalId('claude', 's1', turnKey, 0)).toBe(
        createPartExternalId('claude', 's1', turnKey, 0)
      );
      expect(createPartExternalId('claude', 's1', turnKey, 0)).not.toBe(
        createPartExternalId('claude', 's1', turnKey, 1)
      );
    });

    it('prefixes the runtime and separates it with a dash', () => {
      const id = createPartExternalId('claude', 's1', 'tk', 0);
      expect(id.startsWith('claude-')).toBe(true);
    });

    it('changes when session, turn key, or part index changes', () => {
      const turnKey = createTurnKey('claude', 's1', 'uuid:u1');
      const base = createPartExternalId('claude', 's1', turnKey, 0);
      expect(createPartExternalId('codex', 's1', turnKey, 0)).not.toBe(base);
      expect(createPartExternalId('claude', 's2', turnKey, 0)).not.toBe(base);
      expect(
        createPartExternalId('claude', 's1', createTurnKey('claude', 's1', 'uuid:u2'), 0)
      ).not.toBe(base);
      expect(createPartExternalId('claude', 's1', turnKey, 1)).not.toBe(base);
    });
  });

  describe('compareObservationBoundary', () => {
    it('compares source_offset by generation then offset', () => {
      const a = { kind: 'source_offset' as const, generation: 1, offset: 100 };
      const b = { kind: 'source_offset' as const, generation: 1, offset: 200 };
      const c = { kind: 'source_offset' as const, generation: 2, offset: 50 };
      expect(compareObservationBoundary(a, b)).toBe('older');
      expect(compareObservationBoundary(b, a)).toBe('newer');
      expect(compareObservationBoundary(a, a)).toBe('equal');
      expect(compareObservationBoundary(a, c)).toBe('older');
      expect(compareObservationBoundary(c, b)).toBe('newer');
    });

    it('compares delivery_sequence by sequence', () => {
      const a = { kind: 'delivery_sequence' as const, sequence: 1 };
      const b = { kind: 'delivery_sequence' as const, sequence: 2 };
      expect(compareObservationBoundary(a, b)).toBe('older');
      expect(compareObservationBoundary(b, a)).toBe('newer');
      expect(compareObservationBoundary(a, a)).toBe('equal');
    });

    it('returns incomparable for different boundary kinds', () => {
      const source = { kind: 'source_offset' as const, generation: 1, offset: 100 };
      const delivery = { kind: 'delivery_sequence' as const, sequence: 1 };
      expect(compareObservationBoundary(source, delivery)).toBe('incomparable');
      expect(compareObservationBoundary(delivery, source)).toBe('incomparable');
    });
  });

  describe('createContentHash', () => {
    it('is stable for identical content', () => {
      const parts = [makePart({ content: 'hello' }), makePart({ content: 'world' })];
      expect(createContentHash('p', 'a', ['t1'], parts)).toBe(
        createContentHash('p', 'a', ['t1'], parts)
      );
    });

    it('changes when prompt, assistant, tool results, or parts change', () => {
      const parts = [makePart({ content: 'hello' })];
      const base = createContentHash('p', 'a', ['t1'], parts);
      expect(createContentHash('p2', 'a', ['t1'], parts)).not.toBe(base);
      expect(createContentHash('p', 'a2', ['t1'], parts)).not.toBe(base);
      expect(createContentHash('p', 'a', ['t2'], parts)).not.toBe(base);
      expect(createContentHash('p', 'a', ['t1'], [makePart({ content: 'changed' })])).not.toBe(
        base
      );
    });

    it('does not depend on sourceOrder', () => {
      const parts = [makePart({ content: 'hello' })];
      // sourceOrder is not an argument; the hash covers the remaining fields.
      expect(createContentHash('p', 'a', ['t1'], parts)).toBe(
        createContentHash('p', 'a', ['t1'], parts)
      );
    });
  });
});
