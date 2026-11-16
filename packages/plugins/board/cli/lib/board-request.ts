import type { z } from 'zod';
import {
  type BoardActivityFilter,
  BoardActivityFilterSchema,
  type BoardPrStateFilter,
  BoardPrStateFilterSchema,
  type BoardQueryInput,
  BoardQuerySchema,
  type BoardStateFilter,
  BoardStateFilterSchema,
  type BoardTerm,
  BoardTermsSchema,
  type CardActionRequest,
  CardActionRequestSchema,
  type CardCreateRequestInput,
  CardCreateRequestSchema,
  type CardKind,
  CardKindSchema,
  type CardRef,
  type CardVisibility,
  CardVisibilitySchema,
  DependencyUntilSchema,
  ExternalLaneTriggerSchema,
  parseCardRef,
  prUrlParts,
  type Progress,
  stripListMarker,
  toBullets,
  WorkflowSchema,
  AskIdTextSchema,
} from '../../contract/index.ts';
import { cardTitleIssue } from './card-title.ts';
import { refuse } from './errors.ts';

const describeIssues = (error: z.ZodError): string =>
  error.issues.map(issue => `${issue.path.length > 0 ? issue.path.join('.') : 'value'}: ${issue.message}`).join('; ');

const present = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
};

const requireChoice = <Value extends string>(value: string, allowed: readonly Value[], label: string): Value =>
  (allowed as readonly string[]).includes(value)
    ? (value as Value)
    : refuse(`${label} must be one of ${allowed.join(' | ')}, got "${value}"`);

/** Parse-don't-validate at the argv boundary: the wire schema is the one definition of a legal request. */
function parseOrRefuse<Output>(schema: z.ZodType<Output, unknown>, value: unknown, context: string): Output {
  const result = schema.safeParse(value);
  return result.success ? result.data : refuse(`${context}: ${describeIssues(result.error)}`);
}

// ─── references ────────────────────────────────────────────────────────────────────────────────

/** `&F412` and a bare `F412` all name the same card; anything else is refused. */
export function requireCardRef(value: string, label = 'card id'): CardRef {
  const parsed = parseCardRef(value);
  return parsed.ok ? parsed.value : refuse(`expected a ${label} like &F21, got "${value}"`);
}

// ─── terms ─────────────────────────────────────────────────────────────────────────────────────

/** `--term "x=meaning"` pairs into a glossary: the term is everything before the first `=`. */
export function parseTerms(entries: readonly string[]): BoardTerm[] {
  const terms = entries.map(entry => {
    const at = entry.indexOf('=');
    const term = entry.slice(0, at).trim();
    const meaning = entry.slice(at + 1).trim();
    if (at < 1 || term === '' || meaning === '')
      refuse(`--term takes term=meaning, with the term first; got "${entry}"`);
    return { term, meaning };
  });
  return parseOrRefuse(BoardTermsSchema, terms, '--term is not usable');
}

// ─── create ────────────────────────────────────────────────────────────────────────────────────

export interface BoardCreateOptions {
  readonly kind?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly ask?: string;
  readonly askSource?: string;
  readonly premise?: string | readonly string[];
  readonly context?: string | readonly string[];
  readonly term?: readonly string[];
  readonly brief?: string;
  readonly briefFile?: string;
  readonly howToTest?: string;
  readonly howToTestFile?: string;
  readonly workflow?: string;
  readonly dependsOn?: readonly string[];
  readonly parent?: string;
  /** The owner's Yes a card rests on where the board is off: an agenda item (`!A12`). */
  readonly approval?: string;
  /** The caller's own open agenda thread this card carries out (`!A12`): the card is then the ferret's own errand. */
  readonly thread?: string;
  readonly assignee?: string;
  readonly pr?: readonly string[];
  readonly branch?: string;
  readonly doc?: readonly string[];
  readonly file?: readonly string[];
  readonly project?: string;
  readonly lane?: string;
  /** `--private`: a card for the ferrets' own bookkeeping, off the default board. */
  readonly private?: boolean;
  /** `--public`: a card the owner sees on the default board. */
  readonly public?: boolean;
}

/** What the controller resolved before the pure part runs: the brief and test texts, the board and the assignee id. */
export interface BoardCreateResolved {
  readonly brief: string;
  /** Absent: none was given. */
  readonly howToTest?: string;
  readonly projectId: string | undefined;
  readonly assignee: string | null;
}

