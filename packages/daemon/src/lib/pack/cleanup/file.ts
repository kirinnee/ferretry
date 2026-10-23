/**
 * WRITING AN ACCEPTED CLEAN-UP (docs/pack-mode.md § Clean up): accept and undo — each an edit of
 * `models-guide.yaml` through the configuration writer every editor uses, so it is checked like any other edit,
 * and only the keys that change are rewritten (comments and key order survive).
 *
 * An accept keeps the file it replaces, so ONE undo puts it back exactly — including "there was no prompt of
 * the owner's", which undoing restores by writing the file without one. A routing prompt only says which
 * model suits which work, so it never loosens anything and is never held.
 */
import { editConfigText, readConfigText } from '@ferretry/fleet/config-text';
import {
  configSchemaModeline,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  type RoutingUndo,
} from '@ferretry/protocol';

/** `models-guide.yaml` as the writer holds it. */
export interface GuideFileText {
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
}

/** The file an accept replaced: its text, or `null` for no file at all. */
export interface ReplacedGuide extends RoutingUndo {
  readonly text: string | null;
}

export interface GuideFilePorts {
  read(): Promise<GuideFileText>;
  /** Writes through the configuration writer, against `etag`; throws when it does not check or moved. */
  write(text: string, etag: string): Promise<void>;
  replaced: { read(): Promise<ReplacedGuide | undefined>; write(value: ReplacedGuide | undefined): Promise<void> };
  now(): string;
}

export const GUIDE_MODELINE = configSchemaModeline({ kind: 'modelsGuide' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file's top-level mapping; a file that does not parse cannot be edited here and says so. */
export function rawOf(file: GuideFileText): Record<string, unknown> {
  if (!file.exists) return {};
  const read = readConfigText(file.text);
  const value = read.ok ? (read.read.value ?? {}) : undefined;
  if (!isRecord(value)) throw new Error('models-guide.yaml does not parse; fix it in the Files panel first');
  return value;
}

export const without = (record: Record<string, unknown>, ...keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => !keys.includes(name)));

export class GuideFileService {
  constructor(private readonly ports: GuideFilePorts) {}

  /** What an undo would put back, for the view. */
  async undoable(): Promise<RoutingUndo | undefined> {
    const kept = await this.ports.replaced.read();
    return kept === undefined ? undefined : { savedAt: kept.savedAt, source: kept.source };
  }

  /** Writes the reviewed prompt and where it came from, keeping the file it replaces. */
  async accept(request: PackRoutingAcceptRequest): Promise<PackRoutingWriteResult> {
    const file = await this.ports.read();
    const raw = rawOf(file);
    const now = this.ports.now();
    const target = { ...raw, prompt: request.prompt, suggested: { ...request.suggested, acceptedAt: now } };
    await this.ports.replaced.write({
      text: file.exists ? file.text : null,
      savedAt: now,
      source: raw.prompt === undefined ? 'default' : 'file',
    });
    await this.ports.write(editConfigText(file.text, target, raw, GUIDE_MODELINE), file.etag);
    return {
      outcome: 'applied',
      message: `The routing prompt is the one ${request.suggested.by} cleaned up. Undo puts the previous one back.`,
    };
  }

  /** Puts back the file the last accept replaced; there is one undo, and it is used up. */
  async undo(): Promise<PackRoutingWriteResult> {
    const kept = await this.ports.replaced.read();
    if (kept === undefined) return { outcome: 'nothing', message: 'There is no accepted clean-up to undo.' };
    const file = await this.ports.read();
    // No file before: everything an accept writes comes out again.
    const text =
      kept.text ?? editConfigText(file.text, without(rawOf(file), 'prompt', 'suggested'), rawOf(file), GUIDE_MODELINE);
    await this.ports.write(text, file.etag);
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
