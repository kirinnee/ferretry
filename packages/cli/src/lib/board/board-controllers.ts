import {
  type BoardProject,
  type BoardProjectsResponse,
  type BoardTaskActionRequestInput,
  type BoardTaskResponse,
  formatTaskRef,
  type LaneSet,
  type TaskRef,
} from '@ferretry/protocol';
import { resolveBoardProject } from '../board-lanes/lane-request';
import { refuse } from '../tasks/errors';
import type { ITextFileReader } from '../tasks/ports';
import { explainingRefusals } from './board-refusal';
import {
  type BoardVerb,
  renderActed,
  renderBoard,
  renderBoardMarkdown,
  renderCard,
  type SessionNames,
} from './board-render';
import {
  type BoardCreateOptions,
  type BoardEditOptions,
  type BoardLinkOptions,
  type BoardViewOptions,
  buildAssignAction,
  buildBlockAction,
  buildBoardCreateRequest,
  buildBoardQuery,
  buildClarifyAction,
  buildDependAction,
  buildDropAction,
  buildEditAction,
  buildFileAction,
  buildFocusAction,
  buildLinkAction,
  buildMoveAction,
  buildNoteAction,
  buildOrderAction,
  buildRefileAction,
  buildReopenAction,
  buildUnblockAction,
  buildUndependAction,
  createPrLinks,
  requireCardRef,
} from './board-request';
import type { IBoardGateway, IBoardOutput, SessionDirectoryEntry } from './ports';

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

/** Every card a single `fy board` page asks for; a board longer than this says so rather than paging. */
const BOARD_PAGE = 500;

export const ALL_PROJECTS = 'all';

// ─── names ─────────────────────────────────────────────────────────────────────────────────────

/** How a session id reads on screen: its callsign when it has one, else the id. */
export function sessionNames(directory: readonly SessionDirectoryEntry[]): SessionNames {
  const byId = new Map(directory.map(entry => [entry.id, entry.callsign]));
  return id => byId.get(id) ?? id;
}

/** A typed session reference — a callsign (any case, with or without `@`) or a session id — to its id. */
export function resolveSessionRef(typed: string, directory: readonly SessionDirectoryEntry[]): string {
  const wanted = typed.trim().replace(/^@/u, '');
  if (wanted === '') refuse('name a session: a callsign or a session id');
  const folded = wanted.toLowerCase();
  const found =
    directory.find(entry => entry.id === wanted) ?? directory.find(entry => entry.callsign?.toLowerCase() === folded);
  return found?.id ?? refuse(`no session "${wanted}"; use a callsign (see \`fy ps\`) or a session id`);
}

/** A typed lane — its id or its name, any case — to the lane's id, against the board's own lane set. */
export function resolveLaneRef(laneSet: LaneSet | null, typed: string): string {
  const wanted = typed.trim();
  if (laneSet === null) return wanted;
  const folded = wanted.toLowerCase();
  const found =
    laneSet.lanes.find(lane => lane.id === wanted) ?? laneSet.lanes.find(lane => lane.name.toLowerCase() === folded);
  return (
    found?.id ??
    refuse(
      `no lane "${wanted}" on this board; lanes: ${laneSet.lanes.map(lane => `${lane.id} (${lane.name})`).join(', ')}`,
    )
  );
}

// ─── options ───────────────────────────────────────────────────────────────────────────────────

export interface BoardCommonOptions {
  readonly session?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface BoardViewFlags extends BoardViewOptions, BoardCommonOptions {
  readonly md?: boolean | undefined;
}

export interface TaskCreateFlags extends BoardCreateOptions, BoardCommonOptions {}

export interface TaskEditFlags extends BoardEditOptions, BoardCommonOptions {}

export interface TaskLinkFlags extends BoardLinkOptions, BoardCommonOptions {}

export interface TaskListShimFlags extends BoardCommonOptions {
  readonly all?: boolean | undefined;
  readonly kind?: string | undefined;
  readonly query?: string | undefined;
  readonly md?: boolean | undefined;
}

export interface BoardControllerDependencies {
  readonly gateway: IBoardGateway;
  readonly output: IBoardOutput;
  readonly files: ITextFileReader;
  readonly binary: string;
  /** `FY_SESSION_ID`: the ferret this process is, when it is one. */
  readonly environmentSessionId: string | undefined;
}

/**
 * `fy board` and the v2 `fy task` verbs. Each verb builds its request from the typed words (pure, in
 * `board-request`), resolves the names a person typed against the daemon's own lists, sends it, and prints
 * where the card stands afterwards.
 */
export class BoardController {
  constructor(private readonly deps: BoardControllerDependencies) {}

