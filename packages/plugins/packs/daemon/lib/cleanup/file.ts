/**
 * WRITING AN ACCEPTED CLEAN-UP (docs/pack-mode.md § Clean up): accept and undo — each an edit of the `routing`
 * section of `packs.yaml`, through the configuration writer every editor uses (so it is checked like any other
 * edit); the rest of the file is kept as it is.
 *
 * An accept keeps the prompt it replaces, so ONE undo puts it back exactly — including "there was no prompt of
 * the owner's", which undoing restores by writing the file without one. A routing prompt only says which
 * model suits which work, so it never loosens anything and is never held.
 */
import type { Instant } from '@ferretry/std';
import type {
  PacksFile,
  PackRoutingAcceptRequest,
  PackRoutingWriteResult,
  ReplacedRouting,
  RoutingUndo,
} from '../../../contract/index.ts';

/** `packs.yaml` as the writer holds it, with the etag a write is checked against. */
export interface PacksFileText {
  readonly file: PacksFile;
  readonly etag: string;
}

export interface GuideFilePorts {
  read(): Promise<PacksFileText>;
  /** Writes through the configuration writer, against `etag`; throws when it does not check or moved. */
  write(file: PacksFile, etag: string): Promise<void>;
  replaced: {
    read(): Promise<ReplacedRouting | undefined>;
    write(value: ReplacedRouting | undefined): Promise<void>;
  };
  now(): string;
}

/** The file without the keys of the `routing` section named. */
const withoutRouting = (file: PacksFile, ...keys: readonly ('prompt' | 'suggested')[]): PacksFile => {
  const { routing, ...rest } = file;
  if (routing === undefined) return file;
  const kept = Object.fromEntries(Object.entries(routing).filter(([name]) => !keys.includes(name as 'prompt')));
  return Object.keys(kept).length === 0 ? rest : { ...rest, routing: kept };
};

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
    await this.ports.replaced.write({
      format: 1,
      text: file.routing?.prompt ?? null,
      savedAt: now as Instant,
      source: file.routing?.prompt === undefined ? 'default' : 'file',
    });
    await this.ports.write(
      {
        ...file,
        routing: {
          ...file.routing,
          prompt: request.prompt,
          suggested: { ...request.suggested, acceptedAt: now as Instant },
        },
      },
      etag,
    );
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
    const restored: PacksFile =
      kept.text === null
        ? withoutRouting(file, 'prompt', 'suggested')
        : { ...file, routing: { ...withoutRouting(file, 'suggested').routing, prompt: kept.text } };
    await this.ports.write(restored, etag);
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
