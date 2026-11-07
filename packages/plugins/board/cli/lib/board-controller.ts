import {
  type BoardProject,
  type CardActionRequestInput,
  type CardRef,
  type CardResponse,
  formatCardRef,
  type LaneSet,
} from '../../contract/index.ts';
import { mergeProgress, parseProgressFile, type ProgressParts } from './board-progress.ts';
import { explainingRefusals } from './board-refusal.ts';
import {
  type BoardVerb,
  renderActed,
  renderBoard,
  renderBoardMarkdown,
  renderCard,
  type FerretNames,
} from './board-render.ts';
import {
  type BoardCreateOptions,
  type BoardProgressOptions,
  type BoardEditOptions,
  type BoardEditTexts,
  type BoardLinkOptions,
  type BoardViewOptions,
  buildAdoptAction,
  buildAssignAction,
  buildBlockAction,
  buildBoardCreateRequest,
  buildBoardQuery,
  buildClaimAction,
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
  buildProgressAction,
  buildRefileAction,
  buildReopenAction,
  buildReparentAction,
  buildTriggerAction,
  buildUnblockAction,
  buildUndependAction,
  createPrLinks,
  requireCardRef,
} from './board-request.ts';
import { cardPatchDocument, composeCardPatch, parseCardPatch } from './card-patch.ts';
import { queuedLines } from './clash-notes.ts';
import { refuse } from './errors.ts';
import { resolveBoardProject } from './lane-request.ts';
import { patchYaml } from './patch-document.ts';
import type { BoardGateway, BoardOutput, FerretDirectoryEntry, TextFiles } from './ports.ts';
import type { RelatedCheck } from './related.ts';
import { SUB_CARD_ASK_WARNING, umbrellaRefusal, umbrellaSignals } from './umbrella.ts';

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

/** Every card a single `fy board` page asks for; a board longer than this says so rather than paging. */
const BOARD_PAGE = 500;
/** The most related cards a create lists beside a strong match. */
const MAX_RELATED_HITS = 5;

export const ALL_PROJECTS = 'all';

// ─── names ─────────────────────────────────────────────────────────────────────────────────────

/** How a ferret id reads on screen: its name when it has one, else the id. */
export function ferretNames(directory: readonly FerretDirectoryEntry[]): FerretNames {
  const byId = new Map(directory.map(entry => [entry.id, entry.name]));
  return id => byId.get(id) ?? id;
}

/** A typed ferret reference, a name (any case, with or without `@`) or an id, to its id. */
export function resolveFerretRef(typed: string, directory: readonly FerretDirectoryEntry[]): string {
  const wanted = typed.trim().replace(/^@/u, '');
  if (wanted === '') refuse('name a ferret: a name or an id');
  const folded = wanted.toLowerCase();
  const found =
    directory.find(entry => entry.id === wanted) ?? directory.find(entry => entry.name?.toLowerCase() === folded);
  return found?.id ?? refuse(`no ferret "${wanted}"; use a name (see \`fy ferret list\`) or an id`);
}

/** A typed lane, its id or its name, any case, to the lane's id, against the board's own lane set. */
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
  readonly json?: boolean | undefined;
}

export interface BoardViewFlags extends BoardViewOptions, BoardCommonOptions {
  readonly md?: boolean | undefined;
}

export interface CardCreateFlags extends BoardCreateOptions, BoardCommonOptions {
  /** Create even when the related-work check found a strong match. */
  readonly new?: boolean | undefined;
  /** A card to note instead of creating a new one. */
  readonly related?: string | undefined;
  /** `--broad "<why this must be one card>"`: create a card the umbrella check would refuse. */
  readonly broad?: string | undefined;
}

export interface CardEditFlags extends BoardEditOptions, BoardCommonOptions {}

/** `fy card patch`: the YAML or JSON document; `-` (the default) reads standard input. */
export interface CardPatchFlags extends BoardCommonOptions {
  readonly file?: string | undefined;
}

export interface CardProgressFlags extends BoardProgressOptions, BoardCommonOptions {}

export interface CardLinkFlags extends BoardLinkOptions, BoardCommonOptions {}

