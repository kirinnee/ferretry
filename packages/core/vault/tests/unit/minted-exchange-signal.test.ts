import { expect, test } from 'bun:test';
import { MintedExchangeRequestSchema } from '../../contract/index.ts';

const request = (signal: unknown) => ({
  method: 'POST',
  url: 'https://mcp.example.com/mcp',
  headers: {},
  ...(signal === undefined ? {} : { signal }),
});

test('a minted exchange accepts the AbortSignal the global is NOW, not the one it was when the contract loaded', () => {
  const native = globalThis.AbortSignal;
  class OtherAbortSignal {}
  try {
    // A DOM test in the same bun process registers its own class before the first file imports this contract.
    Reflect.set(globalThis, 'AbortSignal', OtherAbortSignal);
    expect(MintedExchangeRequestSchema.safeParse(request(new OtherAbortSignal())).success).toBe(true);
    expect(MintedExchangeRequestSchema.safeParse(request(new AbortController().signal)).success).toBe(false);
  } finally {
    Reflect.set(globalThis, 'AbortSignal', native);
  }
  expect(MintedExchangeRequestSchema.safeParse(request(new AbortController().signal)).success).toBe(true);
  expect(MintedExchangeRequestSchema.safeParse(request({ aborted: false })).success).toBe(false);
  expect(MintedExchangeRequestSchema.safeParse(request(undefined)).success).toBe(true);
});