const trimmedAll = (values: readonly string[] | undefined): string[] =>
  (values ?? []).map(value => value.trim()).filter(value => value.length > 0);

/**
 * `--premise` / `--context` as the card stores them: one flag is its text, several are one bullet each. Absent
 * (never passed) is `undefined`; passed but blank is `''`, so an edit can clear the field.
 */
const singlePoint = (value: string): string => (/[\r\n]/u.test(value) ? value : stripListMarker(value));

const points = (value: string | readonly string[] | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const given = typeof value === 'string' ? [value] : value;
  if (given.length === 0) return undefined;
  const kept = trimmedAll(given);
  if (kept.length === 0) return '';
  return kept.length === 1 ? singlePoint(kept[0] as string) : toBullets(kept);
};

const requirePrUrl = (value: string): string =>
  prUrlParts(value) === null ? refuse(`--pr takes a GitHub pull request URL, got "${value}"`) : value;

/** The PR urls a create carries; the create request has no field for them, so they follow as link actions. */
export function createPrLinks(options: BoardCreateOptions): string[] {
  return trimmedAll(options.pr).map(requirePrUrl);
}

/** The ask `--approval` / `--thread` names, in any spelling `fy ask` takes (`!A12`, `?A12`, `A12`). */
const requireAgendaFlag = (flag: string, value: string): string => {
  const candidate = value.trim().replace(/^[?!]/u, '');
  const parsed = AskIdTextSchema.safeParse(candidate);
  return parsed.success
    ? parsed.data
    : refuse(`${flag}: "${value.trim()}" is not an ask reference — they look like !A3 (see \`fy ask list\`)`);
};

export function buildBoardCreateRequest(
  options: BoardCreateOptions,
  titleWords: readonly string[],
  resolved: BoardCreateResolved,
): CardCreateRequestInput {
  const kindFlag = present(options.kind) ?? refuse(`--kind is required (${CardKindSchema.options.join(', ')})`);
  const kind: CardKind = requireChoice(kindFlag, CardKindSchema.options, '--kind');

  const title = present(options.title) ?? titleWords.join(' ').trim();
  if (title.length === 0) refuse('--title is required (or pass the title as the trailing words)');
  const titleProblem = cardTitleIssue(title);
  if (titleProblem !== null) refuse(titleProblem);

  const askText = present(options.ask);
  const askSource = present(options.askSource);
  if (askText === undefined || askSource === undefined) {
    refuse('create requires --ask with the human words and --ask-source with the link they came from');
  }

  const workflow = requireChoice(present(options.workflow) ?? 'quick', WorkflowSchema.options, '--workflow');
  const parent = present(options.parent);
  const approval = present(options.approval);
  const thread = present(options.thread);
  const branch = present(options.branch);
  const lane = present(options.lane);
  if (options.private === true && options.public === true) refuse('pass --private or --public, not both');
  const visibility: CardVisibility | undefined =
    options.private === true ? 'private' : options.public === true ? 'public' : undefined;

  const candidate = {
    kind,
    title,
    summary: present(options.summary) ?? '',
    ask: { text: askText, source: askSource },
    premise: points(options.premise) ?? '',
    context: points(options.context) ?? '',
    terms: parseTerms(options.term ?? []),
    brief: resolved.brief,
    howToTest: resolved.howToTest ?? '',
    workflow,
    ...(resolved.projectId === undefined ? {} : { projectId: resolved.projectId }),
    ...(lane === undefined ? {} : { laneId: lane }),
    parent: parent === undefined ? null : requireCardRef(parent, '--parent id'),
    ...(approval === undefined ? {} : { approval: requireAgendaFlag('--approval', approval) }),
    ...(thread === undefined ? {} : { thread: requireAgendaFlag('--thread', thread) }),
    assignee: resolved.assignee,
    dependsOn: trimmedAll(options.dependsOn).map(value => ({ task: requireCardRef(value, '--depends-on id') })),
    files: trimmedAll(options.file),
    ...(branch === undefined ? {} : { branch }),
    docs: trimmedAll(options.doc),
    ...(visibility === undefined ? {} : { visibility }),
  };
  parseOrRefuse(CardCreateRequestSchema, candidate, 'cannot create this card');
  return candidate;
}

// ─── actions ───────────────────────────────────────────────────────────────────────────────────

