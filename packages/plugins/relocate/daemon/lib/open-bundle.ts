import { FERRET_READABLE_FOLDERS } from '@ferretry/core-ferrets/contract';
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  type CloneCrypto,
  fromBase64UrlFixed,
  type PrivateKeyHandle,
  utf8Bytes,
  X25519_PUBLIC_KEY_BYTES,
} from '@ferretry/std/sealing';
import {
  BUNDLE_KEY_LABEL,
  type BundleHeader,
  type BundleEntryKind,
  type BundleManifest,
  BundleManifestSchema,
  chunkAssociatedData,
  RELOCATE_MAX_BUNDLE_BYTES,
  RELOCATE_MAX_FILE_BYTES,
  type RelocateOffer,
} from '../../contract/index.ts';
import { toHex } from './hex.ts';
import { namesASecret } from './path-policy.ts';

/** A bundle that cannot be trusted: one plain sentence, and nothing was written. */
export class BundleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleRefused';
  }
}

/** One verified entry: its bytes, checked against the hash the manifest carries. */
interface OpenedEntry {
  readonly kind: BundleEntryKind;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface OpenedBundle {
  readonly manifest: BundleManifest;
  readonly entries: readonly OpenedEntry[];
}

/** The manifest is read before anything it names is trusted, so it is bounded on its own. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/** A plain relative path of plain segments: no `..`, no `.`, no empty segment, no separator tricks, no `.git`. */
function isPlainRelativePath(path: string, allowDotGit = false): boolean {
  if (path === '' || path.length > 1024 || path.startsWith('/') || /[\\\0]/u.test(path)) return false;
  return path
    .split('/')
    .every(
      segment =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        segment.length <= 255 &&
        (allowDotGit || segment.toLowerCase() !== '.git'),
    );
}

/** The path rule of each kind of entry. A source we trust still never decides where a file lands on this machine. */
function pathAllowed(kind: BundleEntryKind, path: string): boolean {
  switch (kind) {
    case 'ferret-record':
      return path === 'record.json';
    case 'journal':
      return path === 'history.jsonl';
    case 'worktree-commits':
      return path === 'commits.bundle';
    case 'worktree-changes':
      return path === 'changes.diff';
    case 'session':
      return (
        isPlainRelativePath(path) &&
        path.includes('/') &&
        (FERRET_READABLE_FOLDERS as readonly string[]).includes(path.split('/')[0] ?? '') &&
        !namesASecret(path)
      );
    case 'worktree-file':
      return isPlainRelativePath(path) && !namesASecret(path);
    case 'conversation':
      return isPlainRelativePath(path, true);
  }
}

const AT_MOST_ONE: readonly BundleEntryKind[] = [
  'ferret-record',
  'conversation',
  'worktree-commits',
  'worktree-changes',
  'journal',
];

/**
 * Opens a bundle for the offer that was spent on it, and checks EVERYTHING before the caller writes anything: the header
 * is this offer's and this machine's, every chunk authenticates (the tag covers its place and the whole header), the count
 * and the size are the header's, the manifest parses, each entry has its place and its hash, no path leaves its folder,
 * and no entry is anything the table does not list. A refusal is one sentence and writes nothing.
 */
export async function openBundle(input: {
  readonly crypto: CloneCrypto;
  readonly offer: RelocateOffer;
  readonly privateKey: PrivateKeyHandle;
  readonly header: BundleHeader;
  readonly chunks: ReadonlyMap<number, Uint8Array>;
  readonly ownDaemonId: string;
}): Promise<OpenedBundle> {
  const { crypto, offer, header, chunks } = input;
  if (header.offerId !== offer.offerId || header.expiresAt !== offer.expiresAt)
    throw new BundleRefused('this bundle was sealed for another offer');
  if (header.targetDaemonId !== input.ownDaemonId || offer.daemonId !== input.ownDaemonId)
    throw new BundleRefused('this bundle was sealed for another machine');
  if (header.sourceDaemonId === input.ownDaemonId)
    throw new BundleRefused('a machine cannot receive a ferret from itself');
  if (header.bytes > RELOCATE_MAX_BUNDLE_BYTES + header.chunks * 64)
    throw new BundleRefused('this bundle is larger than a move can be');
  if (chunks.size !== header.chunks)
    throw new BundleRefused(`${String(chunks.size)} of ${String(header.chunks)} chunks arrived; upload them all`);
  const ephemeral = fromBase64UrlFixed(header.ephemeralKey, X25519_PUBLIC_KEY_BYTES);
  const shared = ephemeral === null ? null : await crypto.deriveSharedSecret(input.privateKey, ephemeral);
  if (shared === null) throw new BundleRefused('this bundle carries a key no machine could hold');
  const key = await crypto.deriveKey(shared, utf8Bytes(offer.offerId), BUNDLE_KEY_LABEL, AEAD_KEY_BYTES);

  const plain: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < header.chunks; index += 1) {
    const chunk = chunks.get(index);
    if (chunk === undefined || chunk.length <= AEAD_NONCE_BYTES)
      throw new BundleRefused(`chunk ${String(index)} is missing`);
    const opened = await crypto.open(
      key,
      chunk.subarray(0, AEAD_NONCE_BYTES),
      chunkAssociatedData(header, index),
      chunk.subarray(AEAD_NONCE_BYTES),
    );
    if (opened === null) throw new BundleRefused(`chunk ${String(index)} did not authenticate: nothing was written`);
    plain.push(opened);
    total += opened.length;
  }
  if (total !== header.bytes || total < 4) throw new BundleRefused('the bundle is not the size its header says');
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of plain) {
    all.set(part, at);
    at += part.length;
  }
  const manifestLength = new DataView(all.buffer).getUint32(0, false);
  if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES || 4 + manifestLength > all.length)
    throw new BundleRefused('the bundle’s manifest is not a manifest');
  let manifest: BundleManifest;
  try {
    manifest = BundleManifestSchema.parse(JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + manifestLength))));
  } catch {
    throw new BundleRefused('the bundle’s manifest is not a manifest');
  }
  if (manifest.entries.length > MAX_ENTRIES) throw new BundleRefused('the bundle names too many files');

  const entries: OpenedEntry[] = [];
  const seen = new Set<string>();
  const counts = new Map<BundleEntryKind, number>();
  let offset = 4 + manifestLength;
  for (const entry of manifest.entries) {
    if (!pathAllowed(entry.kind, entry.path))
      throw new BundleRefused('the bundle names a file that does not belong to a move');
    const id = `${entry.kind}:${entry.path}`;
    if (seen.has(id)) throw new BundleRefused('the bundle names a file twice');
    seen.add(id);
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    if (entry.size > RELOCATE_MAX_FILE_BYTES)
      throw new BundleRefused('the bundle holds a file larger than a move allows');
    if (offset + entry.size > all.length) throw new BundleRefused('the bundle is shorter than its manifest says');
    const bytes = all.slice(offset, offset + entry.size);
    offset += entry.size;
    if (toHex(await crypto.sha256(bytes)) !== entry.sha256)
      throw new BundleRefused(`${entry.path} does not match its hash: nothing was written`);
    entries.push({ kind: entry.kind, path: entry.path, bytes });
  }
  if (offset !== all.length) throw new BundleRefused('the bundle holds bytes its manifest does not name');
  for (const kind of AT_MOST_ONE)
    if ((counts.get(kind) ?? 0) > 1) throw new BundleRefused(`the bundle holds more than one ${kind}`);
  for (const kind of ['ferret-record', 'conversation'] as const)
    if ((counts.get(kind) ?? 0) !== 1) throw new BundleRefused(`the bundle holds no ${kind}`);
  const worktreeKinds: readonly BundleEntryKind[] = ['worktree-commits', 'worktree-changes', 'worktree-file'];
  if (manifest.worktree === undefined && worktreeKinds.some(kind => (counts.get(kind) ?? 0) > 0))
    throw new BundleRefused('the bundle carries working-tree files but no working tree');
  return { manifest, entries };
}