export interface BoardControllerDependencies {
  readonly gateway: BoardGateway;
  readonly output: BoardOutput;
  readonly files: TextFiles;
  readonly binary: string;
  /** The ferret this process is, when it is one (the shell's `FY_SESSION_ID`); `--mine` needs it. */
  readonly ownFerret: string | undefined;
  /** Asks the daemon whether a new card duplicates one; absent, creates are never checked. */
  readonly related?: RelatedCheck | undefined;
}

/**
 * `fy board` and the `fy card` verbs. Each verb builds its request from the typed words (pure, in `board-request`),
 * resolves the names a person typed against the daemon's own lists, sends it, and prints where the card stands
 * afterwards. A card never asks (#1552): there is no answer verb here.
 */
export class BoardController {
  constructor(private readonly deps: BoardControllerDependencies) {}

  private get gateway(): BoardGateway {
    return this.deps.gateway;
  }

  /** The ferret directory for names; a daemon that cannot list ferrets leaves ids as they are. */
  private async directory(): Promise<readonly FerretDirectoryEntry[]> {
    try {
      return await this.gateway.ferrets();
    } catch {
      return [];
    }
  }

  // ─── reading ─────────────────────────────────────────────────────────────────────────────────

  /** `fy board`: the board as text, lane by lane, closed hidden. */
  async board(options: BoardViewFlags): Promise<void> {
    const listing = await this.gateway.projects();
    if (options.mine === true && options.ferret !== undefined) refuse('pass --mine or --ferret, not both');
    if (options.mine === true && this.deps.ownFerret === undefined) {
      refuse('--mine needs a ferret: run it inside a ferret');
    }
    const projectFlag = options.project?.trim();
    const wholeFleet = projectFlag?.toLowerCase() === ALL_PROJECTS;
    const scoped: BoardProject | undefined = wholeFleet
      ? undefined
      : projectFlag !== undefined && projectFlag !== ''
        ? resolveBoardProject(projectFlag, listing)
        : listing.projects.find(project => project.id === listing.current);
    const directory = await this.directory();
    const ferretId =
      options.mine === true
        ? this.deps.ownFerret
        : options.ferret === undefined
          ? undefined
          : resolveFerretRef(options.ferret, directory);
    const query = { ...buildBoardQuery(options, { projectId: scoped?.id, ferretId }), limit: BOARD_PAGE };
    const response = await this.gateway.board(query);
    if (options.json === true) return this.deps.output.success(asJson(response));
    const names = ferretNames(directory);
    const label = scoped?.name ?? 'all projects';
    const render = options.md === true ? renderBoardMarkdown : renderBoard;
    this.deps.output.success(render(response, listing.projects, names, label));
    if (query.visibility === 'public') {
      this.deps.output.success(
        `public cards only: ${this.deps.binary} board --private shows the ferrets' own cards, --all shows both`,
      );
    }
  }

  /** `fy card show <id>`: one card in full. */
  async show(idText: string, options: BoardCommonOptions & { readonly yaml?: boolean }): Promise<void> {
    const ref = requireCardRef(idText);
    const { card, laneSet } = await this.gateway.card(ref.id);
    if (options.yaml === true) {
      const shown = formatCardRef(card);
      return this.deps.output.success(
        patchYaml(cardPatchDocument(card), [
          `${shown} — read every part, update what is out of date, then: ${this.deps.binary} card patch ${card.id} --file <this file>`,
          'a key present replaces the field, an absent key leaves it, null empties it',
        ]),
      );
    }
    const children =
      (card.rollup?.children ?? 0) === 0
        ? []
        : (await this.gateway.board({ project: card.projectId, state: 'all', limit: BOARD_PAGE })).cards.filter(
            each => each.parent?.id === card.id,
          );
    if (options.json === true) return this.deps.output.success(asJson({ card, laneSet, children }));
    const names = ferretNames(await this.directory());
    this.deps.output.success(renderCard(card, laneSet, children, names));
  }

  // ─── writing ─────────────────────────────────────────────────────────────────────────────────

