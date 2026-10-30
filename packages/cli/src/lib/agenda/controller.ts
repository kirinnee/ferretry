import {
  type AgendaActionRequest,
  type AgendaId,
  type AgendaSnapshot,
  agendaBriefRequiredProblems,
  DAEMON_FEATURES,
  formatTaskRef,
  type TaskRef,
} from '@ferretry/protocol';
import { type AnswerFlags, parseAnswer } from './answer.ts';
import { type CardFlag, resolveCardFlag } from './card-flag.ts';
import {
  type BriefFile,
  type BriefFlags,
  composeAddRequest,
  composeEditRequest,
  type EditFlags,
  parseBriefFile,
} from './brief.ts';
import type { IAgendaBriefInput, IAgendaGateway, IAgendaOutput } from './ports.ts';
import { agendaReference, parseAgendaReference } from './reference.ts';
import {
  renderAgendaHistory,
  renderAgendaItem,
  renderAgendaList,
  renderAgendaMutation,
  renderRepliesSent,
} from './render.ts';
import { parseNeededBy } from './when.ts';

/**
 * Refuses a new item that does not say what is going on and why now: the owner reads it cold, so the premise
 * and the context are required (the daemon refuses too). A confirmation's premise is the daemon's own — the
 * held change, in its words — so only its context is asked for.
 */
const requireBrief = (request: Extract<AgendaActionRequest, { action: 'add' }>): void => {
  const missing = agendaBriefRequiredProblems({
    ...request,
    ...(request.confirms === undefined ? {} : { premise: 'the held change' }),
  });
  if (missing.length === 0) return;
  const flags = missing.map(problem => (problem.startsWith('premise') ? '--premise' : '--context')).join(' and ');
  throw new Error(
    `agenda add needs ${flags}: ${missing.join('; ')}. The owner reads the card cold, so say --premise "<what is going on>" --context "<why it matters now>"`,
  );
};

/** Options every agenda command accepts. */
export interface AgendaCommandOptions {
  /** Target another session's board; defaults to the session the command runs inside. */
  readonly session?: string;
  /** Emit the protocol payload verbatim instead of the human rendering. */
  readonly json?: boolean;
}

