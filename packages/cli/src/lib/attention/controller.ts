import { type AttentionId, type AttentionSnapshot, MAX_NOTIFICATION_BODY_LENGTH } from '@ferretry/protocol';
import { type AnswerFlags, parseAnswer } from './answer.ts';
import {
  type BriefFile,
  type BriefFlags,
  composeAddRequest,
  composeEditRequest,
  type EditFlags,
  parseBriefFile,
} from './brief.ts';
import type { IAttentionBriefInput, IAttentionGateway, IAttentionOutput } from './ports.ts';
import { attentionReference, parseAttentionReference } from './reference.ts';
import { renderAttentionHistory, renderAttentionList, renderAttentionMutation, renderNotification } from './render.ts';

/** Options every attention command accepts. */
export interface AttentionCommandOptions {
  /** Target another session's board; defaults to the session the command runs inside. */
  readonly session?: string;
  /** Emit the protocol payload verbatim instead of the human rendering. */
  readonly json?: boolean;
}

/** Flags that describe a new attention item, and where its JSON body is read from. */
export interface AttentionAddOptions extends AttentionCommandOptions, BriefFlags {
  /** A JSON body with the same fields; `-` reads standard input. */
  readonly jsonFile?: string;
}

/** Flags that reword an open item. */
export interface AttentionEditOptions extends AttentionCommandOptions, EditFlags {}

/** Flags that resolve an item. */
export interface AttentionResolveOptions extends AttentionCommandOptions, AnswerFlags {
  readonly note?: string;
}

/** Flags that shape a direct notification. */
export interface AttentionNotifyOptions extends AttentionCommandOptions {
  readonly title?: string;
  readonly kind?: string;
}

/**
 * Drives `fy attention …`.
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
  ) {}

  async list(options: AttentionCommandOptions): Promise<void> {
    const snapshot = await this.gateway.snapshot(this.#target(options));
    this.#report(snapshot, options, () => renderAttentionList(snapshot));
  }

  async history(options: AttentionCommandOptions): Promise<void> {
    const snapshot = await this.gateway.snapshot(this.#target(options));
    this.#report(snapshot, options, () => renderAttentionHistory(snapshot));
  }

  async add(words: readonly string[], options: AttentionAddOptions): Promise<void> {
    const request = composeAddRequest(words, options, await this.#briefFile(options.jsonFile));
    const sessionId = this.#target(options);

    // The board is read first so the item just raised can be named by identity rather than guessed at
    // by matching its subject text — kteam's match reported the wrong id for two identical subjects.
    const before = await this.gateway.snapshot(sessionId);
    const after = await this.gateway.apply(sessionId, request);

    const raised = onlyNewId(before, after);
    const verb = raised === undefined ? 'attention recorded' : `attention ${attentionReference(raised)} recorded`;
    this.#report(after, options, () => renderAttentionMutation(verb, undefined, after, raised));
  }

  async edit(reference: string, options: AttentionEditOptions): Promise<void> {
    const id = parseAttentionReference(reference);
    const sessionId = this.#target(options);
    const wording = (options.question ?? []).some(question => question.trim() !== '');
    const current = wording ? (await this.gateway.snapshot(sessionId)).items.find(item => item.id === id) : undefined;
    const snapshot = await this.gateway.apply(sessionId, composeEditRequest(id, options, current));
    this.#report(snapshot, options, () => renderAttentionMutation('edited', attentionReference(id), snapshot, id));
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

  async notify(words: readonly string[], options: AttentionNotifyOptions): Promise<void> {
    const body = words.join(' ').trim();
    if (body === '') throw new Error('notify needs the notification text');
    if (body.length > MAX_NOTIFICATION_BODY_LENGTH) {
      throw new Error(`a notification may not exceed ${MAX_NOTIFICATION_BODY_LENGTH} characters (got ${body.length})`);
    }
    const title = text(options.title);
    const kind = notificationKind(options.kind);
    const result = await this.gateway.notify(this.#target(options), {
      body,
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
    });
    this.out.success(options.json === true ? JSON.stringify(result, null, 2) : renderNotification(result.delivered));
  }

  /** The JSON body `--json-file` names, or none. */
  async #briefFile(path: string | undefined): Promise<BriefFile | undefined> {
    const named = text(path);
    if (named === undefined) return undefined;
    if (this.input === undefined) throw new Error('--json-file cannot be read here');
    return parseBriefFile(await this.input.read(named));
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

/** A trimmed flag value, or nothing when the flag was absent or blank. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

function notificationKind(value: string | undefined): 'completed' | 'failed' | undefined {
  const kind = text(value);
  if (kind === undefined) return undefined;
  if (kind !== 'completed' && kind !== 'failed') {
    throw new Error(`notify --kind must be completed or failed, not "${kind}"`);
  }
  return kind;
}

/** The single id present after a write and absent before it, if the write produced exactly one. */
function onlyNewId(before: AttentionSnapshot, after: AttentionSnapshot): AttentionId | undefined {
  const known = new Set(before.items.map(item => item.id));
  const added = after.items.filter(item => !known.has(item.id));
  const [first] = added;
  return added.length === 1 ? first?.id : undefined;
}
