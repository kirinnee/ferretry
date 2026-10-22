/**
 * WRITING AN ACCEPTED GUIDE (docs/pack-mode.md § Suggesting a guide): accept, undo, and the owner's model
 * descriptions — each an edit of `models-guide.yaml` through the configuration writer every editor uses,
 * so it is checked like any other edit, and only the keys that change are rewritten (comments and key
 * order survive).
 *
 * An accept keeps the file it replaces, so ONE undo puts it back exactly — including "there was no guide
 * of the owner's", which undoing restores by writing the file without one. A guide only says which model
 * suits which work, so it never loosens anything and is never held.
 */
import { editConfigText, readConfigText } from '@ferretry/fleet/config-text';
import {
  configSchemaModeline,
  type GuideUndo,
  type ModelCatalogView,
  type ModelDescription,
  ModelsGuideFileSchema,
  type PackGuideAcceptRequest,
  type PackGuideDescribeRequest,
  type PackGuideWriteResult,
} from '@ferretry/protocol';

/** `models-guide.yaml` as the writer holds it. */
export interface GuideFileText {
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
}

/** The file an accept replaced: its text, or `null` for no file at all. */
export interface ReplacedGuide extends GuideUndo {
  readonly text: string | null;
}

export interface GuideFilePorts {
  read(): Promise<GuideFileText>;
  /** Writes through the configuration writer, against `etag`; throws when it does not check or moved. */
  write(text: string, etag: string): Promise<void>;
  replaced: { read(): Promise<ReplacedGuide | undefined>; write(value: ReplacedGuide | undefined): Promise<void> };
  catalogs(): Promise<readonly ModelCatalogView[]>;
  now(): string;
}

/** A description asked for a model no catalog lists, or a model two catalogs list under one id. */
export class GuideModelUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuideModelUnknownError';
  }
}

const MODELINE = configSchemaModeline({ kind: 'modelsGuide' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file's top-level mapping; a file that does not parse cannot be edited here and says so. */
function rawOf(file: GuideFileText): Record<string, unknown> {
  if (!file.exists) return {};
  const read = readConfigText(file.text);
  const value = read.ok ? (read.read.value ?? {}) : undefined;
  if (!isRecord(value)) throw new Error('models-guide.yaml does not parse; fix it in the Files panel first');
  return value;
}

const without = (record: Record<string, unknown>, ...keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => !keys.includes(name)));

export class GuideFileService {
  constructor(private readonly ports: GuideFilePorts) {}

  /** What an undo would put back, for the view. */
  async undoable(): Promise<GuideUndo | undefined> {
    const kept = await this.ports.replaced.read();
    return kept === undefined ? undefined : { savedAt: kept.savedAt, source: kept.source };
  }

  /** Writes the reviewed guide and where it came from, keeping the file it replaces. */
  async accept(request: PackGuideAcceptRequest): Promise<PackGuideWriteResult> {
    const file = await this.ports.read();
    const raw = rawOf(file);
    const now = this.ports.now();
    const target = {
      ...raw,
      useCases: request.useCases,
      ...(request.routing === undefined ? {} : { routing: request.routing }),
      suggested: { ...request.suggested, acceptedAt: now, ...(request.partial === true ? { partial: true } : {}) },
    };
    await this.ports.replaced.write({
      text: file.exists ? file.text : null,
      savedAt: now,
      source: raw.useCases === undefined ? 'derived' : 'file',
    });
    await this.ports.write(editConfigText(file.text, target, raw, MODELINE), file.etag);
    const count = request.useCases.length;
    return {
      outcome: 'applied',
      message: `The guide now has ${String(count)} use case${count === 1 ? '' : 's'}${request.routing === undefined ? '' : ' and its routing guidance'}, suggested by ${request.suggested.by}. Undo puts the previous one back.`,
    };
  }

  /** Puts back the file the last accept replaced; there is one undo, and it is used up. */
  async undo(): Promise<PackGuideWriteResult> {
    const kept = await this.ports.replaced.read();
    if (kept === undefined) return { outcome: 'nothing', message: 'There is no accepted suggestion to undo.' };
    const file = await this.ports.read();
    // No file before: everything an accept writes comes out again, and the owner's descriptions stay.
    const text =
      kept.text ??
      editConfigText(file.text, without(rawOf(file), 'useCases', 'routing', 'suggested'), rawOf(file), MODELINE);
    await this.ports.write(text, file.etag);
    await this.ports.replaced.write(undefined);
    return {
      outcome: 'applied',
      message:
        kept.source === 'derived'
          ? 'Undone: the guide built from the model catalogs is in effect again.'
          : 'Undone: the guide you had before is back.',
    };
  }

  /** Sets, or with `null` clears, the owner's description of one model. */
  async describe(request: PackGuideDescribeRequest): Promise<PackGuideWriteResult> {
    const { provider, model } =
      request.provider === undefined
        ? await this.resolve(request.model)
        : { provider: request.provider, model: request.model };
    const file = await this.ports.read();
    const raw = rawOf(file);
    const listed = ModelsGuideFileSchema.safeParse({ models: raw.models }).data?.models ?? [];
    const others = listed.filter(entry => !(entry.provider === provider && entry.model === model));
    const models: readonly ModelDescription[] =
      request.description === null ? others : [...others, { provider, model, description: request.description }];
    const target = models.length === 0 ? without(raw, 'models') : { ...raw, models };
    await this.ports.write(editConfigText(file.text, target, raw, MODELINE), file.etag);
    return {
      outcome: 'applied',
      message:
        request.description === null
          ? `${provider} ${model} is described by its catalog again.`
          : `Saved your description of ${provider} ${model}.`,
    };
  }

  /** The one catalog that lists `model` by id, else by label, and the id it lists it by. */
  private async resolve(model: string): Promise<{ readonly provider: string; readonly model: string }> {
    const rows = (await this.ports.catalogs()).flatMap(catalog =>
      [...(catalog.claude ?? []), ...(catalog.codex ?? [])].map(entry => ({ provider: catalog.id, entry })),
    );
    const byId = rows.filter(row => row.entry.id === model);
    const found = byId.length > 0 ? byId : rows.filter(row => row.entry.label.toLowerCase() === model.toLowerCase());
    const providers = [...new Set(found.map(row => row.provider))];
    const first = found[0];
    if (providers.length === 1 && first !== undefined) return { provider: first.provider, model: first.entry.id };
    throw new GuideModelUnknownError(
      providers.length === 0
        ? `No catalog lists ${model}.`
        : `${model} is listed by ${providers.join(', ')}; name the provider too.`,
    );
  }
}
