import {
  isAgendaHeader,
  type AgendaActionRequest,
  type AgendaClearAgentsResult,
  type AgendaId,
  type AgendaLink,
  type AgendaListSnapshot,
  agendaBriefRequiredProblems,
  DAEMON_FEATURES,
  formatTaskRef,
  parseTaskRef,
  type TaskRef,
  type WorkRelatedResponse,
} from '@ferretry/protocol';
import { DaemonFeaturesUnreadable } from '../daemon/features.ts';
import { patchYaml } from '../patch/document.ts';
import { listedMatches, type RelatedCheck } from '../work-search/related.ts';
import { type AnswerFlags, parseAnswer } from './answer.ts';
import {
  type BriefFile,
  type BriefFlags,
  composeAddRequest,
  composeEditRequest,
  type EditFlags,
  linkFlagNotices,
  parseBriefFile,
} from './brief.ts';
import {
  type AgendaCandidate,
  agendaCandidates,
  type CardTies,
  joinAdvice,
  joinPlan,
  renderCandidates,
  shellQuote,
  waysOut,
} from './candidates.ts';
import { type CardFlag, resolveCardFlag } from './card-flag.ts';
import type { IAgendaBriefInput, IAgendaCardTies, IAgendaGateway, IAgendaOutput, IAgendaPrompt } from './ports.ts';
import { agendaPatchDocument, composeAgendaPatch, parseAgendaPatch } from './patch.ts';
import { agendaReference, parseAgendaReference } from './reference.ts';
import {
  renderAgendaHistory,
  renderAgendaItem,
  renderAgendaList,
  renderAgendaMutation,
  renderRepliesSent,
  wasWithdrawn,
} from './render.ts';
import { newItemTabs, ownTabFlags, type TabFlags, tabFieldsOf, tabText } from './tab-flags.ts';
import { twoDecisionsWarning } from './two-decisions.ts';
import { parseNeededBy } from './when.ts';

/**
 * The daemon's features for the agenda's OPTIONAL probes, with a failed health read taken as "none reported". Lenient
 * on purpose, as it always was: each probe only drops an optional field (or the bulk clear) on an older daemon, and the
 * agenda call that follows still says what went wrong if the daemon really is down.
 */
const featuresOrNone = async (gateway: Pick<IAgendaGateway, 'features'>): Promise<readonly string[]> =>
  await gateway.features().catch((error: unknown) => {
    if (error instanceof DaemonFeaturesUnreadable) return [];
    throw error;
  });

/**
 * Refuses a new item that does not say what is going on and the facts around it: the owner reads it cold, so the premise
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
    `agenda add needs ${flags}: ${missing.join('; ')}. The owner reads the card cold, so say --premise "<what is going on>" --context "<the facts around it>"`,
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
export interface AgendaAddOptions
  extends AgendaCommandOptions,
    Omit<BriefFlags, 'neededBy' | 'task'>,
    CardFlag,
    Pick<TabFlags, 'whereFile' | 'tabFile'> {
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A JSON body with the same fields; `-` reads standard input. */
  readonly jsonFile?: string;
  /** A Markdown file for the body; `-` reads standard input. */
  readonly bodyFile?: string;
  /** `--offer-close`: the owner's tap may also close the card the item belongs to. */
  readonly offerClose?: boolean;
  /**
   * `--new "<why none fits>"`: open a new agenda although open ones were listed as candidates (search, check, then
   * open). The reason is required.
   */
  readonly new?: string;
  /** `--related <id>`: a card to tie the item to, or an agenda item to edit instead of raising a duplicate. */
  readonly related?: string;
}

/** `fy agenda patch <id> --file <f>`: the document, and `--now` as on edit. */
export interface AgendaPatchOptions extends AgendaCommandOptions {
  /** The YAML or JSON document; `-` (the default) reads standard input. */
  readonly file?: string;
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
}

