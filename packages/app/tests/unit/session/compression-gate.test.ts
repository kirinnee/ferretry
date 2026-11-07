import { afterEach, describe, expect, test } from 'bun:test';
import { acceptEncodingHeader } from '../../../src/session/compression.ts';

const original = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream');
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, 'DecompressionStream');
  else Object.defineProperty(globalThis, 'DecompressionStream', original);
});

describe('asking for a compressed answer', () => {
  test('R506 the client asks for gzip only where DecompressionStream exists', () => {
    Object.defineProperty(globalThis, 'DecompressionStream', { value: class {}, configurable: true, writable: true });
    expect(acceptEncodingHeader()).toEqual({ 'accept-encoding': 'gzip' });
    Reflect.deleteProperty(globalThis, 'DecompressionStream');
    expect(acceptEncodingHeader()).toEqual({});
  });
});
