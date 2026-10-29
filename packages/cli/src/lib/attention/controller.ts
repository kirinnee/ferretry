import {
  ATTENTION_PUSH_TITLE_LENGTH,
  AttentionActionRequestSchema,
  type AttentionId,
  type AttentionSnapshot,
  clipAtWord,
  MAX_ATTENTION_SUBJECT_LENGTH,
} from '@ferretry/protocol';
import { type AnswerFlags, parseAnswer } from './answer.ts';
import {
  type BriefFile,
  type BriefFlags,
  composeAddRequest,
  composeEditRequest,
  type EditFlags,
  parseBriefFile,
  titleFrom,
} from './brief.ts';
import type { IAttentionBriefInput, IAttentionGateway, IAttentionOutput } from './ports.ts';
import { attentionReference, parseAttentionReference } from './reference.ts';
import {
  renderAttentionHistory,
  renderAttentionItem,
  renderAttentionList,
  renderAttentionMutation,
  renderRepliesSent,
} from './render.ts';
import { parseNeededBy } from './when.ts';

/** Options every attention command accepts. */
export interface AttentionCommandOptions {
  /** Target another session's board; defaults to the session the command runs inside. */
  readonly session?: string;
  /** Emit the protocol payload verbatim instead of the human rendering. */
  readonly json?: boolean;
}

/** Flags that describe a new attention item, and where its JSON body is read from. */
export interface AttentionAddOptions extends AttentionCommandOptions, Omit<BriefFlags, 'neededBy'> {
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A JSON body with the same fields; `-` reads standard input. */
  readonly jsonFile?: string;
  /** A Markdown file for the body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags that reword an open item. */
export interface AttentionEditOptions extends AttentionCommandOptions, Omit<EditFlags, 'neededBy'> {
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A Markdown file for the new body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags that tick or untick a step. */
export interface AttentionStepOptions extends AttentionCommandOptions {
  readonly undo?: boolean;
}

/** Flags that resolve an item. */
export interface AttentionResolveOptions extends AttentionCommandOptions, AnswerFlags {
  readonly note?: string;
}

/** Flags that surface an item. */
export interface AttentionSurfaceOptions extends AttentionCommandOptions {
  readonly why?: string;
}

/** Flags that shape an info card raised from a message. */
export interface AttentionNotifyOptions extends AttentionCommandOptions {
  readonly title?: string;
  readonly kind?: string;
  /** Ask for the owner's phone to buzz for this notice. */
  readonly ping?: boolean;
}

/** The one line the deprecated `fy attention` prints to stderr before it does what `fy agenda` does. */
export const ATTENTION_DEPRECATION =
  '`fy attention` is now `fy agenda` — the same commands; `fy attention` will be removed.';

/**
 * Drives `fy agenda …` (and the deprecated `fy attention …`).
 *
 * Every verb defaults to the session the command runs inside, so an agent raising its own blocker
 * needs no id; `--session` targets another board for a human working the fleet. The daemon still
 * decides who may mutate what — this default is a convenience, not authority.
 */
export class AttentionController {
  constructor(
    private readonly gateway: IAttentionGateway,
    private readonly out: IAttentionOutput,
    private readonly ownSessionId: string | undefined,
    /** Reads `--json-file`; absent where no command can name one. */
    private readonly input?: IAttentionBriefInput,
    /** The clock `--by` reads relative and clock times against; injected so it is testable. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Said once on stderr by the deprecated `attention` spelling; stdout stays the command's own. */
  deprecatedAlias(): void {
    this.out.diagnostic(ATTENTION_DEPRECATION);
  }

  async list(options: AttentionCommandOptions): Promise<void> {
    const snapshot = await this.gateway.snapshot(this.#target(options));
    this.#report(snapshot, options, () => renderAttentionList(snapshot));
  }

  /** Prints one item, open or resolved; read-only, so a mistyped verb can never raise anything. */
  async show(reference: string, options: AttentionCommandOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const sessionId = this.#target(options);
    const snapshot = await this.gateway.snapshot(sessionId);
    const open = snapshot.items.find(item => item.id === id);
    const resolved = snapshot.resolved.find(item => item.id === id);
    const found = open ?? resolved;
    if (found === undefined) throw new Error(`no agenda item ${attentionReference(id)} in ${sessionId}`);
    this.out.success(options.json === true ? JSON.stringify(found, null, 2) : renderAttentionItem(found));
  }

  async history(options: AttentionCommandOptions): Promise<void> {
    const snapshot = await this.gateway.snapshot(this.#target(options));
    this.#report(snapshot, options, () => renderAttentionHistory(snapshot));
  }

  /** Delivers the answers the daemon is holding for the ferret now, instead of after its settle window. */
  async sendNow(options: AttentionCommandOptions): Promise<void> {
    const sessionId = this.#target(options);
    const held = (await this.gateway.snapshot(sessionId)).replies?.pending ?? [];
    const after = await this.gateway.sendReplies(sessionId);
    this.#report(after, options, () => renderRepliesSent(held, sessionId));
  }

  async add(words: readonly string[], options: AttentionAddOptions): Promise<void> {
    const [file, body] = await this.#inputs(options.jsonFile, options.bodyFile);
    const request = composeAddRequest(
      words,
      { ...withoutBy(options), ...this.#neededBy(options.by), ...(body === undefined ? {} : { body }) },
      file,
    );
    const sessionId = this.#target(options);

    // The board is read first so the item just raised can be named by identity rather than guessed at
    // by matching its subject text — kteam's match reported the wrong id for two identical subjects.
    const before = await this.gateway.snapshot(sessionId);
    const after = await this.gateway.apply(sessionId, request);

    const raised = onlyNewId(before, after);
    const verb = raised === undefined ? 'agenda item recorded' : `agenda ${attentionReference(raised)} recorded`;
    this.#report(after, options, () => renderAttentionMutation(verb, undefined, after, raised));
  }

  async edit(reference: string, options: AttentionEditOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const sessionId = this.#target(options);
    const wording = (options.question ?? []).some(question => question.trim() !== '');
    const current = wording ? (await this.gateway.snapshot(sessionId)).items.find(item => item.id === id) : undefined;
    const [, body] = await this.#inputs(undefined, options.bodyFile);
    const snapshot = await this.gateway.apply(
      sessionId,
      composeEditRequest(
        id,
        { ...withoutBy(options), ...this.#neededBy(options.by), ...(body === undefined ? {} : { body }) },
        current,
      ),
    );
    this.#report(snapshot, options, () => renderAttentionMutation('edited', attentionReference(id), snapshot, id));
  }

  /** Ticks step `number` (counted from 1, as `ls` prints them) of an open item, or unticks it with `--undo`. */
  async step(reference: string, number: string, options: AttentionStepOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const step = Number(number.trim());
    if (!Number.isInteger(step) || step < 1) throw new Error(`a step number counts from 1, not "${number}"`);
    const done = options.undo !== true;
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'progress',
      id,
      step: step - 1,
      done,
    });
    this.#report(snapshot, options, () =>
      renderAttentionMutation(`${done ? 'ticked' : 'unticked'} step ${step} of`, attentionReference(id), snapshot),
    );
  }

  async resolve(reference: string, options: AttentionResolveOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const response = parseAnswer(options);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'resolve',
      id,
      ...(note === undefined ? {} : { note }),
      ...(response === undefined ? {} : { response }),
    });
    this.#report(snapshot, options, () => renderAttentionMutation('resolved', attentionReference(id), snapshot));
  }