/** Flags that describe a new agenda item, and where its JSON body is read from. */
export interface AgendaAddOptions extends AgendaCommandOptions, Omit<BriefFlags, 'neededBy' | 'task'>, CardFlag {
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A JSON body with the same fields; `-` reads standard input. */
  readonly jsonFile?: string;
  /** A Markdown file for the body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags that reword an open item. */
export interface AgendaEditOptions extends AgendaCommandOptions, Omit<EditFlags, 'neededBy'> {
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A Markdown file for the new body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags that tick or untick a step. */
export interface AgendaStepOptions extends AgendaCommandOptions {
  readonly undo?: boolean;
}

/** Flags that resolve an item. */
export interface AgendaResolveOptions extends AgendaCommandOptions, AnswerFlags {
  readonly note?: string;
}

/** Flags that surface an item. */
export interface AgendaSurfaceOptions extends AgendaCommandOptions {
  readonly why?: string;
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
}

/** Flags that snooze an item: exactly one of them. */
export interface AgendaSnoozeOptions extends AgendaCommandOptions {
  /** `--for`: how long, as typed ("4h", "90m", "1d"). */
  readonly for?: string;
  /** `--until`: when it comes back, as typed (ISO, "in 3h", "17:00"). */
  readonly until?: string;
}

/** The one line the deprecated `fy attention` prints to stderr before it does what `fy agenda` does. */
export const AGENDA_DEPRECATION =
  '`fy attention` is now `fy agenda` — the same commands; `fy attention` will be removed.';

/**
 * Drives `fy agenda …` (and the deprecated `fy attention …`).
 *
 * Every verb defaults to the session the command runs inside, so an agent raising its own blocker
 * needs no id; `--session` targets another board for a human working the fleet. The daemon still
 * decides who may mutate what — this default is a convenience, not authority.
 */
export class AgendaController {
  constructor(
    private readonly gateway: IAgendaGateway,
    private readonly out: IAgendaOutput,
    private readonly ownSessionId: string | undefined,
    /** Reads `--json-file`; absent where no command can name one. */
    private readonly input?: IAgendaBriefInput,
    /** The clock `--by` reads relative and clock times against; injected so it is testable. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Said once on stderr by the deprecated `attention` spelling; stdout stays the command's own. */
  deprecatedAlias(): void {
    this.out.diagnostic(AGENDA_DEPRECATION);
  }

  async list(options: AgendaCommandOptions): Promise<void> {
    const snapshot = await this.gateway.snapshot(this.#target(options));
    this.#report(snapshot, options, () => renderAgendaList(snapshot));
  }

  /** Prints one item, open or resolved; read-only, so a mistyped verb can never raise anything. */
  async show(reference: string, options: AgendaCommandOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const sessionId = this.#target(options);
    const snapshot = await this.gateway.snapshot(sessionId);
    const open = snapshot.items.find(item => item.id === id);
    const resolved = snapshot.resolved.find(item => item.id === id);
    const found = open ?? resolved;
    if (found === undefined) throw new Error(`no agenda item ${agendaReference(id)} in ${sessionId}`);
    this.out.success(options.json === true ? JSON.stringify(found, null, 2) : renderAgendaItem(found));
  }

  async history(options: AgendaCommandOptions): Promise<void> {
    const snapshot = await this.gateway.snapshot(this.#target(options));
    this.#report(snapshot, options, () => renderAgendaHistory(snapshot));
  }

  /** Delivers the answers the daemon is holding for the ferret now, instead of after its settle window. */
  async sendNow(options: AgendaCommandOptions): Promise<void> {
    const sessionId = this.#target(options);
    const held = (await this.gateway.snapshot(sessionId)).replies?.pending ?? [];
    const after = await this.gateway.sendReplies(sessionId);
    this.#report(after, options, () => renderRepliesSent(held, sessionId));
  }

  async add(words: readonly string[], options: AgendaAddOptions): Promise<void> {
    const [file, body] = await this.#inputs(options.jsonFile, options.bodyFile);
    const flag = resolveCardFlag(words, options);
    const composed = composeAddRequest(
      flag.words,
      {
        ...withoutBy(options),
        task: flag.todo,
        ...this.#neededBy(options.by),
        ...(body === undefined ? {} : { body }),
      },
      file,
    );
    requireBrief(composed);
    const request = flag.card === undefined ? composed : await this.#withCard(composed, flag.card);
    const sessionId = this.#target(options);

    // The board is read first so the item just raised can be named by identity rather than guessed at
    // by matching its subject text — kteam's match reported the wrong id for two identical subjects.
    const before = await this.gateway.snapshot(sessionId);
    const after = await this.gateway.apply(sessionId, request);

    const raised = onlyNewId(before, after);
    const verb = raised === undefined ? 'agenda item recorded' : `agenda ${agendaReference(raised)} recorded`;
    this.#report(after, options, () => renderAgendaMutation(verb, undefined, after, raised));
  }

  async edit(reference: string, options: AgendaEditOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const sessionId = this.#target(options);
    const wording = (options.question ?? []).some(question => question.trim() !== '');
    const current = wording ? (await this.gateway.snapshot(sessionId)).items.find(item => item.id === id) : undefined;
    const [, body] = await this.#inputs(undefined, options.bodyFile);
    const request = composeEditRequest(
      id,
      { ...withoutBy(options), ...this.#neededBy(options.by), ...(body === undefined ? {} : { body }) },
      current,
    );
    const snapshot = await this.gateway.apply(sessionId, {
      ...request,
      ...(options.now === true ? { now: true as const } : {}),
    });
    this.#report(snapshot, options, () => renderAgendaMutation('edited', agendaReference(id), snapshot, id));
  }

  /** Ticks step `number` (counted from 1, as `ls` prints them) of an open item, or unticks it with `--undo`. */
  async step(reference: string, number: string, options: AgendaStepOptions): Promise<void> {
    const id = parseAgendaReference(reference);
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
      renderAgendaMutation(`${done ? 'ticked' : 'unticked'} step ${step} of`, agendaReference(id), snapshot),
    );
  }

  async resolve(reference: string, options: AgendaResolveOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const response = parseAnswer(options);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'resolve',
      id,
      ...(note === undefined ? {} : { note }),
      ...(response === undefined ? {} : { response }),
    });
    this.#report(snapshot, options, () => renderAgendaMutation('resolved', agendaReference(id), snapshot));
  }

  /** The owner asks the ferret that raised an item for more information. The item stays open, waiting on it. */
  async needsInfo(reference: string, options: AgendaResolveOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'needs-info',
      id,
      ...(note === undefined ? {} : { note }),
    });
    this.#report(snapshot, options, () =>
      renderAgendaMutation('asked for more information on', agendaReference(id), snapshot),
    );
  }

