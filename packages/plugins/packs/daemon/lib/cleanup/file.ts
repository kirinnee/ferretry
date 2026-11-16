/**
 * WRITING AN ACCEPTED CLEAN-UP (docs/pack-mode.md § Clean up): accept and undo — each an edit of the `routing`
 * section of `packs.yaml`, through the configuration writer every editor uses (so it is checked like any other
 * edit); the rest of the file is kept as it is.
 *
 * An accept keeps the prompt it replaces, so ONE undo puts it back exactly — including "there was no prompt of
 * the owner's", which undoing restores by writing the file without one. A routing prompt only says which
 * model suits which work, so it never loosens anything; the writer still holds an edit that adds a secret
 * reference (or sits beside one already held), and that is reported as held, never as applied.
 */
import type { Instant } from '@ferretry/std';
import type {
  PacksFile,
  PackRoutingAcceptRequest,
  PackRoutingWriteResult,
  ReplacedRouting,
  RoutingFile,
  RoutingUndo,
} from '../../../contract/index.ts';

/** `packs.yaml` as the writer holds it, with the etag a write is checked against. */
interface PacksFileText {
  readonly file: PacksFile;
  readonly etag: string;
}

/**
 * What the configuration writer did with an edit: `written` (in effect), or `held` (saved, but it waits for the
 * owner and the version in effect is unchanged; `sentences` say what waits). A stale etag or a refusal is thrown.
 */
export type GuideWrite =
  | { readonly kind: 'written' }
  | { readonly kind: 'held'; readonly sentences: readonly string[] };

export interface GuideFilePorts {
  read(): Promise<PacksFileText>;
  /**
   * Writes the `routing` section (`undefined` takes it out) through the configuration writer, against `etag`. Every
   * other key of the file is left as it is. Throws when the edit does not check or the file moved.
   */
  write(routing: RoutingFile | undefined, etag: string): Promise<GuideWrite>;
  replaced: {
    read(): Promise<ReplacedRouting | undefined>;
    write(value: ReplacedRouting | undefined): Promise<void>;
  };
  now(): string;
}

/** The section without the keys named; `undefined` when nothing is left, so the section is taken out. */
const withoutKeys = (
  routing: RoutingFile | undefined,
  ...keys: readonly ('prompt' | 'suggested')[]
): RoutingFile | undefined => {
  if (routing === undefined) return undefined;
  const kept = Object.fromEntries(Object.entries(routing).filter(([name]) => !keys.includes(name as 'prompt')));
  return Object.keys(kept).length === 0 ? undefined : (kept as RoutingFile);
};

/** What a held write says: it is saved, not in effect, and the owner confirms it. */
const heldMessage = (written: Extract<GuideWrite, { kind: 'held' }>, what: string): string =>
  `${what} waits for you to confirm it, so the routing prompt in effect has not changed${
    written.sentences.length === 0 ? '' : ` (${written.sentences.join('; ')})`
  }.`;

export class GuideFileService {
  constructor(private readonly ports: GuideFilePorts) {}

  /** What an undo would put back, for the view. */
  async undoable(): Promise<RoutingUndo | undefined> {
    const kept = await this.ports.replaced.read();
    return kept === undefined ? undefined : { savedAt: kept.savedAt, source: kept.source };
  }

  /** Writes the reviewed prompt and where it came from, keeping the prompt it replaces. */
  async accept(request: PackRoutingAcceptRequest): Promise<PackRoutingWriteResult> {
    const { file, etag } = await this.ports.read();
    const now = this.ports.now();
    const before = await this.ports.replaced.read();
    // Kept BEFORE the write, so a crash between the two never leaves an accepted prompt with nothing to undo it to; put
    // back as it was when the write is held or refused, because then nothing was replaced.
    await this.ports.replaced.write({
      format: 1,
      text: file.routing?.prompt ?? null,
      savedAt: now as Instant,
      source: file.routing?.prompt === undefined ? 'default' : 'file',
    });
    let written: GuideWrite;
    try {
      written = await this.ports.write(
        {
          ...file.routing,
          prompt: request.prompt,
          suggested: { ...request.suggested, acceptedAt: now as Instant },
        },
        etag,
      );
    } catch (error) {
      await this.ports.replaced.write(before);
      throw error;
    }
    if (written.kind === 'held') {
      await this.ports.replaced.write(before);
      return { outcome: 'held', message: heldMessage(written, 'The new routing prompt') };
    }
    return {
      outcome: 'applied',
      message: `The routing prompt is the one ${request.suggested.by} ${request.suggested.mode === 'generate' ? 'wrote' : 'cleaned up'}. Undo puts the previous one back.`,
    };
  }

  /** Puts back the prompt the last accept replaced; there is one undo, and it is used up. */
  async undo(): Promise<PackRoutingWriteResult> {
    const kept = await this.ports.replaced.read();
    if (kept === undefined) return { outcome: 'nothing', message: 'There is no accepted clean-up to undo.' };
    const { file, etag } = await this.ports.read();
    // No prompt before: everything an accept writes comes out again.
    const restored: RoutingFile | undefined =
      kept.text === null
        ? withoutKeys(file.routing, 'prompt', 'suggested')
        : { ...withoutKeys(file.routing, 'suggested'), prompt: kept.text };
    const written = await this.ports.write(restored, etag);
    // Held: the undo is not in effect and stays kept, so it can be tried again once the owner has answered.
    if (written.kind === 'held') return { outcome: 'held', message: heldMessage(written, 'The undo') };
    await this.ports.replaced.write(undefined);
    return {
      outcome: 'applied',
      message:
        kept.source === 'default'
          ? 'Undone: the default routing prompt, built from the model catalogs, is in effect again.'
          : 'Undone: the routing prompt you had before is back.',
    };
  }
}
