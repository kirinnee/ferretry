import type { FerretId, FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { Log } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { type CloneCrypto, toBase64Url } from '@ferretry/std/sealing';
import {
  type BundleHeader,
  type CompleteRequest,
  type CompleteResponse,
  type ExportResponse,
  type PreflightResponse,
  RELOCATE_CHUNK_BYTES,
  RELOCATE_EXPORT_TTL_MS,
  RELOCATE_MAX_OPEN_EXPORTS,
  type RelocateOffer,
} from '../../contract/index.ts';
import type { WorkingTree } from './git-bundle.ts';
import { OfferRefused, sealBundle, verifiedOfferKey } from './seal.ts';
import { gather, manifestOf, plan, type Plan, preflightView, type SnapshotInputs } from './snapshot.ts';

/** A refusal the route answers with its own status and a closed code. */
export class RelocateRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RelocateRefused';
  }
}

/** The ferrets this machine has handed to another: the one thing Relocate keeps. */
export interface MovedLedger {
  get(
    ferret: string,
  ): Promise<{ readonly daemonId: string; readonly ferretId: string; readonly at: Instant } | undefined>;
  record(
    ferret: string,
    entry: { readonly daemonId: string; readonly ferretId: string; readonly at: Instant },
  ): Promise<void>;
}

export interface RelocationDeps {
  readonly crypto: CloneCrypto;
  readonly ferrets: Pick<FerretsApi, 'get' | 'workFolder' | 'relocationSource' | 'stop' | 'resume'>;
  readonly treeOf: (folder: string) => WorkingTree;
  readonly daemonId: string;
  readonly clock: { readonly now: () => Instant; readonly nowMs: () => number };
  readonly moved: MovedLedger;
  readonly log: Pick<Log, 'warn'>;
}

interface OpenExport {
  readonly ferret: FerretId;
  readonly header: BundleHeader;
  readonly chunks: readonly Uint8Array[];
  readonly createdAtMs: number;
}

const newId = (crypto: CloneCrypto, prefix: string): string => `${prefix}${toBase64Url(crypto.randomBytes(16))}`;

/** The SOURCE end of a move: look, seal, hand the ciphertext out, and mark the ferret moved. Stateless but for the exports it holds. */
export class Relocation {
  readonly #exports = new Map<string, OpenExport>();
  /** Offers already used, until they would have expired: an offer is spent by the first attempt, not by its success. */
  readonly #spent = new Map<string, number>();

  constructor(private readonly deps: RelocationDeps) {}