  /** The owner asks to talk an item through before answering. The item stays open, in discussion. */
  async discuss(reference: string, options: AgendaResolveOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'discuss',
      id,
      ...(note === undefined ? {} : { note }),
    });
    this.#report(snapshot, options, () => renderAgendaMutation('asked to discuss', agendaReference(id), snapshot));
  }

  /** Hands an item back to the owner: it is their turn again. Nothing pings. */
  async surface(reference: string, options: AgendaSurfaceOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const why = text(options.why);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'surface',
      id,
      ...(why === undefined ? {} : { why }),
      ...(options.now === true ? { now: true as const } : {}),
    });
    this.#report(snapshot, options, () => renderAgendaMutation('surfaced', agendaReference(id), snapshot));
  }

  /** The owner puts an item away for a while (`--for 4h`) or until a time (`--until 17:00`); it comes back fresh. */
  async snooze(reference: string, options: AgendaSnoozeOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const span = text(options.for);
    const at = text(options.until);
    if ((span === undefined) === (at === undefined)) {
      throw new Error('say how long or until when: --for <time> (like 4h) or --until <time> (like 17:00), not both');
    }
    const until =
      span === undefined
        ? parseNeededBy(at ?? '', this.now(), '--until')
        : parseNeededBy(`in ${span}`, this.now(), '--for');
    const snapshot = await this.gateway.apply(this.#target(options), { action: 'snooze', id, until });
    this.#report(snapshot, options, () =>
      renderAgendaMutation(`snoozed until ${until}`, agendaReference(id), snapshot),
    );
  }

  /** The owner brings a parked item (snoozed, or replied to) back to their list now. */
  async unsnooze(reference: string, options: AgendaCommandOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const snapshot = await this.gateway.apply(this.#target(options), { action: 'unsnooze', id });
    this.#report(snapshot, options, () => renderAgendaMutation('back on the list', agendaReference(id), snapshot));
  }

  async dismiss(reference: string, options: AgendaResolveOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const note = text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'dismiss',
      id,
      ...(note === undefined ? {} : { note }),
    });
    this.#report(snapshot, options, () => renderAgendaMutation('dismissed', agendaReference(id), snapshot));
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

  /**
   * The add with the card `--task` named, sent only to a daemon that reports `agenda.task.1`: an older one
   * refuses the whole add over the field, so the item is raised without it there and the person is told.
   */
  async #withCard(
    request: Extract<AgendaActionRequest, { action: 'add' }>,
    card: TaskRef,
  ): Promise<Extract<AgendaActionRequest, { action: 'add' }>> {
    if ((await this.gateway.features()).includes(DAEMON_FEATURES.agendaTask)) return { ...request, task: card };
    this.out.diagnostic(
      `this daemon is older than agenda items tied to cards, so the item is raised without ${formatTaskRef(card)}; update the daemon to tie it`,
    );
    return request;
  }

  /** Which session this invocation acts on. */
  #target(options: AgendaCommandOptions): string {
    const explicit = options.session?.trim() ?? '';
    if (explicit !== '') return explicit;
    const own = this.ownSessionId?.trim() ?? '';
    if (own !== '') return own;
    throw new Error('no session id — run inside a session or pass --session <id>');
  }

  #report(snapshot: AgendaSnapshot, options: AgendaCommandOptions, human: () => string): void {
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

/** The single id present after a write and absent before it, if the write produced exactly one. */
function onlyNewId(before: AgendaSnapshot, after: AgendaSnapshot): AgendaId | undefined {
  const known = new Set(before.items.map(item => item.id));
  const added = after.items.filter(item => !known.has(item.id));
  const [first] = added;
  return added.length === 1 ? first?.id : undefined;
}
