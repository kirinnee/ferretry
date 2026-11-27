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
import {
  assertSnapshotSize,
  gather,
  manifestOf,
  plan,
  type Plan,
  preflightView,
  type SnapshotInputs,
} from './snapshot.ts';

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
  readonly resumeOnExpiry: boolean;
  completing?: boolean;
}

const newId = (crypto: CloneCrypto, prefix: string): string => `${prefix}${toBase64Url(crypto.randomBytes(16))}`;

/** The SOURCE end of a move: look, seal, hand the ciphertext out, and mark the ferret moved. Stateless but for the exports it holds. */
export class Relocation {
  readonly #exports = new Map<string, OpenExport>();
  /** Offers already used, until they would have expired: an offer is spent by the first attempt, not by its success. */
  readonly #spent = new Map<string, number>();

  #reserved = 0;
  readonly #recovery = new Set<FerretId>();
  readonly #resuming = new Map<FerretId, Promise<boolean>>();

  constructor(private readonly deps: RelocationDeps) {}

  async preflight(ferretId: string, to: string): Promise<PreflightResponse> {
    if (to === this.deps.daemonId)
      throw new RelocateRefused(400, 'a machine cannot move a ferret to itself', 'same_machine');
    const { inputs } = await this.#inputs(ferretId);
    return preflightView(await this.#planned(ferretId, inputs));
  }

  async export(ferretId: string, offer: RelocateOffer): Promise<ExportResponse> {
    const nowMs = this.deps.clock.nowMs();
    await this.expire();
    let offerKey: Uint8Array;
    try {
      offerKey = await verifiedOfferKey(this.deps.crypto, offer, this.deps.daemonId, nowMs);
    } catch (error) {
      if (error instanceof OfferRefused) throw new RelocateRefused(400, error.message, error.code);
      throw error;
    }
    if (this.#spent.has(offer.offerId))
      throw new RelocateRefused(409, 'this offer was already used; open a new one on the other machine', 'offer_spent');
    if (this.#exports.size + this.#reserved + this.#recovery.size >= RELOCATE_MAX_OPEN_EXPORTS)
      throw new RelocateRefused(409, 'another move is still in progress on this machine', 'export_busy');

    // No await between these checks and the reservation: one verified offer buys one attempt.
    this.#spent.set(offer.offerId, Date.parse(offer.expiresAt));
    this.#reserved += 1;
    let id: FerretId | undefined;
    let wasRunning = false;
    try {
      const { inputs, summary } = await this.#inputs(ferretId);
      const first = await this.#planned(ferretId, inputs);
      if (first.refusals.length > 0) throw new RelocateRefused(409, first.refusals.join('; '), 'move_refused');
      id = summary.id;
      wasRunning = summary.state === 'idle';
      if (wasRunning) {
        await this.deps.ferrets.stop(id, 'polite', 'moving to another machine');
      }
      const stopped = (await this.deps.ferrets.get(id)) ?? summary;
      const after: SnapshotInputs = { ...inputs, summary: stopped };
      const found = await plan(after);
      if (found.refusals.length > 0) throw new RelocateRefused(409, found.refusals.join('; '), 'move_refused');
      const entries = await gather(after, found);
      const manifest = await manifestOf(this.deps.crypto, { id, name: stopped.name }, found, entries);
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, manifestBytes.length, false);
      assertSnapshotSize(entries, length.length + manifestBytes.length);
      const sealed = await sealBundle(this.deps.crypto, {
        offer,
        offerKey,
        sourceDaemonId: this.deps.daemonId,
        parts: [length, manifestBytes, ...entries.map(entry => entry.bytes)],
        chunkBytes: RELOCATE_CHUNK_BYTES,
      });
      const exportId = newId(this.deps.crypto, 'fy_relocate_export_');
      this.#exports.set(exportId, {
        ferret: id,
        header: sealed.header,
        chunks: sealed.chunks,
        createdAtMs: this.deps.clock.nowMs(),
        resumeOnExpiry: wasRunning,
      });
      this.#recovery.delete(id);
      return { exportId, header: sealed.header };
    } catch (error) {
      // Any failure before the move completes: the source runs its ferret again, and nothing was changed.
      if (wasRunning && id !== undefined) {
        this.#recovery.add(id);
        await this.#resume(id);
      }
      if (error instanceof OfferRefused) throw new RelocateRefused(400, error.message, error.code);
      if (!(error instanceof RelocateRefused))
        throw new RelocateRefused(
          409,
          error instanceof Error ? error.message : 'the move could not be prepared',
          'move_refused',
        );
      throw error;
    } finally {
      this.#reserved -= 1;
    }
  }

  chunk(exportId: string, index: number): Uint8Array {
    void this.expire();
    const open = this.#exports.get(exportId);
    if (open === undefined || this.deps.clock.nowMs() - open.createdAtMs >= RELOCATE_EXPORT_TTL_MS)
      throw new RelocateRefused(404, 'no such export here: it timed out or was completed', 'export_unknown');
    const chunk = open.chunks[index];
    if (chunk === undefined) throw new RelocateRefused(404, 'no such chunk in this export', 'chunk_unknown');
    return chunk;
  }

  async complete(exportId: string, request: CompleteRequest): Promise<CompleteResponse> {
    await this.expire();
    const open = this.#exports.get(exportId);
    if (open === undefined || this.deps.clock.nowMs() - open.createdAtMs >= RELOCATE_EXPORT_TTL_MS)
      throw new RelocateRefused(404, 'no such export here: it timed out or was completed', 'export_unknown');
    if (request.to.daemonId !== open.header.targetDaemonId)
      throw new RelocateRefused(403, 'this export was sealed for another machine', 'wrong_target');
    if (open.completing === true) throw new RelocateRefused(409, 'this move is already being committed', 'export_busy');
    const at = this.deps.clock.now();
    const entry = { daemonId: request.to.daemonId, ferretId: request.to.ferretId, at };
    open.completing = true;
    try {
      await this.deps.moved.record(open.ferret, entry);
      this.#exports.delete(exportId);
      return { ferretId: open.ferret, movedTo: entry };
    } finally {
      open.completing = false;
    }
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

  async #resume(ferret: FerretId): Promise<boolean> {
    const pending = this.#resuming.get(ferret);
    if (pending !== undefined) return await pending;
    const work = (async () => {
      try {
        const resumed = await this.deps.ferrets.resume(ferret, undefined, { origin: { kind: 'person' } });
        if (!resumed.ok) throw new Error('resume was refused');
        this.#recovery.delete(ferret);
        return true;
      } catch {
        this.#recovery.add(ferret);
        this.deps.log.warn('a ferret whose move failed could not be resumed', { ferret });
        return false;
      }
    })();
    this.#resuming.set(ferret, work);
    try {
      return await work;
    } finally {
      this.#resuming.delete(ferret);
    }
  }

  /** Called by the daemon clock even when nobody asks for another chunk. Failed recovery retains its reservation. */
  async expire(): Promise<void> {
    const nowMs = this.deps.clock.nowMs();
    for (const [id, open] of this.#exports) {
      if (open.completing === true || nowMs - open.createdAtMs < RELOCATE_EXPORT_TTL_MS) continue;
      if (!open.resumeOnExpiry || (await this.#resume(open.ferret))) this.#exports.delete(id);
    }
    for (const ferret of [...this.#recovery]) await this.#resume(ferret);
    for (const [id, expiresAtMs] of this.#spent) if (expiresAtMs + 60_000 <= nowMs) this.#spent.delete(id);
  }
}