/** Flags that reword an open item. */
export interface AgendaEditOptions extends AgendaCommandOptions, Omit<EditFlags, 'neededBy'>, TabFlags {
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A Markdown file for the new body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags of `fy agenda rest`: what the ferret is doing. */
export interface AgendaRestOptions extends AgendaCommandOptions {
  readonly why?: string;
}

/** Flags of `fy agenda log`: the ferret's words, and which of the owner's chat messages they go with. */
export interface AgendaLogOptions extends AgendaCommandOptions {
  /** `--reply`: the ferret's answer to what the owner said in chat; the item goes back to the owner's list. */
  readonly reply?: string;
  /** `--rest`: what the ferret is doing about it; the item rests as working. */
  readonly rest?: string;
  /** `--message`: the owner's message to log, by id (the latest by default). */
  readonly message?: string;
}

/** Flags of `fy agenda split`: the new item's writing, and the cards that go with it. */
export interface AgendaSplitOptions extends AgendaCommandOptions, Omit<BriefFlags, 'neededBy' | 'task'> {
  /** `--move-cards F12,F13`: cards of the item that move to the new one. */
  readonly moveCards?: string;
  /** A JSON body with the same fields as `add`; `-` reads standard input. */
  readonly jsonFile?: string;
  /** A Markdown file for the new item's body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags that tick or untick a step. */
export interface AgendaStepOptions extends AgendaCommandOptions {
  readonly undo?: boolean;
}

/** Flags that resolve an item. */
export interface AgendaResolveOptions extends AgendaCommandOptions, AnswerFlags {
  readonly note?: string;
  /** `done --reason`: why a question the owner has not answered is closed (recorded as the note). */
  readonly reason?: string;
}

/** Flags that surface an item. */
export interface AgendaSurfaceOptions extends AgendaCommandOptions {
  readonly why?: string;
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
}

/** Flags that clear a backlog in bulk. */
export interface AgendaClearOptions extends AgendaCommandOptions {
  /** `--agents`: every open item on the agent ferrets' boards. */
  readonly agents?: boolean;
  /** `--yes`: go ahead without asking. */
  readonly yes?: boolean;
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
    /** Asks `clear --agents` for its yes; absent, only `--yes` goes ahead. */
    private readonly prompt?: IAgendaPrompt,
    /** Asks the daemon whether a new item duplicates one; absent, adds are never checked. */
    private readonly related?: RelatedCheck,
    /** Reads what a named card depends on and blocks, so an agenda carrying one is listed first; absent, none is. */
    private readonly cardTies?: IAgendaCardTies,
  ) {}

  /** Said once on stderr by the deprecated `attention` spelling; stdout stays the command's own. */
  deprecatedAlias(): void {
    this.out.diagnostic(AGENDA_DEPRECATION);
  }