  /** A text given inline or as a file (`--brief` / `--brief-file`, `--how-to-test` / `--how-to-test-file`). */
  private async resolveText(
    text: string | undefined,
    file: string | undefined,
    flag: 'brief' | 'how-to-test',
  ): Promise<string | undefined> {
    const path = file?.trim();
    if (path !== undefined && path !== '') {
      if (text !== undefined) refuse(`pass --${flag} or --${flag}-file, not both`);
      return await this.deps.files.readText(path);
    }
    return text;
  }

  private async resolveTexts(options: BoardCreateOptions | BoardEditOptions): Promise<BoardEditTexts> {
    return {
      brief: await this.resolveText(options.brief, options.briefFile, 'brief'),
      howToTest: await this.resolveText(options.howToTest, options.howToTestFile, 'how-to-test'),
    };
  }

  private async perform(
    verb: BoardVerb,
    ref: CardRef,
    options: BoardCommonOptions,
    request: CardActionRequestInput,
  ): Promise<CardResponse> {
    const response = await explainingRefusals({ binary: this.deps.binary }, async () => {
      return await this.gateway.act(ref.id, request);
    });
    await this.print(verb, response, options);
    return response;
  }

  private async print(verb: BoardVerb, response: CardResponse, options: BoardCommonOptions): Promise<void> {
    if (options.json === true) return this.deps.output.success(asJson(response));
    const names = ferretNames(await this.directory());
    this.deps.output.success(renderActed(verb, response.card, response.laneSet, names));
    // A claim that clashed with another card's queued this one behind it (docs/design/clash-queue.md): say so.
    if (verb === 'file' || verb === 'create') {
      for (const line of queuedLines(response.card))
        this.deps.output.diagnostic(`${formatCardRef(response.card)} ${line}`);
    }
  }

  /**
   * The checks of a create, before anything is made. `--related <card>` turns the create into a note on that card
   * (true: nothing is created). An umbrella card, many outcomes in one, is refused unless `--broad "<why>"` says why
   * it must be one (docs/board.md § One card, one outcome). Then the related cards are listed, weak matches too, with
   * `--related F12` offered so the work is added to one instead; a strong duplicate refuses; `--new` skips the check.
   */
  private async noteInsteadOfCreate(
    request: { readonly title: string; readonly summary?: unknown; readonly parent?: unknown },
    ask: string,
    options: CardCreateFlags,
  ): Promise<boolean> {
    const { title } = request;
    const related = options.related?.trim();
    if (options.new === true && related !== undefined && related !== '') {
      refuse('pass --new or --related <id>, not both');
    }
    if (related !== undefined && related !== '') {
      const ref = requireCardRef(related, '--related id');
      await this.perform(
        'note',
        ref,
        options,
        buildNoteAction([`Also asked, filed here instead of a new card: ${title} — ${ask}`]),
      );
      if (options.json !== true) this.deps.output.success(`Added to ${formatCardRef(ref)} instead of a new card`);
      return true;
    }
    const binary = this.deps.binary;
    const signals = umbrellaSignals({
      title,
      ...(typeof request.summary === 'string' ? { summary: request.summary } : {}),
      parent: request.parent,
    });
    if (signals.length > 0 && (options.broad?.trim() ?? '') === '') refuse(umbrellaRefusal(signals, binary));
    if (options.new === true || this.deps.related === undefined) return false;
    const response = await this.deps.related.matches(title, ask);
    if (response === undefined) return false;
    this.deps.related.refuseStrong(response, {
      json: options.json,
      choices: [
        `${binary} card new … --related F12   add this to that card as a note, creating nothing`,
        `${binary} card new … --new          it really is separate; create it anyway`,
      ],
    });
    // Nothing strong: the weaker matches are still worth a look, and adding to one beats a new card.
    const cards = response.matches.filter(match => match.hit.kind === 'card').slice(0, MAX_RELATED_HITS);
    if (cards.length > 0 && options.json !== true) {
      this.deps.output.diagnostic(
        [
          'Related cards — prefer adding to one (a note, nothing created):',
          ...this.deps.related.lines(cards).map(line => `  ${line}`),
          `  ${binary} card new … --related F12`,
        ].join('\n'),
      );
    }
    return false;
  }

