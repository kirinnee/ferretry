import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import * as wire from '../../wire.ts';

const root = resolve(import.meta.dir, '../..');

/** Every module `wire.ts` reaches, by walking its static imports (type-only imports included: they cost nothing). */
async function importGraph(entry: string): Promise<readonly string[]> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await Bun.file(file).text();
    for (const match of text.matchAll(/^(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gmu)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.')) await visit(resolve(dirname(file), specifier));
      else external.add(specifier);
    }
  };
  await visit(entry);
  return [...[...seen].map(file => file.slice(root.length + 1)), ...[...external].map(name => `external:${name}`)];
}

describe('@ferretry/kernel/wire', () => {
  test('reaches no IO: no node:* module, no host module outside the session wire and its WebCrypto adapter', async () => {
    const graph = await importGraph(resolve(root, 'wire.ts'));
    const externals = graph.filter(entry => entry.startsWith('external:'));
    expect(externals.sort()).toEqual(['external:zod']);
    for (const file of graph.filter(entry => !entry.startsWith('external:') && entry !== 'wire.ts'))
      expect(file.startsWith('host/session/wire/') || file === 'host/session/adapters/web-crypto.ts').toBe(true);
  });

  test('offers what the carriers and the Workers import', () => {
    for (const name of [
      'encodeFrame',
      'decodeFrame',
      'sessionIdFromBytes',
      'sessionIdFromText',
      'RENDEZVOUS_SESSION_ID',
      'FRAME_KINDS',
      'SESSION_ID_BYTES',
      'RELAY_PROTOCOL_ID',
      'SESSION_PROTOCOL_ID',
      'MAX_FRAME_BYTES',
      'SESSION_CLOSE_CODES',
      'parseDaemonId',
      'publicKeyMatchesDaemonId',
      'claimTranscript',
      'verifyRendezvousClaim',
      'claimContextForChallenge',
      'tunnelTranscript',
      'verifyTunnelRequest',
      'verifyDeviceProof',
      'deviceRotateMessage',
      'DeviceKeySchema',
      'toBase64Url',
      'fromBase64Url',
      'fromBase64UrlFixed',
      'WebCryptoSessionCrypto',
    ])
      expect(name in wire).toBe(true);
  });
});