  /** The owner asks the ferret that raised an item for more information. The item stays open, waiting on it. */
  async needsInfo(reference: string, options: AttentionResolveOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'needs-info',
      id,
      ...(note === undefined ? {} : { note }),
    });
    this.#report(snapshot, options, () =>
      renderAttentionMutation('asked for more information on', attentionReference(id), snapshot),
    );
  }

  /** The owner asks to talk an item through before answering. The item stays open, in discussion. */
  async discuss(reference: string, options: AttentionResolveOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'discuss',
      id,
      ...(note === undefined ? {} : { note }),
    });
    this.#report(snapshot, options, () =>
      renderAttentionMutation('asked to discuss', attentionReference(id), snapshot),
    );
  }

  /** Hands an item back to the owner: it is their turn again. Nothing pings. */
  async surface(reference: string, options: AttentionSurfaceOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const why = text(options.why);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'surface',
      id,
      ...(why === undefined ? {} : { why }),
    });
    this.#report(snapshot, options, () => renderAttentionMutation('surfaced', attentionReference(id), snapshot));
  }

  async dismiss(reference: string, options: AttentionResolveOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'dismiss',
      id,
      ...(note === undefined ? {} : { note }),
    });
    this.#report(snapshot, options, () => renderAttentionMutation('dismissed', attentionReference(id), snapshot));
  }

  /**
   * `notify` raises a notice: a plain notification with nothing to decide. The title is `--title` or the
   * start of the text, the subject is the text as one line, and a text that does not fit one line goes
   * whole into the context. `--ping` asks for the phone to buzz.
   */
  async notify(words: readonly string[], options: AttentionNotifyOptions): Promise<void> {
    refuseProgressKind(options.kind);
    const message = words.join(' ').trim();
    if (message === '') throw new Error('notify needs the notification text');
    const line = message.replaceAll(/\s+/gu, ' ');
    const fits = line.length <= MAX_ATTENTION_SUBJECT_LENGTH;
    const subject = fits ? line : clipAtWord(line, MAX_ATTENTION_SUBJECT_LENGTH);
    const title = titleFrom(text(options.title) ?? clipAtWord(line, ATTENTION_PUSH_TITLE_LENGTH));
    const request = AttentionActionRequestSchema.parse({
      action: 'add',
      source: 'agent-raised',
      sourceRef: null,
      subject,
      title,
      kind: 'info',
      why: subject,
      context: fits ? null : message,
      howToResolve: 'Nothing to do: it is a notice.',
      notice: true,
      ...(options.ping === true ? { ping: true } : {}),
    });
    const sessionId = this.#target(options);
    const before = await this.gateway.snapshot(sessionId);
    const after = await this.gateway.apply(sessionId, request);
    const raised = onlyNewId(before, after);
    const verb = raised === undefined ? 'notice sent' : `notice ${attentionReference(raised)} sent`;
    this.#report(after, options, () => renderAttentionMutation(verb, undefined, after, raised));
  }

  /** The JSON body and the Markdown body the flags name, each read once: standard input serves only one. */
  async #inputs(
    jsonPath: string | undefined,
    bodyPath: string | undefined,
  ): Promise<[BriefFile | undefined, string | undefined]> {
    if (text(jsonPath) === '-' && text(bodyPath) === '-') {
      throw new Error('--json-file and --body-file cannot both read standard input; give one a file');
    }
    const file = await this.#briefFile(jsonPath);
    const named = text(bodyPath);
    if (named === undefined) return [file, undefined];
    if (this.input === undefined) throw new Error('--body-file cannot be read here');
    return [file, await this.input.read(named)];
  }

  /** The JSON body `--json-file` names, or none. */
  async #briefFile(path: string | undefined): Promise<BriefFile | undefined> {
    const named = text(path);
    if (named === undefined) return undefined;
    if (this.input === undefined) throw new Error('--json-file cannot be read here');
    return parseBriefFile(await this.input.read(named));
  }

  /** `--by` read against the clock, as the request's `neededBy`; nothing when it was not given. */
  #neededBy(by: string | undefined): { neededBy?: string } {
    const typed = text(by);
    return typed === undefined ? {} : { neededBy: parseNeededBy(typed, this.now()) };
  }

  /** Which session this invocation acts on. */
  #target(options: AttentionCommandOptions): string {
    const explicit = options.session?.trim() ?? '';
    if (explicit !== '') return explicit;
    const own = this.ownSessionId?.trim() ?? '';
    if (own !== '') return own;
    throw new Error('no session id — run inside a session or pass --session <id>');
  }

  #report(snapshot: AttentionSnapshot, options: AttentionCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(snapshot, null, 2) : human());
  }
}

/** The options minus `--by`, which is read separately into `neededBy`. */
function withoutBy<T extends { readonly by?: string }>(options: T): Omit<T, 'by'> {
  const { by: _by, ...rest } = options;
  return rest;
}

/** A trimmed flag value, or nothing when the flag was absent or blank. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/** Progress and finishing never notify the owner; `--kind` once chose between them and now only says no. */
function refuseProgressKind(value: string | undefined): void {
  const kind = text(value);
  if (kind === undefined) return;
  if (kind === 'completed' || kind === 'failed') {
    throw new Error(
      'progress and finishing never notify the owner — raise an item (fy agenda add) only when they must decide or do something',
    );
  }
  throw new Error(`notify takes no --kind (it raises an info card), not "${kind}"`);
}

/** The single id present after a write and absent before it, if the write produced exactly one. */
function onlyNewId(before: AttentionSnapshot, after: AttentionSnapshot): AttentionId | undefined {
  const known = new Set(before.items.map(item => item.id));
  const added = after.items.filter(item => !known.has(item.id));
  const [first] = added;
  return added.length === 1 ? first?.id : undefined;
}