  /** `fy card new`: the card, then one `link` per `--pr` because a create has no field for them. */
  async create(titleWords: readonly string[], options: CardCreateFlags): Promise<void> {
    const prLinks = createPrLinks(options);
    const texts = await this.resolveTexts(options);
    const listing = await this.gateway.projects();
    const target: BoardProject | undefined =
      options.project === undefined
        ? listing.projects.find(project => project.id === listing.current)
        : resolveBoardProject(options.project, listing);
    const assignee = options.assignee === undefined ? null : resolveFerretRef(options.assignee, await this.directory());
    const request = buildBoardCreateRequest(options, titleWords, {
      brief: texts.brief ?? '',
      howToTest: texts.howToTest ?? '',
      projectId: options.project === undefined ? undefined : target?.id,
      assignee,
    });
    if (await this.noteInsteadOfCreate(request, request.ask.text, options)) return;
    if (options.parent !== undefined && options.ask !== undefined && options.public !== true)
      this.deps.output.diagnostic(SUB_CARD_ASK_WARNING);
    const created = await explainingRefusals({ binary: this.deps.binary, project: target?.name }, async () => {
      return await this.gateway.create(request);
    });
    let latest = created;
    const failed: string[] = [];
    for (const url of prLinks) {
      try {
        latest = await this.gateway.act(created.card.id, { action: 'link', pr: url });
      } catch (error) {
        failed.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.print('create', latest, options);
    for (const problem of failed) {
      this.deps.output.diagnostic(
        `${formatCardRef(created.card)} was created but the PR link failed — ${problem}\nlink it again: ${this.deps.binary} card link ${formatCardRef(created.card)} --pr <url>`,
      );
    }
    if (failed.length > 0) refuse(`${String(failed.length)} PR link(s) did not attach`);
  }

  async move(idText: string, laneText: string, options: BoardCommonOptions & { readonly reason?: string }) {
    const ref = requireCardRef(idText);
    const { laneSet } = await this.gateway.card(ref.id);
    await this.perform('move', ref, options, buildMoveAction(resolveLaneRef(laneSet, laneText), options.reason));
  }

  async trigger(idText: string, event: string, options: BoardCommonOptions & { readonly reason?: string }) {
    await this.perform('trigger', requireCardRef(idText), options, buildTriggerAction(event, options.reason));
  }

  async focus(idText: string, options: BoardCommonOptions) {
    await this.perform('focus', requireCardRef(idText), options, buildFocusAction());
  }

  /**
   * `fy card skip "<why>"` (board-design.md §3.4): the calling ferret's work needs no card (chit-chat, or the owner
   * said not to track it), so the turn-end check stays quiet until the ferret takes a card.
   */
  async skip(why: readonly string[], options: BoardCommonOptions) {
    const reason = why.join(' ').trim();
    if (reason === '') refuse(`say why this work needs no card: ${this.deps.binary} card skip "<why>"`);
    const recorded = await explainingRefusals({ binary: this.deps.binary }, async () => {
      return await this.gateway.skip({ reason });
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
    const { laneSet } = await this.gateway.card(ref.id);
    const to = options.to === undefined ? undefined : resolveLaneRef(laneSet, options.to);
    await this.perform('reopen', ref, options, buildReopenAction({ ...options, ...(to === undefined ? {} : { to }) }));
  }

  async clarify(idText: string, text: readonly string[], options: BoardCommonOptions & { readonly source?: string }) {
    await this.perform('clarify', requireCardRef(idText), options, buildClarifyAction(text, options.source));
  }

  async link(idText: string, options: CardLinkFlags) {
    await this.perform('link', requireCardRef(idText), options, buildLinkAction(options));
  }

  async assign(idText: string, who: string | undefined, options: BoardCommonOptions & { readonly none?: boolean }) {
    const ref = requireCardRef(idText);
    if (options.none === true && who !== undefined) refuse('pass a ferret or --none, not both');
    if (options.none !== true && who === undefined) refuse('assign needs a ferret (name or id), or --none');
    const assignee = options.none === true ? null : resolveFerretRef(who as string, await this.directory());
    await this.perform('assign', ref, options, buildAssignAction(assignee));
  }

  async claim(idText: string, options: BoardCommonOptions) {
    await this.perform('claim', requireCardRef(idText), options, buildClaimAction());
  }

  async adopt(idText: string, options: BoardCommonOptions & { readonly reason?: string }) {
    await this.perform('adopt', requireCardRef(idText), options, buildAdoptAction(options.reason));
  }

  async note(idText: string, text: readonly string[], options: BoardCommonOptions) {
    await this.perform('note', requireCardRef(idText), options, buildNoteAction(text));
  }

  async order(idText: string, rank: string | undefined, options: BoardCommonOptions & { readonly none?: boolean }) {
    await this.perform('order', requireCardRef(idText), options, buildOrderAction(rank, options.none));
  }

  async reparent(
    idText: string,
    options: BoardCommonOptions & { readonly parent?: string; readonly none?: boolean; readonly reason?: string },
  ) {
    await this.perform(
      'reparent',
      requireCardRef(idText),
      options,
      buildReparentAction(options.parent, options.none, options.reason),
    );
  }

  async file(
    idText: string,
    path: string,
    options: BoardCommonOptions & { readonly remove?: boolean; readonly reason?: string },
  ) {
    await this.perform('file', requireCardRef(idText), options, buildFileAction(path, options));
  }

  async edit(idText: string, options: CardEditFlags) {
    const ref = requireCardRef(idText);
    const texts = await this.resolveTexts(options);
    await this.perform('edit', ref, options, buildEditAction(options, texts));
  }

  /**
   * `fy card progress <id>`: the progress parts `--file` and `--now` / `--done` / `--next` come to: the file's three
   * parts with each named flag replacing its part, or the flags' parts alone. The daemon merges what is sent into the
   * card's current progress in the card's own write, so nothing is read here.
   */
  async progress(idText: string, options: CardProgressFlags) {
    const ref = requireCardRef(idText);
    const parts: ProgressParts = {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.done === undefined ? {} : { doneSoFar: options.done }),
      ...(options.next === undefined ? {} : { next: options.next }),
    };
    const path = options.file?.trim();
    const filed = path === undefined || path === '' ? undefined : path;
    const base = filed === undefined ? undefined : parseProgressFile(await this.deps.files.readText(filed), filed);
    await this.perform('progress', ref, options, buildProgressAction(mergeProgress(base, parts)));
  }

  /**
   * `fy card patch <id> --file <f>`: the card's words as ONE YAML or JSON document (docs/board.md § Patch). The
   * values that differ from the card go as ONE edit action; a document that changes nothing sends nothing.
   */
  async patch(idText: string, options: CardPatchFlags) {
    const ref = requireCardRef(idText);
    const path = options.file?.trim() || '-';
    const source = path === '-' ? 'the patch on standard input' : path;
    const parsed = parseCardPatch(await this.deps.files.readText(path), source);
    if (!parsed.ok) {
      refuse(
        `card patch ${formatCardRef(ref)} changed nothing:\n${parsed.problems.map(problem => `  ${problem}`).join('\n')}`,
      );
    }
    const { card } = await this.gateway.card(ref.id);
    const plan = composeCardPatch(card, parsed.patch);
    if (plan.kind === 'stale') {
      refuse(
        `${formatCardRef(card)} changed since you read it, so nothing was written: read it again (${this.deps.binary} card show ${card.id} --yaml), update every part that is out of date, and patch it back`,
      );
    }
    if (plan.kind === 'unchanged') {
      return this.deps.output.success(
        `${formatCardRef(card)}: nothing changed, so nothing was sent (every value matches the card)`,
      );
    }
    await this.perform('patch', ref, options, plan.request);
  }

  async refile(
    idText: string,
    options: BoardCommonOptions & { readonly project?: string; readonly lane?: string; readonly reason?: string },
  ) {
    const ref = requireCardRef(idText);
    if (options.project === undefined) refuse('refile needs --project <name>: the board the card moves to');
    const target = resolveBoardProject(options.project, await this.gateway.projects());
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
}
