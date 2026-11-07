/**
 * Both halves import the one wire in the contract (`contract/wire/*.ts`); the stream is the one wire the two halves
 * speak to each other in bytes, so its round trip — the daemon's encoder into the app's assembler — stays proven.
 */
import { describe, expect, it } from 'bun:test';
import {
  assembleBrowserStream,
  EMPTY_BROWSER_STREAM_ASSEMBLY,
  encodeBrowserStreamChunks,
} from '../../../contract/wire/stream.ts';

describe('the browser stream wire', () => {
  it('R548 reassembles from the app side what the daemon half cut into chunks', () => {
    const envelope = new Uint8Array(1_000).map((_, index) => index % 251);
    let assembly = EMPTY_BROWSER_STREAM_ASSEMBLY;
    const seen: Uint8Array[] = [];
    for (const chunk of encodeBrowserStreamChunks(7, envelope, 64)) {
      const step = assembleBrowserStream(assembly, chunk);
      if (!step.ok) throw new Error(step.message);
      assembly = step.assembly;
      seen.push(...step.envelopes);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(envelope);
  });
});