  private get gateway(): IBoardGateway {
    return this.deps.gateway;
  }

  private as(options: BoardCommonOptions): string | undefined {
    const typed = options.session?.trim();
    return typed !== undefined && typed !== '' ? typed : this.deps.environmentSessionId;
  }

  // ─── reading ─────────────────────────────────────────────────────────────────────────────────

  /** `fy board`: the board as text, lane by lane, closed hidden. */
  async board(options: BoardViewFlags): Promise<void> {
    const as = this.as(options);
    const listing = await this.gateway.projects(as);
    const directory = await this.gateway.sessions();
    if (options.mine === true && options.ferret !== undefined) refuse('pass --mine or --ferret, not both');
    if (options.mine === true && as === undefined) {
      refuse('--mine needs a session: run it inside a ferret (FY_SESSION_ID) or pass --session <id>');
    }
    const projectFlag = options.project?.trim();
    const wholeFleet = projectFlag?.toLowerCase() === ALL_PROJECTS;
    const scoped: BoardProject | undefined = wholeFleet
      ? undefined
      : projectFlag !== undefined && projectFlag !== ''
        ? resolveBoardProject(projectFlag, listing)
        : listing.projects.find(project => project.id === listing.current);
    const ferretId =
      options.mine === true
        ? as
        : options.ferret === undefined
          ? undefined
          : resolveSessionRef(options.ferret, directory);
    const query = { ...buildBoardQuery(options, { projectId: scoped?.id, ferretId }), limit: BOARD_PAGE };
    const response = await this.gateway.board(query);
    if (options.json === true) return this.deps.output.success(asJson(response));
    const names = sessionNames(directory);
    const label = scoped?.name ?? 'all projects';
    const render = options.md === true ? renderBoardMarkdown : renderBoard;
    this.deps.output.success(render(response, listing.projects, names, label));
  }

  /** `fy task show <id>`: one card in full. */
  async show(idText: string, options: BoardCommonOptions): Promise<void> {
    const ref = requireCardRef(idText);
    const { task, laneSet } = await this.gateway.task(ref.id);
    const children =
      task.rollup.children === 0
        ? []
        : (await this.gateway.board({ project: task.projectId, state: 'all', limit: BOARD_PAGE })).cards.filter(
            card => card.parent?.id === task.id,
          );
    if (options.json === true) return this.deps.output.success(asJson({ task, laneSet, children }));
    const names = sessionNames(await this.gateway.sessions());
    this.deps.output.success(renderCard(task, laneSet, children, names));
  }

  // ─── writing ─────────────────────────────────────────────────────────────────────────────────

  private async resolveBrief(options: BoardCreateOptions | BoardEditOptions): Promise<string | undefined> {
    const file = options.briefFile?.trim();
    if (file !== undefined && file !== '') {
      if (options.brief !== undefined) refuse('pass --brief or --brief-file, not both');
      return await this.deps.files.readText(file);
    }
    return options.brief;
  }

  private async perform(
    verb: BoardVerb,
    ref: TaskRef,
    options: BoardCommonOptions,
    request: BoardTaskActionRequestInput,
  ): Promise<BoardTaskResponse> {
    const response = await explainingRefusals({ binary: this.deps.binary }, async () => {
      return await this.gateway.act(this.as(options), ref.id, request);
    });
    await this.print(verb, response, options);
    return response;
  }

  private async print(verb: BoardVerb, response: BoardTaskResponse, options: BoardCommonOptions): Promise<void> {
    if (options.json === true) return this.deps.output.success(asJson(response));
    const names = sessionNames(await this.gateway.sessions());
    this.deps.output.success(renderActed(verb, response.task, response.laneSet, names));
  }