  async list(options: AgendaCommandOptions): Promise<void> {
    const snapshot = await this.gateway.snapshot(this.#target(options));
    this.#report(snapshot, options, () => renderAgendaList(snapshot, new Date(this.now()).toISOString()));
  }

  /** Prints one item, open or resolved; read-only, so a mistyped verb can never raise anything. */
  async show(
    reference: string,
    options: AgendaCommandOptions & { readonly tab?: string; readonly yaml?: boolean },
  ): Promise<void> {
    const id = parseAgendaReference(reference);
    const sessionId = this.#target(options);
    const snapshot = await this.gateway.snapshot(sessionId);
    const open = snapshot.items.find(item => item.id === id);
    const resolved = snapshot.resolved.find(item => item.id === id);
    const listed = open ?? resolved;
    const found =
      listed !== undefined && isAgendaHeader(listed) ? await this.gateway.readItem?.(sessionId, id) : listed;
    if (found === undefined) throw new Error(`no agenda item ${agendaReference(id)} in ${sessionId}`);
    if (options.tab !== undefined) {
      this.out.success(tabText(found, options.tab));
      return;
    }
    if (options.yaml === true) {
      this.out.success(
        patchYaml(agendaPatchDocument(found), [
          `${agendaReference(id)} — read every part, update what is out of date, then: fy agenda patch ${id} --file <this file>`,
          'a key present replaces the field, an absent key leaves it, null removes it; tabs by name',
        ]),
      );
      return;
    }
    this.out.success(
      options.json === true
        ? JSON.stringify(found, null, 2)
        : renderAgendaItem(found, new Date(this.now()).toISOString()),
    );
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

  async add(typed: readonly string[], given: AgendaAddOptions): Promise<void> {
    const [file, body] = await this.#inputs(given.jsonFile, given.bodyFile);
    const words = typed;
    const options = given;
    if (options.new !== undefined && options.new.trim() === '') {
      throw new Error('--new needs the reason no open agenda fits: --new "<why none fits>"');
    }
    const pointer = this.#relatedPointer(options);
    const flag = resolveCardFlag(words, pointer.card === undefined ? options : { ...options, task: pointer.card });
    const tabbed = await tabFieldsOf(options, options.where, path => this.#read(path), stdinCount(options));
    const tabs = newItemTabs(tabbed.tabEdits);
    const written = composeAddRequest(
      flag.words,
      {
        ...withoutBy(options),
        task: flag.todo,
        ...this.#neededBy(options.by),
        ...(body === undefined ? {} : { body }),
      },
      file,
    );
    const composed = {
      ...written,
      ...(tabbed.whereWeAre === undefined ? {} : { whereWeAre: tabbed.whereWeAre }),
      ...(tabs === undefined ? {} : { tabs: [...tabs] }),
    };
    requireBrief(composed);
    for (const notice of linkFlagNotices(options.link)) this.out.diagnostic(notice);
    if (composed.stage !== undefined || composed.whereWeAre !== undefined || composed.detail !== undefined) {
      await this.#requireChannel('--stage, --where and --detail');
    }
    if (tabs !== undefined) await this.#requireChannel('--tab-file', DAEMON_FEATURES.agendaTabs);
    if (pointer.item !== undefined) return await this.#editInstead(pointer.item, composed, options);
    const sessionId = this.#target(options);
    // The board is read first so the item just raised can be named by identity rather than guessed at
    // by matching its subject text — kteam's match reported the wrong id for two identical subjects. It is
    // also the caller's own agenda: the open candidates "search, check, then open" lists.
    const before = await this.gateway.snapshot(sessionId);
    const warning = twoDecisionsWarning(composed);
    if (warning !== undefined) this.out.diagnostic(warning);
    // A held configuration change is its own card: the owner's Allow applies that one change, so it joins nothing.
    // The Done button is sent later (only to a daemon that has it), but it is part of the ask the join analysis weighs.
    const asked = options.offerClose === true ? { ...composed, offerClose: true as const } : composed;
    if (composed.confirms === undefined && !(await this.#searchCheckOpen(before, asked, flag.card, options))) return;
    const carded = flag.card === undefined ? composed : await this.#withCard(composed, flag.card);
    const offered = options.offerClose === true ? await this.#withOfferClose(carded) : carded;
    const request = await this.#withLinkMeanings(offered);
    const after = await this.gateway.apply(sessionId, request);

    const raised = onlyNewId(before, after);
    const verb = raised === undefined ? 'agenda item recorded' : `agenda ${agendaReference(raised)} recorded`;
    this.#report(after, options, () => renderAgendaMutation(verb, undefined, after, raised));
  }

  /**
   * SEARCH, CHECK, THEN OPEN (docs/agenda.md § One channel per topic): whether the add may open a new agenda. The open
   * agendas on the caller's own ledger are the candidates, closest first — one carrying the named card, or a card it
   * depends on or blocks, leads (dependent things share one agenda). With none, the add opens, after the daemon's
   * strong-duplicate check of everyone's work. With some, it needs `--new "<why none fits>"`; a person at a terminal is
   * asked "Should this join !A3?" instead, and a ferret is refused with the list and the two ways out. False: nothing
   * is to be opened, and what to do instead was said.
   */
  async #searchCheckOpen(
    own: AgendaListSnapshot,
    request: Extract<AgendaActionRequest, { action: 'add' }>,
    card: TaskRef | undefined,
    options: AgendaAddOptions,
  ): Promise<boolean> {
    const why = options.new?.trim() ?? '';
    const opening = why !== '';
    const binary = this.related?.binary ?? 'fy';
    // `--new` skips the refusal, never the discovery: the search runs and the open agendas are listed either way.
    // The daemon's related check is asked once: it ranks the candidates and catches a strong duplicate elsewhere.
    const related = await this.related?.matches(
      'agenda',
      request.title ?? request.subject,
      askOf(request),
      this.#actor(options),
    );
    const ties = card === undefined ? undefined : await this.#ties(card);
    const candidates = agendaCandidates(own.items, {
      sessionId: own.sessionId,
      title: request.title ?? request.subject,
      ask: askOf(request),
      related,
      ties,
    });
    const [closest] = candidates;
    if (closest === undefined) {
      // Nothing of the caller's own to join: only another ferret's (or a card's) strong duplicate stops the add.
      if (!opening && related !== undefined && card === undefined) await this.#refuseStrong(related, options);
      return true;
    }
    const listing = renderCandidates(candidates, {
      binary,
      request,
      named: card,
      ...(opening ? { opening: why } : {}),
    });
    // The listing goes to stderr when a new agenda is opened anyway, so `--json` still prints the raised snapshot alone.
    if (opening) {
      this.out.diagnostic(listing);
      return true;
    }
    if (options.json === true) {
      this.out.success(
        JSON.stringify(
          { candidates: candidates.map(candidateJson), related: related === undefined ? [] : listedMatches(related) },
          null,
          2,
        ),
      );
      throw new Error(
        'open agendas could take this; nothing was opened. Join one with agenda edit, or pass --new "<why none fits>"',
      );
    }
    if (this.prompt?.interactive() !== true) throw new Error(`${listing}\n\nNothing was opened.`);
    this.out.diagnostic(listing);
    const plan = joinPlan(binary, closest, request, card);
    if (await this.#confirmed(`Should this join ${agendaReference(closest.id)}?`)) {
      this.out.success(joinAdvice(binary, closest, plan));
      return false;
    }
    // Enter, no or anything else is not a yes: nothing is opened without a reason, so the two ways out are said.
    throw new Error(waysOut(binary, closest, plan));
  }

  /** What the named card depends on and blocks, or nothing when the board cannot say: the check never stops an add. */
  async #ties(card: TaskRef): Promise<CardTies | undefined> {
    const read = await this.cardTies?.ties(card).catch(() => undefined);
    return read === undefined ? undefined : { card, ...read };
  }

  /** The daemon's strong-duplicate refusal for work outside the caller's own agenda, with the ways out. */
  async #refuseStrong(related: WorkRelatedResponse, options: AgendaAddOptions): Promise<void> {
    if (this.related === undefined) return;
    const binary = this.related.binary;
    await this.related.refuseStrong(related, {
      as: this.#actor(options),
      json: options.json,
      choices: [
        `${binary} agenda add … --related A3   the match is yours: prints the ${binary} agenda edit that rewords it`,
        `${binary} agenda add … --related F12  tie it to a card instead of raising a new item`,
        `${binary} agenda add … --new "<why>"  it really is separate; raise it anyway`,
        `${binary} send <callsign> "…"         the match is another ferret's: ask them`,
      ],
    });
  }

  /** `--related`: a card (tie the item to it) or an agenda item (edit it instead); never both, never with `--new`. */
  #relatedPointer(options: AgendaAddOptions): { card?: string; item?: AgendaId } {
    const typed = options.related?.trim() ?? '';
    if (typed === '') return {};
    if (options.new !== undefined) throw new Error('pass --new or --related <id>, not both');
    if (parseTaskRef(typed).ok) {
      if (typeof options.task === 'string') throw new Error('pass --task <card> or --related <card>, not both');
      return { card: typed };
    }
    return { item: parseAgendaReference(typed) };
  }

  /** `--related A3`: nothing is raised. Your own item gets the `edit` that rewords it; another ferret's is theirs to change. */
  async #editInstead(
    id: AgendaId,
    request: Extract<AgendaActionRequest, { action: 'add' }>,
    options: AgendaAddOptions,
  ): Promise<void> {
    const sessionId = this.#target(options);
    const reference = agendaReference(id);
    const binary = this.related?.binary ?? 'fy';
    if ((await this.gateway.snapshot(sessionId)).items.some(item => item.id === id)) {
      const title = request.title === undefined ? '' : ` --title ${shellQuote(request.title)}`;
      this.out.success(
        `${reference} is already yours, so nothing was raised. Reword it instead:\n${binary} agenda edit ${id}${title} --summary ${shellQuote(request.subject)}`,
      );
      return;
    }
    const owner = await this.related?.agendaOwner(id, this.#actor(options));
    if (owner === undefined) throw new Error(`no agenda item ${reference} in your agenda; nothing was raised`);
    throw new Error(
      `${reference} belongs to ${owner.callsign}, so it is theirs to change and nothing was raised. Ask them: ${binary} send ${owner.callsign} "<what to change>"`,
    );
  }

  /** The session the related check speaks as: the one the command runs inside, else the one `--session` names. */
  #actor(options: AgendaCommandOptions): string | undefined {
    const typed = options.session?.trim() ?? '';
    return typed !== '' ? typed : this.ownSessionId?.trim() || undefined;
  }