const action = (candidate: unknown, context: string): CardActionRequest =>
  parseOrRefuse(CardActionRequestSchema, candidate, context);

const words = (value: readonly string[]): string => value.join(' ').trim();

export const buildMoveAction = (to: string, reason: string | undefined): CardActionRequest =>
  action({ action: 'move', to, ...(present(reason) === undefined ? {} : { reason: present(reason) }) }, 'cannot move');

/** An external event (a deploy finished, a review approved) reported for a card; the daemon moves the card if a lane waits on it. */
export function buildTriggerAction(event: string, reason?: string): CardActionRequest {
  const parsed = ExternalLaneTriggerSchema.safeParse(event.trim());
  if (!parsed.success) {
    refuse(`"${event}" is not an event you can report; one of ${ExternalLaneTriggerSchema.options.join(' | ')}`);
  }
  return action(
    { action: 'trigger', event: parsed.data, ...(present(reason) === undefined ? {} : { reason: present(reason) }) },
    'cannot report this event',
  );
}

export const buildFocusAction = (): CardActionRequest => ({ action: 'focus' });

export const buildBlockAction = (why: readonly string[]): CardActionRequest =>
  action({ action: 'block', reason: words(why) }, 'cannot block (say why)');

export const buildUnblockAction = (reason: string | undefined): CardActionRequest =>
  action(
    { action: 'unblock', ...(present(reason) === undefined ? {} : { reason: present(reason) }) },
    'cannot unblock',
  );

export function buildDependAction(
  dependency: string,
  options: { readonly until?: string; readonly override?: string },
): CardActionRequest {
  const until = requireChoice(present(options.until) ?? 'shipped', DependencyUntilSchema.options, '--until');
  const override = present(options.override);
  return action(
    {
      action: 'depend',
      task: requireCardRef(dependency, 'dependency id'),
      until,
      ...(override === undefined ? {} : { override: { reason: override } }),
    },
    'cannot depend',
  );
}

export const buildUndependAction = (dependency: string, reason: string | undefined): CardActionRequest =>
  action(
    {
      action: 'undepend',
      task: requireCardRef(dependency, 'dependency id'),
      reason: present(reason) ?? 'no longer a dependency',
    },
    'cannot remove the dependency',
  );

export const buildDropAction = (reason: string | undefined): CardActionRequest =>
  action({ action: 'drop', reason: present(reason) ?? '' }, 'cannot drop (--reason is required)');

/** Where a reopen's ask came from when the person did not say: it is still recorded as the owner's. */
export const DEFAULT_REOPEN_SOURCE = 'the owner (fy card reopen)';

export const buildReopenAction = (options: {
  readonly to?: string;
  readonly ask?: string;
  readonly source?: string;
  readonly reason?: string;
}): CardActionRequest => {
  const to = present(options.to) ?? refuse('reopen needs --to <lane>');
  const ask = present(options.ask) ?? refuse('reopen needs --ask "<the owner\'s new words>"');
  return action(
    {
      action: 'reopen',
      to,
      reason: present(options.reason) ?? 'reopened with a new ask',
      ask: { text: ask, source: present(options.source) ?? DEFAULT_REOPEN_SOURCE },
    },
    'cannot reopen',
  );
};

export const buildClarifyAction = (text: readonly string[], source: string | undefined): CardActionRequest =>
  action(
    { action: 'clarify', text: words(text), source: present(source) ?? refuse('clarify needs --source <link>') },
    'cannot clarify',
  );

export interface BoardLinkOptions {
  readonly pr?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly doc?: string;
}

export function buildLinkAction(options: BoardLinkOptions): CardActionRequest {
  const given = (['pr', 'branch', 'commit', 'doc'] as const).filter(field => present(options[field]) !== undefined);
  if (given.length !== 1) refuse('link takes exactly one of --pr, --branch, --commit or --doc');
  const field = given[0] as 'pr' | 'branch' | 'commit' | 'doc';
  const value = present(options[field]) as string;
  return action({ action: 'link', [field]: field === 'pr' ? requirePrUrl(value) : value }, 'cannot link');
}

export const buildAssignAction = (assignee: string | null): CardActionRequest =>
  action({ action: 'assign', assignee }, 'cannot assign');

/** `claim` names no one: the daemon takes the caller's own session from its credential. */
export const buildClaimAction = (): CardActionRequest => action({ action: 'claim' }, 'cannot claim');