  async preflight(ferretId: string, to: string): Promise<PreflightResponse> {
    if (to === this.deps.daemonId)
      throw new RelocateRefused(400, 'a machine cannot move a ferret to itself', 'same_machine');
    const { inputs } = await this.#inputs(ferretId);
    return preflightView(await this.#planned(ferretId, inputs));
  }

  async export(ferretId: string, offer: RelocateOffer): Promise<ExportResponse> {
    const nowMs = this.deps.clock.nowMs();
    this.#prune(nowMs);
    let offerKey: Uint8Array;
    try {
      offerKey = await verifiedOfferKey(this.deps.crypto, offer, this.deps.daemonId, nowMs);
    } catch (error) {
      if (error instanceof OfferRefused) throw new RelocateRefused(400, error.message, error.code);
      throw error;
    }
    if (this.#spent.has(offer.offerId))
      throw new RelocateRefused(409, 'this offer was already used; open a new one on the other machine', 'offer_spent');
    if (this.#exports.size >= RELOCATE_MAX_OPEN_EXPORTS)
      throw new RelocateRefused(409, 'another move is still in progress on this machine', 'export_busy');

    const { inputs, summary } = await this.#inputs(ferretId);
    const first = await this.#planned(ferretId, inputs);
    if (first.refusals.length > 0) throw new RelocateRefused(409, first.refusals.join('; '), 'move_refused');

    // From here the offer is used up, whether or not the export works: a refused attempt is never retried against one key.
    this.#spent.set(offer.offerId, Date.parse(offer.expiresAt));
    const id = summary.id;
    const wasRunning = summary.state === 'idle';
    if (wasRunning) await this.deps.ferrets.stop(id, 'polite', 'moving to another machine');
    try {
      const stopped = (await this.deps.ferrets.get(id)) ?? summary;
      const after: SnapshotInputs = { ...inputs, summary: stopped };
      const found = await plan(after);
      if (found.refusals.length > 0) throw new RelocateRefused(409, found.refusals.join('; '), 'move_refused');
      const entries = await gather(after, found);
      const manifest = await manifestOf(this.deps.crypto, { id, name: stopped.name }, found, entries);
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, manifestBytes.length, false);
      const sealed = await sealBundle(this.deps.crypto, {
        offer,
        offerKey,
        sourceDaemonId: this.deps.daemonId,
        parts: [length, manifestBytes, ...entries.map(entry => entry.bytes)],
        chunkBytes: RELOCATE_CHUNK_BYTES,
      });
      const exportId = newId(this.deps.crypto, 'fy_relocate_export_');
      this.#exports.set(exportId, { ferret: id, header: sealed.header, chunks: sealed.chunks, createdAtMs: nowMs });
      return { exportId, header: sealed.header };
    } catch (error) {
      // Any failure before the move completes: the source runs its ferret again, and nothing was changed.
      if (wasRunning) await this.#resume(id);
      if (error instanceof OfferRefused) throw new RelocateRefused(400, error.message, error.code);
      throw error;
    }
  }

  chunk(exportId: string, index: number): Uint8Array {
    this.#prune(this.deps.clock.nowMs());
    const open = this.#exports.get(exportId);
    if (open === undefined)
      throw new RelocateRefused(404, 'no such export here: it timed out or was completed', 'export_unknown');
    const chunk = open.chunks[index];
    if (chunk === undefined) throw new RelocateRefused(404, 'no such chunk in this export', 'chunk_unknown');
    return chunk;
  }

  async complete(exportId: string, request: CompleteRequest): Promise<CompleteResponse> {
    this.#prune(this.deps.clock.nowMs());
    const open = this.#exports.get(exportId);
    if (open === undefined)
      throw new RelocateRefused(404, 'no such export here: it timed out or was completed', 'export_unknown');
    if (request.to.daemonId !== open.header.targetDaemonId)
      throw new RelocateRefused(403, 'this export was sealed for another machine', 'wrong_target');
    const at = this.deps.clock.now();
    const entry = { daemonId: request.to.daemonId, ferretId: request.to.ferretId, at };
    await this.deps.moved.record(open.ferret, entry);
    this.#exports.delete(exportId);
    return { ferretId: open.ferret, movedTo: entry };
  }

  async #inputs(ferretId: string): Promise<{ inputs: SnapshotInputs; summary: FerretSummary }> {
    const summary = await this.deps.ferrets.get(ferretId as FerretId);
    if (summary === undefined) throw new RelocateRefused(404, 'this machine has no such ferret', 'not_found');
    const moved = await this.deps.moved.get(summary.id);
    if (moved !== undefined)
      throw new RelocateRefused(409, 'this ferret was already moved to another machine', 'already_moved');
    const source = await this.deps.ferrets.relocationSource?.(summary.id);
    if (source === undefined)
      throw new RelocateRefused(409, 'this machine cannot read this ferret’s files for a move', 'unavailable');
    const folder = (await this.deps.ferrets.workFolder(summary.id))?.folder;
    return { summary, inputs: { summary, source, tree: folder === undefined ? undefined : this.deps.treeOf(folder) } };
  }

  async #planned(ferretId: string, inputs: SnapshotInputs): Promise<Plan> {
    try {
      return await plan(inputs);
    } catch (error) {
      this.deps.log.warn('a move could not be planned', { ferret: ferretId });
      throw new RelocateRefused(
        409,
        error instanceof Error ? error.message : 'the move could not be planned',
        'move_refused',
      );
    }
  }

  async #resume(ferret: FerretId): Promise<void> {
    try {
      await this.deps.ferrets.resume(ferret, undefined, { origin: { kind: 'person' } });
    } catch {
      this.deps.log.warn('a ferret whose move failed could not be resumed', { ferret });
    }
  }

  #prune(nowMs: number): void {
    for (const [id, open] of this.#exports)
      if (nowMs - open.createdAtMs >= RELOCATE_EXPORT_TTL_MS) this.#exports.delete(id);
    for (const [id, expiresAtMs] of this.#spent) if (expiresAtMs + 60_000 <= nowMs) this.#spent.delete(id);
  }
}