  async edit(reference: string, options: AgendaEditOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const channel =
      options.stage !== undefined ||
      // `--where` collects, so it is an empty list when not given.
      (typeof options.where === 'string' ? options.where : (options.where ?? []).join('')).trim() !== '' ||
      options.detail !== undefined ||
      (options.whereFile?.trim() ?? '') !== '';
    if (channel) await this.#requireChannel('--stage, --where and --detail on edit');
    if (ownTabFlags(options)) {
      await this.#requireChannel('--tab-file, --rename-tab, --move-tab and --remove-tab', DAEMON_FEATURES.agendaTabs);
    }
    if (options.clearQuestionAnswer === true || options.kind !== undefined) {
      await this.#requireChannel('--kind and --clear-question-answer on edit', DAEMON_FEATURES.agendaAsks);
    }
    const sessionId = this.#target(options);
    const wording = (options.question ?? []).some(question => question.trim() !== '');
    const current = wording ? (await this.gateway.snapshot(sessionId)).items.find(item => item.id === id) : undefined;
    const [, body] = await this.#inputs(undefined, options.bodyFile);
    const tabbed = await tabFieldsOf(options, options.where, path => this.#read(path), stdinCount(options));
    const request = {
      ...composeEditRequest(
        id,
        { ...withoutBy(options), ...this.#neededBy(options.by), ...(body === undefined ? {} : { body }) },
        current,
      ),
      ...(tabbed.whereWeAre === undefined ? {} : { whereWeAre: tabbed.whereWeAre }),
      ...(tabbed.tabEdits === undefined ? {} : { tabEdits: [...tabbed.tabEdits] }),
    };
    for (const notice of linkFlagNotices(options.link)) this.out.diagnostic(notice);
    const snapshot = await this.gateway.apply(sessionId, {
      ...(await this.#withLinkMeanings(request)),
      ...(options.now === true ? { now: true as const } : {}),
    });
    this.#report(snapshot, options, () => renderAgendaMutation('edited', agendaReference(id), snapshot, id));
  }

  /**
   * PATCH an open item as ONE document (docs/agenda.md § Patch): YAML or JSON, merge-patch semantics, tabs by name.
   * The CLI compares it with the item as it stands and sends ONE `edit` carrying what differs, so it is all or nothing
   * and keeps every rule `edit` keeps; a document that changes nothing sends nothing.
   */
  async patch(reference: string, options: AgendaPatchOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const path = text(options.file) ?? '-';
    const source = path === '-' ? 'the patch on standard input' : path;
    const parsed = parseAgendaPatch(await this.#read(path), source);
    if (!parsed.ok) {
      throw new Error(
        `agenda patch ${id} changed nothing:\n${parsed.problems.map(problem => `  ${problem}`).join('\n')}`,
      );
    }
    // A patch names its revision, rewrites the why line or clears with null: all three need `agenda.patch.1`.
    await this.#requireChannel('agenda patch', DAEMON_FEATURES.agendaPatch);
    const sessionId = this.#target(options);
    const item = (await this.gateway.snapshot(sessionId)).items.find(each => each.id === id);
    if (item === undefined) throw new Error(`no open agenda item ${agendaReference(id)} in ${sessionId}`);
    const plan = composeAgendaPatch(item, parsed.patch, typed => parseNeededBy(typed, this.now(), 'neededBy'));
    if (plan.kind === 'stale') {
      throw new Error(
        `${agendaReference(id)} changed since you read it, so nothing was written: read it again (agenda show ${id} --yaml), update every part that is out of date, and patch it back`,
      );
    }
    if (plan.kind === 'unchanged') {
      this.out.success(`${agendaReference(id)}: nothing changed, so nothing was sent (every value matches the item)`);
      return;
    }
    const snapshot = await this.gateway.apply(sessionId, {
      ...(await this.#withLinkMeanings(plan.request)),
      ...(options.now === true ? { now: true as const } : {}),
    } as AgendaActionRequest);
    this.#report(snapshot, options, () => renderAgendaMutation('patched', agendaReference(id), snapshot, id));
  }

  /**
   * The ferret's ANSWER on an item (docs/agenda.md § States): shown above its ask, and an item resting on the
   * owner's reply goes back to their list in its old place. `edit --question-answer` sends the same request.
   */
  async answer(reference: string, words: readonly string[], options: AgendaCommandOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const said = text(words.join(' '));
    if (said === undefined) throw new Error(`say the answer: \`agenda answer ${id} "<text>"\``);
    const snapshot = await this.gateway.apply(
      this.#target(options),
      composeEditRequest(id, { questionAnswer: said }, undefined),
    );
    this.#report(snapshot, options, () => renderAgendaMutation('answered', agendaReference(id), snapshot, id));
  }

  /** The ferret takes an item on without asking anything yet: it rests as `working`, quiet, never nudged. */
  async rest(reference: string, options: AgendaRestOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const why = text(options.why);
    if (why === undefined) throw new Error(`say what you are doing: \`agenda rest ${id} --why "<what>"\``);
    await this.#requireChannel('taking an item on (agenda rest)');
    const snapshot = await this.gateway.apply(this.#target(options), { action: 'rest', id, why });
    this.#report(snapshot, options, () => renderAgendaMutation('resting (working)', agendaReference(id), snapshot, id));
  }

  /**
   * LOG what the owner said in chat onto the item (docs/agenda.md § Logging a chat). The owner's words are never typed
   * here: the daemon copies them from this session's own chat, so the item holds exactly what they wrote.
   */
  async log(reference: string, options: AgendaLogOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const reply = text(options.reply);
    const rest = text(options.rest);
    if ((reply === undefined) === (rest === undefined)) {
      throw new Error(
        `say one thing: \`agenda log ${id} --reply "<your answer>"\` (back to their list) or \`--rest "<what you are doing>"\``,
      );
    }
    await this.#requireChannel('logging a chat (agenda log)', DAEMON_FEATURES.agendaConversation);
    const messageId = text(options.message);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'log',
      id,
      mode: reply === undefined ? 'rest' : 'reply',
      text: reply ?? rest ?? '',
      ...(messageId === undefined ? {} : { messageId }),
    });
    this.#report(snapshot, options, () =>
      renderAgendaMutation(
        reply === undefined ? 'logged the chat and rested' : 'logged the chat and answered',
        agendaReference(id),
        snapshot,
        id,
      ),
    );
  }

  /** MERGE `from` into `id`: both conversations, every card and link are kept; `from` closes as merged. */
  async merge(reference: string, fromReference: string, options: AgendaCommandOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const from = parseAgendaReference(fromReference);
    await this.#requireChannel('merging items (agenda merge)', DAEMON_FEATURES.agendaConversation);
    const snapshot = await this.gateway.apply(this.#target(options), { action: 'merge', id, from });
    this.#report(snapshot, options, () =>
      renderAgendaMutation(`merged ${agendaReference(from)} into`, agendaReference(id), snapshot, id),
    );
  }

  /** SPLIT a new item off `id`: written as an add is, linked both ways, with the named cards moved to it. */
  async split(reference: string, words: readonly string[], options: AgendaSplitOptions): Promise<void> {
    const id = parseAgendaReference(reference);
    const [file, body] = await this.#inputs(options.jsonFile, options.bodyFile);
    const composed = composeAddRequest(words, { ...options, ...(body === undefined ? {} : { body }) }, file);
    requireBrief(composed);
    const {
      action: _action,
      source: _source,
      sourceRef: _sourceRef,
      confirms: _confirms,
      notice: _notice,
      ping: _ping,
      task: _task,
      offerClose: _offerClose,
      surface: _surface,
      ...item
    } = composed;
    const moveCards = (options.moveCards ?? '')
      .split(',')
      .map(each => each.trim())
      .filter(each => each !== '')
      .map(each => {
        const card = parseTaskRef(each);
        if (!card.ok) throw new Error(`--move-cards names cards like F12,F13, not "${each}"`);
        return card.value;
      });
    await this.#requireChannel('splitting an item (agenda split)', DAEMON_FEATURES.agendaConversation);
    const sessionId = this.#target(options);
    const before = await this.gateway.snapshot(sessionId);
    const after = await this.gateway.apply(sessionId, {
      action: 'split',
      id,
      item,
      ...(moveCards.length === 0 ? {} : { moveCards }),
    });
    const raised = onlyNewId(before, after);
    this.#report(after, options, () =>
      renderAgendaMutation(
        `split ${raised === undefined ? 'a new item' : agendaReference(raised)} off`,
        agendaReference(id),
        after,
        raised ?? id,
      ),
    );
  }

  /** Refuses, in words, before sending what a daemon without `feature` (the channel's, by default) would refuse. */
  async #requireChannel(what: string, feature: string = DAEMON_FEATURES.agendaChannel): Promise<void> {
    if (!(await featuresOrNone(this.gateway)).includes(feature)) {
      throw new Error(`this daemon is older than ${what}; update the daemon first (fy daemon update)`);
    }
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
    const note = text(options.reason) ?? text(options.note);
    const snapshot = await this.gateway.apply(this.#target(options), {
      action: 'resolve',
      id,
      ...(note === undefined ? {} : { note }),
      ...(response === undefined ? {} : { response }),
    });
    const closed = snapshot.resolved.find(item => item.id === id);
    const verb = closed !== undefined && wasWithdrawn(closed) ? 'withdrew the unanswered question' : 'resolved';
    this.#report(snapshot, options, () => renderAgendaMutation(verb, agendaReference(id), snapshot));
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

  /**
   * The owner clears the agent ferrets' backlog: every open item on every non-interactive session's board
   * is dismissed. Refused inside a ferret (`FY_SESSION_ID` set): the daemon refuses an agent too, but a
   * ferret should hear why before it asks. The count is shown and confirmed first unless `--yes`.
   */
  async clearAgents(options: AgendaClearOptions): Promise<void> {
    if (options.agents !== true) {
      throw new Error('say what to clear: `agenda clear --agents` clears every open item on the agent ferrets’ boards');
    }
    if ((this.ownSessionId?.trim() ?? '') !== '') {
      throw new Error(
        'only the owner can clear the agent ferrets’ agenda items — this is running inside a ferret session (FY_SESSION_ID is set); ask the owner to run it at their own shell',
      );
    }
    if (!(await featuresOrNone(this.gateway)).includes(DAEMON_FEATURES.agendaClearAgents)) {
      throw new Error('this daemon is older than clearing the agent ferrets’ agenda items; update the daemon first');
    }
    const found = await this.gateway.clearAgents(true);
    if (found.cleared === 0) {
      this.out.success('nothing to clear: the agent ferrets have no open agenda items');
      return;
    }
    if (options.yes !== true && !(await this.#confirmed(`Dismiss ${describeClear(found)}?`))) {
      this.out.success('Nothing was cleared.');
      return;
    }
    const done = await this.gateway.clearAgents(false);
    this.out.success(options.json === true ? JSON.stringify(done, null, 2) : `cleared ${describeClear(done)}`);
  }

  async #confirmed(question: string): Promise<boolean> {
    if (this.prompt?.interactive() !== true) {
      throw new Error('this needs a yes and nobody can be asked here: re-run with --yes to go ahead');
    }
    const answer = (await this.prompt.ask(`${question} [y/N]`)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
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

  /** A file a flag names (`-` is standard input). */
  async #read(path: string): Promise<string> {
    if (this.input === undefined) throw new Error(`${path} cannot be read here`);
    return await this.input.read(path);
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
    if ((await featuresOrNone(this.gateway)).includes(DAEMON_FEATURES.agendaTask)) return { ...request, task: card };
    this.out.diagnostic(
      `this daemon is older than agenda items tied to cards, so the item is raised without ${formatTaskRef(card)}; update the daemon to tie it`,
    );
    return request;
  }

  /**
   * The add with `offerClose`, sent only to a daemon that reports `agenda.offer-close.1`: an older one refuses
   * the whole add over the field, so the item is raised without the Done button there and the person is told.
   */
  async #withOfferClose(
    request: Extract<AgendaActionRequest, { action: 'add' }>,
  ): Promise<Extract<AgendaActionRequest, { action: 'add' }>> {
    if ((await featuresOrNone(this.gateway)).includes(DAEMON_FEATURES.agendaOfferClose)) {
      return { ...request, offerClose: true };
    }
    this.out.diagnostic(
      'this daemon is older than the Done button on agenda items, so the item is raised without it; update the daemon to offer it',
    );
    return request;
  }

  /**
   * The request with each link's `meaning` kept only for a daemon that reports `agenda.link-meaning.1`: an older one
   * refuses the whole request over the field, so its links go as `label=target` and the person is told.
   */
  async #withLinkMeanings<R extends { readonly links?: readonly AgendaLink[] | undefined }>(request: R): Promise<R> {
    if (request.links === undefined || !request.links.some(entry => entry.meaning !== undefined)) return request;
    if ((await featuresOrNone(this.gateway)).includes(DAEMON_FEATURES.agendaLinkMeaning)) return request;
    this.out.diagnostic(
      'could not confirm the daemon takes link meanings, so each link is sent as label=target without its meaning; update the daemon if it is older',
    );
    return {
      ...request,
      links: request.links.map(({ meaning: _meaning, ...rest }) => rest),
    };
  }