/** `adopt` names no one either: the caller is the adopter, and `reason` (optional) is kept in the card's history. */
export const buildAdoptAction = (reason: string | undefined): CardActionRequest =>
  action({ action: 'adopt', ...(present(reason) === undefined ? {} : { reason: present(reason) }) }, 'cannot adopt');

export function buildReparentAction(
  parent: string | undefined,
  none: boolean | undefined,
  reason: string | undefined,
): CardActionRequest {
  if (none === true && present(parent) !== undefined) refuse('pass --parent <id> or --none, not both');
  const target =
    none === true ? null : requireCardRef(present(parent) ?? refuse('reparent needs --parent <id>, or --none'));
  return action(
    { action: 'reparent', parent: target, ...(present(reason) === undefined ? {} : { reason: present(reason) }) },
    'cannot reparent',
  );
}

export const buildNoteAction = (text: readonly string[]): CardActionRequest =>
  action({ action: 'note', text: words(text) }, 'cannot note (say something)');

export function buildOrderAction(rank: string | undefined, none: boolean | undefined): CardActionRequest {
  if (none === true) {
    if (present(rank) !== undefined) refuse('pass a rank or --none, not both');
    return action({ action: 'order', order: null }, 'cannot order');
  }
  const value = present(rank) ?? refuse('order needs a rank, or --none to clear it');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) refuse(`the rank must be a whole number, got "${value}"`);
  return action({ action: 'order', order: parsed }, 'cannot order');
}

export const buildFileAction = (
  path: string,
  options: { readonly remove?: boolean; readonly reason?: string },
): CardActionRequest =>
  action(
    {
      action: 'file',
      path: path.trim(),
      ...(options.remove === true ? { release: true } : {}),
      ...(present(options.reason) === undefined ? {} : { reason: present(options.reason) }),
    },
    'cannot claim the file',
  );

/** `--visibility public|private`, checked; absent when not given. */
export function visibilityOf(value: string | undefined): CardVisibility | undefined {
  const given = present(value);
  return given === undefined ? undefined : requireChoice(given, CardVisibilitySchema.options, '--visibility');
}

export interface BoardEditOptions {
  readonly title?: string;
  readonly summary?: string;
  readonly premise?: string | readonly string[];
  readonly context?: string | readonly string[];
  readonly term?: readonly string[];
  readonly brief?: string;
  readonly briefFile?: string;
  readonly howToTest?: string;
  readonly howToTestFile?: string;
  /** `public` or `private`: who sees the card on the default board. */
  readonly visibility?: string;
}

/**
 * The texts `--brief-file` and `--how-to-test-file` stand for, already read, because reading a file is IO.
 */
export interface BoardEditTexts {
  readonly progress?: Partial<Progress> | undefined;
  readonly brief?: string | undefined;
  readonly howToTest?: string | undefined;
}

const editFields = (options: BoardEditOptions, texts: BoardEditTexts) => {
  const terms = (options.term ?? []).length > 0 ? parseTerms(options.term ?? []) : undefined;
  const premise = points(options.premise);
  const context = points(options.context);
  const fields = {
    ...(options.title === undefined ? {} : { title: options.title.trim() }),
    ...(options.summary === undefined ? {} : { summary: options.summary.trim() }),
    ...(premise === undefined ? {} : { premise }),
    ...(context === undefined ? {} : { context }),
    ...(terms === undefined ? {} : { terms }),
    ...(texts.brief === undefined ? {} : { brief: texts.brief }),
    ...(texts.howToTest === undefined ? {} : { howToTest: texts.howToTest }),
    ...(texts.progress === undefined ? {} : { progress: texts.progress }),
  };
  return fields;
};

/** Terms replace the whole glossary. `--visibility` rides in the same action, so text and visibility are one change. */
export function buildEditAction(options: BoardEditOptions, texts: BoardEditTexts = {}): CardActionRequest {
  const fields = editFields(options, texts);
  const visibility = visibilityOf(options.visibility);
  if (Object.keys(fields).length === 0 && visibility === undefined) {
    refuse(
      'nothing to edit: pass --title, --summary, --premise, --context, --term, --brief, --brief-file, --how-to-test, --how-to-test-file or --visibility (the progress has its own verb: card progress)',
    );
  }
  if ('title' in fields && fields.title !== undefined) {
    const problem = cardTitleIssue(fields.title);
    if (problem !== null) refuse(problem);
  }
  return action({ action: 'edit', ...fields, ...(visibility === undefined ? {} : { visibility }) }, 'cannot edit');
}