  /** `fy task create`: the card, then one `link` per `--pr` because a create has no field for them. */
  async create(titleWords: readonly string[], options: TaskCreateFlags): Promise<void> {
    const as = this.as(options);
    const prLinks = createPrLinks(options);
    const brief = (await this.resolveBrief(options)) ?? '';
    const listing: BoardProjectsResponse = await this.gateway.projects(as);
    const target: BoardProject | undefined =
      options.project === undefined
        ? listing.projects.find(project => project.id === listing.current)
        : resolveBoardProject(options.project, listing);
    const assignee =
      options.assignee === undefined ? null : resolveSessionRef(options.assignee, await this.gateway.sessions());
    const request = buildBoardCreateRequest(options, titleWords, {
      brief,
      projectId: options.project === undefined ? undefined : target?.id,
      assignee,
    });
    const created = await explainingRefusals({ binary: this.deps.binary, project: target?.name }, async () => {
      return await this.gateway.create(as, request);
    });
    let latest = created;
    const failed: string[] = [];
    for (const url of prLinks) {
      try {
        latest = await this.gateway.act(as, created.task.id, { action: 'link', pr: url });
      } catch (error) {
        failed.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.print('create', latest, options);
    for (const problem of failed) {
      this.deps.output.diagnostic(
        `${formatTaskRef(created.task)} was created but the PR link failed — ${problem}\nlink it again: ${this.deps.binary} task link ${formatTaskRef(created.task)} --pr <url>`,
      );
    }
    if (failed.length > 0) refuse(`${String(failed.length)} PR link(s) did not attach`);
  }

  async move(idText: string, laneText: string, options: BoardCommonOptions & { readonly reason?: string }) {
    const ref = requireCardRef(idText);
    const { laneSet } = await this.gateway.task(ref.id);
    await this.perform('move', ref, options, buildMoveAction(resolveLaneRef(laneSet, laneText), options.reason));
  }

  async focus(idText: string, options: BoardCommonOptions) {
    await this.perform('focus', requireCardRef(idText), options, buildFocusAction());
  }

  /**
   * `fy task skip "<why>"` (board-design.md §3.4): the calling session's work needs no card — chit-chat, or the
   * owner said not to track it — so the turn-end check stays quiet until the session takes a card.
   */
  async skip(why: readonly string[], options: BoardCommonOptions) {
    const reason = why.join(' ').trim();
    if (reason === '') refuse(`say why this work needs no card: ${this.deps.binary} task skip "<why>"`);
    const as = this.as(options);
    if (as === undefined) {
      refuse(`skip records why YOUR session has no card: run it from a ferret's pane, or pass --session <id>`);
    }
    const recorded = await explainingRefusals({ binary: this.deps.binary }, async () => {
      return await this.gateway.skip(as, { reason });
    });
    if (options.json === true) return this.deps.output.success(asJson(recorded));
    this.deps.output.success(
      `no card for this work — ${recorded.skip.reason}. The board check stays quiet until you take a card.`,
    );
  }

  async block(idText: string, why: readonly string[], options: BoardCommonOptions) {
    await this.perform('block', requireCardRef(idText), options, buildBlockAction(why));
  }

  async unblock(idText: string, options: BoardCommonOptions & { readonly reason?: string }) {
    await this.perform('unblock', requireCardRef(idText), options, buildUnblockAction(options.reason));
  }

  async depend(
    idText: string,
    dependency: string,
    options: BoardCommonOptions & { readonly until?: string; readonly override?: string },
  ) {
    await this.perform('depend', requireCardRef(idText), options, buildDependAction(dependency, options));
  }

  async undepend(idText: string, dependency: string, options: BoardCommonOptions & { readonly reason?: string }) {
    await this.perform('undepend', requireCardRef(idText), options, buildUndependAction(dependency, options.reason));
  }

  async drop(idText: string, options: BoardCommonOptions & { readonly reason?: string }) {
    await this.perform('drop', requireCardRef(idText), options, buildDropAction(options.reason));
  }

  async reopen(
    idText: string,
    options: BoardCommonOptions & {
      readonly to?: string;
      readonly ask?: string;
      readonly source?: string;
      readonly reason?: string;
    },
  ) {
    const ref = requireCardRef(idText);
    const { laneSet } = await this.gateway.task(ref.id);
    const to = options.to === undefined ? undefined : resolveLaneRef(laneSet, options.to);
    await this.perform('reopen', ref, options, buildReopenAction({ ...options, ...(to === undefined ? {} : { to }) }));
  }

  async clarify(idText: string, text: readonly string[], options: BoardCommonOptions & { readonly source?: string }) {
    await this.perform('clarify', requireCardRef(idText), options, buildClarifyAction(text, options.source));
  }

  async link(idText: string, options: TaskLinkFlags) {
    await this.perform('link', requireCardRef(idText), options, buildLinkAction(options));
  }

  async assign(idText: string, who: string | undefined, options: BoardCommonOptions & { readonly none?: boolean }) {
    const ref = requireCardRef(idText);
    if (options.none === true && who !== undefined) refuse('pass a session or --none, not both');
    if (options.none !== true && who === undefined) refuse('assign needs a session (callsign or id), or --none');
    const assignee = options.none === true ? null : resolveSessionRef(who as string, await this.gateway.sessions());
    await this.perform('assign', ref, options, buildAssignAction(assignee));
  }

  async note(idText: string, text: readonly string[], options: BoardCommonOptions) {
    await this.perform('note', requireCardRef(idText), options, buildNoteAction(text));
  }

  async order(idText: string, rank: string | undefined, options: BoardCommonOptions & { readonly none?: boolean }) {
    await this.perform('order', requireCardRef(idText), options, buildOrderAction(rank, options.none));
  }

  async file(
    idText: string,
    path: string,
    options: BoardCommonOptions & { readonly remove?: boolean; readonly reason?: string },
  ) {
    await this.perform('file', requireCardRef(idText), options, buildFileAction(path, options));
  }

  async edit(idText: string, options: TaskEditFlags) {
    const brief = await this.resolveBrief(options);
    await this.perform('edit', requireCardRef(idText), options, buildEditAction(options, brief));
  }

  async refile(
    idText: string,
    options: BoardCommonOptions & { readonly project?: string; readonly lane?: string; readonly reason?: string },
  ) {
    const ref = requireCardRef(idText);
    if (options.project === undefined) refuse('refile needs --project <name>: the board the card moves to');
    const target = resolveBoardProject(options.project, await this.gateway.projects(this.as(options)));
    const lane = options.lane === undefined ? undefined : resolveLaneRef(target.laneSet, options.lane);
    await this.perform(
      'refile',
      ref,
      options,
      buildRefileAction(target.id, {
        ...(lane === undefined ? {} : { lane }),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }),
    );
  }

  // ─── the v1 spellings ────────────────────────────────────────────────────────────────────────

  /** `fy task status <id> <status> --reason …` is retired: print the spelling that replaces it and fail. */
  retiredStatus(idText: string, status: string, reason: string | undefined): never {
    const id = shownId(idText);
    return refuse(
      [
        `\`${this.deps.binary} task status\` is retired: a task now moves between the lanes of its project's board.`,
        `use: ${this.deps.binary} task move ${id} <lane> --reason ${quoted(reason ?? `now ${status}`)}`,
        `see the lanes: ${this.deps.binary} board lanes show`,
      ].join('\n'),
    );
  }

  /** `fy task phase <id> <phase> --reason …` is retired in the same way. */
  retiredPhase(idText: string, phase: string, reason: string | undefined): never {
    const id = shownId(idText);
    return refuse(
      [
        `\`${this.deps.binary} task phase\` is retired: audit phases are lanes now.`,
        `use: ${this.deps.binary} task move ${id} <lane> --reason ${quoted(reason ?? `now ${phase}`)}`,
        `see the lanes: ${this.deps.binary} board lanes show`,
      ].join('\n'),
    );
  }

  /** Feedback has no lane of its own on the board; it is a note that says so. */
  async feedback(idText: string, text: readonly string[], options: BoardCommonOptions): Promise<void> {
    this.deps.output.diagnostic(
      `\`${this.deps.binary} task feedback\` is retired; recording it as a note: ${this.deps.binary} task note ${shownId(idText)} "feedback: …"`,
    );
    await this.note(idText, ['feedback:', ...text], options);
  }

  /** `fy task list` is `fy board --mine` (`--all` for everybody's), with a one-line notice. */
  async listShim(options: TaskListShimFlags): Promise<void> {
    const mine = options.all !== true;
    this.deps.output.diagnostic(
      `\`${this.deps.binary} task list\` is now \`${this.deps.binary} board ${mine ? '--mine' : '--project all'}\``,
    );
    await this.board({
      ...options,
      ...(mine ? { mine: true } : { project: ALL_PROJECTS }),
    });
  }
}

const quoted = (words: string): string => `"${words.replace(/"/gu, '\\"')}"`;

const shownId = (idText: string): string => {
  const parsed = requireCardRef(idText);
  return formatTaskRef(parsed);
};
