/**
 * The one durability contract every transfer artifact is published under.
 *
 * WHY THIS EXISTS. The fork stamps its receipt `imported` the moment `importPlan` resolves, and that
 * receipt is durable. So a durable `imported` may only be reachable once every artifact the import
 * claims — the deterministic first-turn brief, and each plan-pinned attachment original plus its
 * verbatim manifest — will still be there after power is cut. The replay then skips import on the
 * receipt phase and refuses the target instead of repairing it, so a receipt in front of a target
 * with no brief is unrecoverable.
 *
 * WHO DOES THE FLUSHING. Every artifact is written through a port that owns the file mechanics: the kernel state
 * port (the brief) or the attachment owner's store (the originals). Both publish a file ATOMICALLY and flush it
 * and its name before the write resolves, so a resolved `write` IS a durable, complete file — a reader never
 * sees a torn one. This module no longer re-implements that (temporary names, `fsync`, directory walks); it owns
 * only the CONTRACT built on top of it:
 *
 *   1. PUBLISH writes the whole artifact set in the order the caller names, each through its port;
 *   2. CONFIRM reads every name back and requires the bytes this attempt published. Nothing here can see an
 *      inode, so "the name still resolves to what I flushed" is asked of the one thing a port can answer: the
 *      bytes under the name are the bytes this call made durable. A name another writer replaced with
 *      DIFFERENT bytes fails the confirmation; identical bytes are, by construction, the same artifact. That is
 *      enough here, and was not on a bare filesystem, because every writer of these files goes through the same
 *      port (one daemon holds the state home, and the port serialises writes to one file and finishes each one
 *      durably before it resolves): a concurrent writer is either finished and durable, or not yet writing, and a
 *      crashed one is a dead process that cannot race.
 *
 * REPLAY DURABILITY IS NOT FREE EITHER. An idempotent replay that finds byte-identical artifacts has proved
 * only that they are VISIBLE, which is exactly what a page cache provides before a power loss, and the port has no
 * "flush what is there" call. So {@link TransferArtifactDurability.proveDurable} reads and proves the WHOLE set
 * first (nothing is written on a failed proof), then republishes the very bytes it proved through the port —
 * making the replay durable by the same mechanism the first writer's was — and confirms the names. A caller that
 * cannot get that far publishes its own frozen bytes instead of vouching for a name whose contents it never read.
 *
 * ORDER IS BEHAVIOUR. Proofs run in the order given and `materialize` publishes in the order given: an
 * attachment publishes `original` and then `manifest.json`, so a loss between them leaves a target the
 * manifest-first replay reads as unmatched and rebuilds, never a manifest vouching for bytes that are not beside it.
 */

/**
 * One already-published artifact and what makes its bytes the plan's.
 *
 * The proof belongs to the CALLER: only it knows whether a manifest still carries every planned fact
 * or a brief is the document the frozen plan renders. This module owns durability, never meaning.
 */
export interface ReadableArtifact {
  /** The bytes under the artifact's name right now, or `undefined` when there is none. */
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly proves: (bytes: Uint8Array) => boolean;
}

/** An artifact that can also be published: `write` is atomic and durable when it resolves. */
export interface PublishableArtifact extends ReadableArtifact {
  readonly write: (bytes: Uint8Array) => Promise<void>;
}

/**
 * How many times a replay will re-prove after another writer substituted a name under it.
 *
 * One substitution is a race worth re-reading; a second means the caller should stop chasing another
 * writer and publish its own frozen bytes, which it can always do.
 */
const SUBSTITUTION_ATTEMPTS = 2;

const encoder = new TextEncoder();

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? encoder.encode(value) : value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** Publishes transfer artifacts so a caller's successful return survives power loss. */
export class TransferArtifactDurability {
  /**
   * The whole replay guarantee for a set of already-published artifacts: PROVE, REPUBLISH, CONFIRM.
   *
   * Each artifact is read and proved; only when EVERY one proves are the very bytes read written back through
   * the artifact's port, and each name is then confirmed to hold them. `false` means absent, mismatched, or
   * substituted twice over — a caller's cue to publish its own frozen bytes rather than keep chasing another writer.
   */
  async proveDurable(artifacts: readonly PublishableArtifact[]): Promise<boolean> {
    for (let attempt = 0; attempt < SUBSTITUTION_ATTEMPTS; attempt += 1) {
      const proved: Uint8Array[] = [];
      for (const artifact of artifacts) {
        const bytes = await this.prove(artifact);
        if (bytes === undefined) return false;
        proved.push(bytes);
      }
      for (const [index, artifact] of artifacts.entries()) await artifact.write(proved[index] as Uint8Array);
      if (await this.namesHold(artifacts, proved)) return true;
    }
    return false;
  }

  /**
   * Read-only proof of a set of artifacts: nothing is written, and no name is confirmed.
   *
   * For the caller that may only REFUSE drift. It has nothing to confirm because it is not vouching for
   * durability — it is deciding whether what is there right now matches the plan.
   */
  async proveVisible(artifacts: readonly ReadableArtifact[]): Promise<boolean> {
    for (const artifact of artifacts) if ((await this.prove(artifact)) === undefined) return false;
    return true;
  }

  /**
   * Publishes a whole artifact set and leaves every name durably holding this attempt's bytes, or throws.
   *
   * The loop is the answer to one race: another writer replacing a name between this call's write and its
   * return. When that happens the set is re-proved through {@link proveDurable}; only if that also loses the race
   * is the whole sequence retried, and after {@link SUBSTITUTION_ATTEMPTS} the call FAILS rather than returning a
   * guarantee it could not establish. Failing here leaves an import retryable; returning would let a receipt
   * advance in front of bytes nobody made durable.
   *
   * THE SET IS CONFIRMED AS A SET, and for more than one artifact that is not the same thing as each
   * publication confirming itself: an attachment publishes `original` and then `manifest.json`, and the
   * manifest's whole publication is a window in which the original's name can be replaced. So after every
   * artifact is published, every name is read once more against the bytes published for it.
   */
  async materialize(
    label: string,
    artifacts: readonly (PublishableArtifact & { readonly bytes: string | Uint8Array })[],
  ): Promise<void> {
    const published = artifacts.map(artifact => bytesOf(artifact.bytes));
    for (let attempt = 0; attempt < SUBSTITUTION_ATTEMPTS; attempt += 1) {
      for (const [index, artifact] of artifacts.entries()) await artifact.write(published[index] as Uint8Array);
      if (await this.namesHold(artifacts, published)) return;
      if (await this.proveDurable(artifacts)) return;
    }
    throw new Error(
      `the artifacts under ${label} were replaced by another writer while this attempt was ` +
        'publishing them, and neither publication nor re-proof could be confirmed; nothing may be ' +
        'recorded as imported on bytes this attempt did not make durable',
    );
  }

  /** Reads one already-published artifact; its bytes when they prove, `undefined` for "not there, or not what the plan says". */
  private async prove(artifact: ReadableArtifact): Promise<Uint8Array | undefined> {
    const bytes = await artifact.read();
    return bytes !== undefined && artifact.proves(bytes) ? bytes : undefined;
  }

  /** Whether every name still holds exactly the bytes that were published or proved for it. */
  private async namesHold(artifacts: readonly ReadableArtifact[], expected: readonly Uint8Array[]): Promise<boolean> {
    for (const [index, artifact] of artifacts.entries()) {
      const current = await artifact.read();
      if (current === undefined || !sameBytes(current, expected[index] as Uint8Array)) return false;
    }
    return true;
  }
}
