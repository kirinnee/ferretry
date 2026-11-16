import { ApiError, type ConfigPort } from '@ferretry/kernel/contract';
import { PACKS_CONFIG, type PacksFile, type RoutingFile } from '../../contract/index.ts';
import type { GuideWrite } from '../lib/cleanup/file.ts';

/**
 * Accept and Undo's one way to write `packs.yaml`: the kernel's config writer (`ConfigPort.write`), the same service
 * behind `PUT /v1/config/file`. So Gate's per-file rules apply unchanged — only Packs' own file can be named, an edit
 * that loosens, or adds a `${secret:NAME}` reference, is held for the owner and not put into effect here, a raw secret
 * is refused, and the comments in the file survive. This adapter adds nothing to what it may write: it sends ONE key
 * (`routing`), whole, and answers what the writer did.
 */
export class ConfigGuideWriter {
  constructor(private readonly config: Pick<ConfigPort, 'write' | 'etag' | 'file'>) {}

  /**
   * `packs.yaml` as in effect, with the etag a write is checked against. The etag is read FIRST: it is read from the
   * disk, and when the disk moved since the last reload it brings the reload with it, so the file read after it is the
   * one that etag names. The other order pairs a cached older file with a newer etag, and an accept would then keep
   * (and an undo restore) a prompt the owner had already saved over. A save that lands between the two reads makes the
   * write's `ifMatch` stale, and the write is refused, never applied.
   */
  async read(): Promise<{ readonly file: PacksFile; readonly etag: string }> {
    const etag = await this.config.etag(PACKS_CONFIG);
    return { file: this.config.file(PACKS_CONFIG) ?? {}, etag };
  }

  /** Writes the `routing` section (`undefined` takes it out), against `etag`; every other key is left as it is. */
  async write(routing: RoutingFile | undefined, etag: string): Promise<GuideWrite> {
    const outcome = await this.config.write(PACKS_CONFIG, undefined, { patch: { routing } }, { ifMatch: etag });
    switch (outcome.kind) {
      case 'written':
        return { kind: 'written' };
      case 'held':
        return { kind: 'held', sentences: outcome.sentences };
      case 'conflict':
        throw new ApiError(409, 'packs.yaml changed since it was last read; nothing was saved. Try again.', 'conflict');
      case 'refused':
        throw new ApiError(
          400,
          `packs.yaml was not changed: ${outcome.issues.map(issue => issue.message).join('; ') || outcome.reason}`,
          'invalid_request',
        );
    }
  }
}