  /** Which session this invocation acts on. */
  #target(options: AgendaCommandOptions): string {
    const explicit = options.session?.trim() ?? '';
    if (explicit !== '') return explicit;
    const own = this.ownSessionId?.trim() ?? '';
    if (own !== '') return own;
    throw new Error('no session id — run inside a session or pass --session <id>');
  }

  #report(snapshot: AgendaListSnapshot, options: AgendaCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(snapshot, null, 2) : human());
  }
}

/** "3 open agenda items on 2 agent ferrets", in the number it is. */
function describeClear(result: AgendaClearAgentsResult): string {
  const items = result.cleared === 1 ? 'item' : 'items';
  const ferrets = result.sessions === 1 ? 'ferret' : 'ferrets';
  return `${result.cleared} open agenda ${items} on ${result.sessions} agent ${ferrets}`;
}

/** The ask the related check weighs: the one-line ask, and the why when it says more. */
const askOf = (request: Extract<AgendaActionRequest, { action: 'add' }>): string =>
  request.why === request.subject ? request.subject : `${request.subject}\n${request.why}`;

/** A candidate as `--json` prints it: what the listing says, without the whole item. */
const candidateJson = (candidate: AgendaCandidate) => ({
  id: candidate.id,
  title: candidate.title,
  state: candidate.state,
  cards: candidate.cards,
  ...(candidate.tie === undefined ? {} : { tie: candidate.tie }),
});

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
function onlyNewId(before: AgendaListSnapshot, after: AgendaListSnapshot): AgendaId | undefined {
  const known = new Set(before.items.map(item => item.id));
  const added = after.items.filter(item => !known.has(item.id));
  const [first] = added;
  return added.length === 1 ? first?.id : undefined;
}

/** How many of a command's `--json-file` and `--body-file` read standard input: the tab files may take one more. */
const stdinCount = (options: { readonly jsonFile?: string; readonly bodyFile?: string }): number =>
  [options.jsonFile, options.bodyFile].filter(path => path?.trim() === '-').length;
