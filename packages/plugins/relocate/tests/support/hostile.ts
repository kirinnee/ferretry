import { fromBase64UrlFixed, X25519_PUBLIC_KEY_BYTES } from '@ferretry/std/sealing';
import type { Needs, BundleEntryKind, ImportRequest } from '../../contract/index.ts';
import { sealBundle } from '../../daemon/lib/seal.ts';
import { toHex } from '../../daemon/lib/hex.ts';
import { bundleSigner, crypto, newIdentity } from './identity.ts';
import { CONVERSATION } from './fake-ferrets.ts';
import { normalizeRemote } from '../../daemon/lib/remote.ts';
import { REMOTE_URL } from './real-git.ts';
import type { TargetWorld } from './target.ts';

export const bytes = (s: string) => new TextEncoder().encode(s);
export async function hostile(
  target: TargetWorld,
  input: {
    head: string;
    extra?: readonly { kind: BundleEntryKind; path: string; bytes: Uint8Array }[];
    needs?: Partial<Needs>;
  },
) {
  const identity = await newIdentity();
  const offer = await target.offers.open();
  const entries = [
    {
      kind: 'ferret-record',
      path: 'record.json',
      bytes: bytes(JSON.stringify({ name: 'Mover', harness: 'claude-code' })),
    },
    { kind: 'conversation', path: CONVERSATION.relPath, bytes: bytes(CONVERSATION.text) },
    ...(input.extra ?? []),
  ];
  const manifest = bytes(
    JSON.stringify({
      v: 1,
      ferret: { id: 'f-move-1', name: 'Mover' },
      worktree: { head: input.head, branch: 'main' },
      needs: { harness: 'claude-code', remote: normalizeRemote(REMOTE_URL), secrets: [], ...input.needs },
      entries: await Promise.all(
        entries.map(async entry => ({
          ...entry,
          bytes: undefined,
          size: entry.bytes.length,
          sha256: toHex(await crypto.sha256(entry.bytes)),
        })),
      ),
    }),
  );
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, manifest.length, false);
  const sealed = await sealBundle(crypto, {
    offer,
    offerKey: fromBase64UrlFixed(offer.publicKey, X25519_PUBLIC_KEY_BYTES) as Uint8Array,
    sourceDaemonId: identity.daemonId,
    signer: bundleSigner(identity),
    parts: [length, manifest, ...entries.map(entry => entry.bytes)],
    chunkBytes: 1024 * 1024,
  });
  for (const [i, chunk] of sealed.chunks.entries()) target.importer.receive(offer.offerId, i, chunk);
  const request: ImportRequest = { header: sealed.header, sourceDaemonId: identity.daemonId };
  return { offerId: offer.offerId, request };
}
