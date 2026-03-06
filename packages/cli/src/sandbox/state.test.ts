import { describe, test, expect, beforeEach } from 'bun:test';
import { getSandboxState, resetSandboxState } from './state';

describe('SandboxState', () => {
  beforeEach(() => {
    resetSandboxState();
  });

  describe('getSandboxState()', () => {
    test('returns singleton instance', () => {
      const state1 = getSandboxState();
      const state2 = getSandboxState();
      expect(state1).toBe(state2);
    });
  });

  describe('set() and get()', () => {
    test('stores and retrieves values', () => {
      const state = getSandboxState();
      state.set('myVar', { data: 123 });

      expect(state.get('myVar')).toEqual({ data: 123 });
    });

    test('returns undefined for non-existent keys', () => {
      const state = getSandboxState();
      expect(state.get('nonexistent')).toBeUndefined();
    });

    test('overwrites existing values', () => {
      const state = getSandboxState();
      state.set('key', 'value1');
      state.set('key', 'value2');

      expect(state.get('key')).toBe('value2');
    });
  });

  describe('has()', () => {
    test('returns true for existing keys', () => {
      const state = getSandboxState();
      state.set('exists', true);

      expect(state.has('exists')).toBe(true);
    });

    test('returns false for non-existent keys', () => {
      const state = getSandboxState();
      expect(state.has('nonexistent')).toBe(false);
    });
  });

  describe('delete()', () => {
    test('removes stored value', () => {
      const state = getSandboxState();
      state.set('toDelete', 'value');
      state.delete('toDelete');

      expect(state.has('toDelete')).toBe(false);
    });

    test('returns true when key existed', () => {
      const state = getSandboxState();
      state.set('key', 'value');

      expect(state.delete('key')).toBe(true);
    });

    test('returns false when key did not exist', () => {
      const state = getSandboxState();
      expect(state.delete('nonexistent')).toBe(false);
    });
  });

  describe('keys()', () => {
    test('returns all stored keys', () => {
      const state = getSandboxState();
      state.set('a', 1);
      state.set('b', 2);
      state.set('c', 3);

      const keys = Array.from(state.keys());
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
    });

    test('returns empty iterator when no keys', () => {
      const state = getSandboxState();
      const keys = Array.from(state.keys());
      expect(keys).toEqual([]);
    });
  });

  describe('getAll()', () => {
    test('returns all variables as plain object', () => {
      const state = getSandboxState();
      state.set('foo', 1);
      state.set('bar', 'hello');

      expect(state.getAll()).toEqual({ foo: 1, bar: 'hello' });
    });

    test('returns shallow copy (original not mutated)', () => {
      const state = getSandboxState();
      state.set('x', 10);

      const all = state.getAll();
      all['y'] = 20;

      expect(state.has('y')).toBe(false);
    });
  });

  describe('getAllPrefixed()', () => {
    test('returns variables with $ prefix', () => {
      const state = getSandboxState();
      state.set('invoices', [1, 2, 3]);
      state.set('count', 5);

      expect(state.getAllPrefixed()).toEqual({
        $invoices: [1, 2, 3],
        $count: 5,
      });
    });

    test('returns empty object when no variables', () => {
      const state = getSandboxState();
      expect(state.getAllPrefixed()).toEqual({});
    });
  });

  describe('clear()', () => {
    test('removes all stored values', () => {
      const state = getSandboxState();
      state.set('a', 1);
      state.set('b', 2);
      state.clear();

      expect(state.has('a')).toBe(false);
      expect(state.has('b')).toBe(false);
    });
  });

  describe('resetSandboxState()', () => {
    test('creates new instance', () => {
      const state1 = getSandboxState();
      state1.set('key', 'value');

      resetSandboxState();

      const state2 = getSandboxState();
      expect(state2.has('key')).toBe(false);
    });
  });
});
