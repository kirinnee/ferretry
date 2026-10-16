import { describe, it } from 'bun:test';
import should from 'should';
import {
  assembleBrowserStream,
  BROWSER_STREAM_CHUNK_HEADER_BYTES,
  BROWSER_STREAM_MAX_ENVELOPE_BYTES,
  type BrowserStreamAssembly,
  EMPTY_BROWSER_STREAM_ASSEMBLY,
  encodeBrowserStreamChunks,
  nextBrowserStreamSerial,
} from '../../src/lib/browser-stream.ts';

const envelopeOf = (length: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff);

/** Feeds runs in order, failing the test on a framing error, and answers every completed envelope. */
const feed = (
  runs: readonly Uint8Array[],
  start: BrowserStreamAssembly = EMPTY_BROWSER_STREAM_ASSEMBLY,
): { readonly assembly: BrowserStreamAssembly; readonly envelopes: Uint8Array[] } => {
  let assembly = start;
  const envelopes: Uint8Array[] = [];
  for (const run of runs) {
    const step = assembleBrowserStream(assembly, run);
    if (!step.ok) throw new Error(step.message);
    assembly = step.assembly;
    envelopes.push(...step.envelopes);
  }
  return { assembly, envelopes };
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.byteLength;
  }
  return whole;
};

describe('browser stream chunks', () => {
  it('cuts an envelope into chunks no larger than one record, and reassembles it exactly', () => {
    const envelope = envelopeOf(250);
    const chunks = encodeBrowserStreamChunks(7, envelope, BROWSER_STREAM_CHUNK_HEADER_BYTES + 100);
    should(chunks.map(chunk => chunk.byteLength)).eql([121, 121, 71]);
    const { assembly, envelopes } = feed(chunks);
    should(envelopes).have.length(1);
    should([...(envelopes[0] ?? [])]).eql([...envelope]);
    should(assembly.frame).be.undefined();
    should(assembly.pending.byteLength).equal(0);
  });

  it('sends a small envelope as one chunk', () => {
    const chunks = encodeBrowserStreamChunks(0, envelopeOf(10), 1_000);
    should(chunks).have.length(1);
    should(feed(chunks).envelopes).have.length(1);
  });

  it('reads the stream in any runs a carrier delivers, including coalesced and split chunks', () => {
    const first = envelopeOf(90, 2);
    const second = envelopeOf(40, 3);
    const stream = concat([
      ...encodeBrowserStreamChunks(1, first, BROWSER_STREAM_CHUNK_HEADER_BYTES + 32),
      ...encodeBrowserStreamChunks(2, second, BROWSER_STREAM_CHUNK_HEADER_BYTES + 32),
    ]);
    // Three-byte runs split every header and every payload; one run coalesces everything.
    const runs: Uint8Array[] = [];
    for (let offset = 0; offset < stream.byteLength; offset += 3) runs.push(stream.subarray(offset, offset + 3));
    for (const delivery of [runs, [stream]]) {
      const { envelopes } = feed(delivery);
      should(envelopes.map(envelope => [...envelope])).eql([[...first], [...second]]);
    }
  });

  it('loses only the frame a dropped chunk belonged to, and paints the next whole one', () => {
    const broken = encodeBrowserStreamChunks(4, envelopeOf(90, 4), BROWSER_STREAM_CHUNK_HEADER_BYTES + 32);
    const resent = envelopeOf(90, 5);
    const { envelopes } = feed([
      broken[0] as Uint8Array,
      // broken[1] was dropped by the transport.
      broken[2] as Uint8Array,
      ...encodeBrowserStreamChunks(5, resent, BROWSER_STREAM_CHUNK_HEADER_BYTES + 32),
    ]);
    should(envelopes.map(envelope => [...envelope])).eql([[...resent]]);
  });

  it('abandons a partial frame when a new one starts, and ignores a continuation of another serial', () => {
    const partial = encodeBrowserStreamChunks(8, envelopeOf(60, 6), BROWSER_STREAM_CHUNK_HEADER_BYTES + 32);
    const stranger = encodeBrowserStreamChunks(9, envelopeOf(60, 7), BROWSER_STREAM_CHUNK_HEADER_BYTES + 32);
    const whole = envelopeOf(20, 8);
    const midway = feed([partial[0] as Uint8Array]);
    should(midway.assembly.frame?.received).equal(32);
    const { envelopes } = feed(
      [stranger[1] as Uint8Array, ...encodeBrowserStreamChunks(10, whole, 1_000)],
      midway.assembly,
    );
    should(envelopes.map(envelope => [...envelope])).eql([[...whole]]);
    // A continuation with nothing in hand is simply discarded.
    should(feed([stranger[1] as Uint8Array]).envelopes).have.length(0);
  });

  it('fails closed on a stream that lost its framing', () => {
    const chunk = encodeBrowserStreamChunks(1, envelopeOf(10), 1_000)[0] as Uint8Array;
    const corrupt = (mutate: (copy: Uint8Array, view: DataView) => void): string => {
      const copy = chunk.slice();
      mutate(copy, new DataView(copy.buffer));
      const step = assembleBrowserStream(EMPTY_BROWSER_STREAM_ASSEMBLY, copy);
      return step.ok ? 'accepted' : step.message;
    };
    should(corrupt(copy => (copy[0] = 0))).match(/magic/);
    should(corrupt(copy => (copy[4] = 2))).match(/version/);
    should(corrupt((_, view) => view.setUint32(9, 0))).match(/contradicts/);
    should(corrupt((_, view) => view.setUint32(9, BROWSER_STREAM_MAX_ENVELOPE_BYTES + 1))).match(/contradicts/);
    should(corrupt((_, view) => view.setUint32(17, 0))).match(/contradicts/);
    should(corrupt((_, view) => view.setUint32(13, 5))).match(/contradicts/);
  });

  it('waits for the rest of a chunk instead of guessing', () => {
    const chunk = encodeBrowserStreamChunks(1, envelopeOf(10), 1_000)[0] as Uint8Array;
    const step = assembleBrowserStream(EMPTY_BROWSER_STREAM_ASSEMBLY, chunk.subarray(0, 25));
    should(step.ok && step.envelopes.length === 0 && step.assembly.pending.byteLength === 25).be.true();
  });

  it('sends nothing it could not honestly send', () => {
    should(encodeBrowserStreamChunks(1, new Uint8Array(0), 1_000)).have.length(0);
    should(encodeBrowserStreamChunks(1, envelopeOf(10), BROWSER_STREAM_CHUNK_HEADER_BYTES)).have.length(0);
    should(encodeBrowserStreamChunks(1, envelopeOf(10), Number.NaN)).have.length(0);
    should(encodeBrowserStreamChunks(-1, envelopeOf(10), 1_000)).have.length(0);
    should(encodeBrowserStreamChunks(1.5, envelopeOf(10), 1_000)).have.length(0);
    should(encodeBrowserStreamChunks(0x1_0000_0000, envelopeOf(10), 1_000)).have.length(0);
    should(encodeBrowserStreamChunks(1, new Uint8Array(BROWSER_STREAM_MAX_ENVELOPE_BYTES + 1), 64 * 1024)).have.length(
      0,
    );
  });

  it('wraps the serial inside four bytes', () => {
    should(nextBrowserStreamSerial(0)).equal(1);
    should(nextBrowserStreamSerial(0xffff_ffff)).equal(0);
  });
});
