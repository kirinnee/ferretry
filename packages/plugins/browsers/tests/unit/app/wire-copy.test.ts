/**
 * The app half owns a copy of the daemon half's wire schemas (a half imports only its own files and the contract), so
 * the two must say the same thing. Each copy offers exactly the names its daemon source does, and the stream — the one
 * wire the two halves speak to each other in bytes — round-trips from the daemon's encoder to the app's assembler.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeBrowserStreamChunks as daemonEncode } from '../../../daemon/stream/wire.ts';
import { assembleBrowserStream, EMPTY_BROWSER_STREAM_ASSEMBLY } from '../../../app/lib/wire/stream.ts';

const root = join(import.meta.dir, '..', '..', '..');

const PAIRS = [
  ['browser', 'pages/wire/browser'],
  ['control', 'tools/control-wire'],
  ['login', 'pages/wire/login'],
  ['page-lifecycle', 'pages/wire/page-lifecycle'],
  ['page-script', 'pages/wire/page-script'],
  ['pointer', 'pages/wire/pointer'],
  ['surface', 'pages/wire/surface'],
  ['target', 'pages/wire/target'],
  ['stream', 'stream/wire'],
] as const;

const exportsOf = (path: string): string[] =>
  [...readFileSync(path, 'utf8').matchAll(/^export (?:const|function|class|type|interface) (\w+)/gm)]
    .map(match => match[1] as string)
    .sort();

describe('the app half’s wire copies', () => {
  for (const [app, daemon] of PAIRS)
    it(`${app} offers exactly the names the daemon half's ${daemon} does`, () => {
      expect(exportsOf(join(root, 'app', 'lib', 'wire', `${app}.ts`))).toEqual(
        exportsOf(join(root, 'daemon', `${daemon}.ts`)),
      );
    });

  it('R548 reassembles from the app side what the daemon half cut into chunks', () => {
    const envelope = new Uint8Array(1_000).map((_, index) => index % 251);
    let assembly = EMPTY_BROWSER_STREAM_ASSEMBLY;
    const seen: Uint8Array[] = [];
    for (const chunk of daemonEncode(7, envelope, 64)) {
      const step = assembleBrowserStream(assembly, chunk);
      if (!step.ok) throw new Error(step.message);
      assembly = step.assembly;
      seen.push(...step.envelopes);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(envelope);
  });
});
