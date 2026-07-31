import {
  type AttentionId,
  type AttentionSnapshot,
  MAX_ATTENTION_SUBJECT_LENGTH,
  MAX_NOTIFICATION_BODY_LENGTH,
} from '@ferretry/protocol';
import { type AnswerFlags, parseAnswer } from './answer.ts';
import { type AskFlags, parseAsk } from './ask.ts';
import type { IAttentionGateway, IAttentionOutput } from './ports.ts';
import { attentionReference, parseAttentionReference } from './reference.ts';
import { renderAttentionHistory, renderAttentionList, renderAttentionMutation, renderNotification } from './render.ts';

/** The default `howToResolve` when the raiser did not name a concrete action. */
const DEFAULT_HOW_TO_RESOLVE = 'Answer this item on the attention board (it records who answered).';

/** Options every attention command accepts. */
export interface AttentionCommandOptions {
  /** Target another session's board; defaults to the session the command runs inside. */
  readonly session?: string;
  /** Emit the protocol payload verbatim instead of the human rendering. */
  readonly json?: boolean;
}

/** Flags that describe a new attention item. */
export interface AttentionAddOptions extends AttentionCommandOptions, AskFlags {
  readonly why?: string;
  readonly context?: string;
  readonly resolve?: string;
}

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
    const subject = subjectFrom(words);
    const ask = parseAsk(options);
    const sessionId = this.#target(options);

    // The board is read first so the item just raised can be named by identity rather than guessed at
    // by matching its subject text — kteam's match reported the wrong id for two identical subjects.
    const before = await this.gateway.snapshot(sessionId);
    const after = await this.gateway.apply(sessionId, {
      action: 'add',
      source: 'agent-raised',
      sourceRef: null,
      subject,
      why: text(options.why) ?? subject,
      context: text(options.context) ?? null,
      howToResolve: text(options.resolve) ?? DEFAULT_HOW_TO_RESOLVE,
      ask,
    });

    const raised = onlyNewId(before, after);
    const verb = raised === undefined ? 'attention recorded' : `attention ${attentionReference(raised)} recorded`;
    this.#report(after, options, () => renderAttentionMutation(verb, undefined, after));
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

function subjectFrom(words: readonly string[]): string {
  const subject = words.join(' ').replaceAll(/\s+/gu, ' ').trim();
  if (subject === '') throw new Error('say what you need, or choose ls, done, dismiss, notify or history');
  if (subject.length > MAX_ATTENTION_SUBJECT_LENGTH) {
    throw new Error(
      `the ask must fit one line of ${MAX_ATTENTION_SUBJECT_LENGTH} characters (got ${subject.length}) — ` +
        'put the detail in --context',
    );
  }
  return subject;
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