export const buildRefileAction = (
  projectId: string,
  options: { readonly lane?: string; readonly reason?: string },
): CardActionRequest =>
  action(
    {
      action: 'refile',
      projectId,
      ...(present(options.lane) === undefined ? {} : { laneId: present(options.lane) }),
      ...(present(options.reason) === undefined ? {} : { reason: present(options.reason) }),
    },
    'cannot refile',
  );

// ─── the board query ───────────────────────────────────────────────────────────────────────────

export interface BoardViewOptions {
  readonly project?: string;
  readonly ferret?: string;
  readonly kind?: string;
  readonly pr?: string;
  readonly activity?: string;
  readonly state?: string;
  readonly closed?: boolean;
  readonly query?: string;
  readonly mine?: boolean;
  /** Show the private cards alone. */
  readonly private?: boolean;
  /** Show public and private cards. */
  readonly all?: boolean;
}

/** The project the board scopes to once names are resolved: an id, or every project (`undefined`). */
export interface BoardViewResolved {
  readonly projectId: string | undefined;
  readonly ferretId: string | undefined;
}

/**
 * The board shows public cards. `--private` shows the rest and `--all` shows both. A board scoped to one ferret
 * (`--mine`, `--ferret`) is that ferret's own work, so it shows both unless `--private` says otherwise.
 */
function boardVisibilityOf(options: BoardViewOptions, resolved: BoardViewResolved): 'public' | 'private' | undefined {
  if (options.private === true) return 'private';
  if (options.all === true || resolved.ferretId !== undefined) return undefined;
  return 'public';
}

/** The `--activity` choices: the board's filters (a card's asks ride the agenda, so there is no waiting filter). */
export const BOARD_ACTIVITY_CHOICES: readonly BoardActivityFilter[] = BoardActivityFilterSchema.options;

export function buildBoardQuery(options: BoardViewOptions, resolved: BoardViewResolved): BoardQueryInput {
  const kind = present(options.kind);
  const prState = present(options.pr);
  const activity = present(options.activity);
  const stateFlag = present(options.state);
  const state: BoardStateFilter | undefined =
    options.closed === true
      ? stateFlag === undefined || stateFlag === 'closed'
        ? 'closed'
        : refuse('--closed means --state closed; pass one of them')
      : stateFlag === undefined
        ? undefined
        : requireChoice(stateFlag, BoardStateFilterSchema.options, '--state');
  const query = present(options.query);
  if (options.private === true && options.all === true) refuse('pass --private or --all, not both');
  const visibility = boardVisibilityOf(options, resolved);
  const candidate = {
    ...(resolved.projectId === undefined ? {} : { project: resolved.projectId }),
    ...(resolved.ferretId === undefined ? {} : { ferret: resolved.ferretId }),
    ...(kind === undefined ? {} : { kind: requireChoice(kind, CardKindSchema.options, '--kind') }),
    ...(prState === undefined
      ? {}
      : { prState: requireChoice<BoardPrStateFilter>(prState, BoardPrStateFilterSchema.options, '--pr') }),
    ...(activity === undefined
      ? {}
      : { activity: requireChoice<BoardActivityFilter>(activity, BOARD_ACTIVITY_CHOICES, '--activity') }),
    ...(state === undefined ? {} : { state }),
    ...(query === undefined ? {} : { query }),
    ...(visibility === undefined ? {} : { visibility }),
  };
  parseOrRefuse(BoardQuerySchema, candidate, 'the board query is not usable');
  return candidate;
}

// ─── progress ──────────────────────────────────────────────────────────────────────────────────

/** The options of `fy card progress`: the parts it replaces, or a file holding all three. */
export interface BoardProgressOptions {
  readonly now?: string;
  readonly done?: string;
  readonly next?: string;
  /** YAML or JSON `{ now, doneSoFar, next }`; `-` reads standard input. */
  readonly file?: string;
}

/** `fy card progress`: the one edit that writes the parts named; the daemon merges them into the card's progress. */
export function buildProgressAction(progress: Partial<Progress> | undefined): CardActionRequest {
  if (progress === undefined || Object.keys(progress).length === 0) {
    refuse('nothing to write: pass --now, --done, --next or --file');
  }
  return action({ action: 'edit', progress }, 'cannot write the progress');
}
