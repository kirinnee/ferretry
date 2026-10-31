import {
  type AgendaRef,
  type BoardCounts,
  type BoardProject,
  type BoardResponse,
  type BoardTaskEvent,
  type BoardTaskView,
  describeBoardEvent,
  formatAgendaRef,
  formatTaskRef,
  type Lane,
  type LaneSet,
  type PrLink,
  type TaskRef,
} from '@ferretry/protocol';

/** How a session id reads: its callsign when the directory knows it, else the id itself. */
export type SessionNames = (sessionId: string) => string;

const ELLIPSIS = '…';

const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}${ELLIPSIS}`;

const cell = (value: string): string => value.replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ');

const refOf = (ref: TaskRef): string => formatTaskRef(ref);

const laneOf = (laneSet: LaneSet | null | undefined, id: string): Lane | undefined =>
  laneSet?.lanes.find(lane => lane.id === id);

/** A lane's display name, falling back to its id when the lane set no longer has it. */
export const laneName = (laneSet: LaneSet | null | undefined, id: string): string => laneOf(laneSet, id)?.name ?? id;

// ─── one card's face ───────────────────────────────────────────────────────────────────────────

/** The PR state a row shows: the newest linked PR, in the words the `--pr` filter uses. */
export function prLabel(prs: readonly PrLink[]): string {
  const pr = prs.at(-1);
  if (pr === undefined) return 'no PR';
  const base = `PR #${String(pr.number)}`;
  if (pr.state === 'merged')
    return pr.releasedIn === null ? `${base} merged` : `${base} released ${pr.releasedIn.version}`;
  if (pr.state === 'closed') return `${base} closed`;
  if (pr.state === 'unknown') return `${base} linked`;
  if (pr.draft) return `${base} draft`;
  return pr.checks === 'failing' ? `${base} open, CI red` : `${base} open`;
}

/** The one word for how the card is doing: what the owner is waited on for beats the derived activity. */
export function activityLabel(card: BoardTaskView): string {
  if (card.dropped !== null) return 'dropped';
  if (card.waitingOnOwner.length > 0) return 'waiting on you';
  if (card.blocked !== null) return 'blocked';
  if (card.blockedBy.length > 0) return 'blocked by deps';
  return card.activity;
}

/** `owner→assignee`, or just the owner while nobody else has it. */
export function whoLabel(card: BoardTaskView, names: SessionNames): string {
  const owner = names(card.owner);
  return card.assignee === null || card.assignee === card.owner ? owner : `${owner}→${names(card.assignee)}`;
}

// ─── the board ─────────────────────────────────────────────────────────────────────────────────

const countsLine = (counts: BoardCounts): string =>
  [
    `${String(counts.closedHidden)} closed hidden`,
    `${String(counts.stale)} stale`,
    `${String(counts.orphaned)} orphaned`,
    `${String(counts.active)} active`,
    `${String(counts.toTest)} to test`,
    `${String(counts.waitingOnYou)} waiting on you`,
  ].join(' · ');

interface LaneGroup {
  readonly id: string;
  readonly name: string;
  readonly cards: readonly BoardTaskView[];
}

interface ProjectGroup {
  readonly name: string;
  readonly lanes: readonly LaneGroup[];
}

const byOrder = (left: BoardTaskView, right: BoardTaskView): number =>
  (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
  Number(left.id.slice(1)) - Number(right.id.slice(1));

/** Cards grouped by project, then by lane in the project's Kanban order; lanes with no card are left out. */
function groupBoard(response: BoardResponse, projects: readonly BoardProject[]): readonly ProjectGroup[] {
  const known = new Map(projects.map(project => [project.id, project]));
  const groups: ProjectGroup[] = [];
  const projectIds = [...new Set([...projects.map(project => project.id), ...response.cards.map(c => c.projectId)])];
  for (const projectId of projectIds) {
    const cards = response.cards.filter(card => card.projectId === projectId);
    if (cards.length === 0) continue;
    const laneSet =
      response.laneSet?.projectId === projectId ? response.laneSet : (known.get(projectId)?.laneSet ?? null);
    const ordered = (laneSet?.lanes ?? []).map(lane => lane.id);
    const stray = [...new Set(cards.map(card => card.laneId))].filter(id => !ordered.includes(id));
    const lanes = [...ordered, ...stray]
      .map(id => ({
        id,
        name: laneName(laneSet, id),
        cards: cards.filter(card => card.laneId === id).sort(byOrder),
      }))
      .filter(lane => lane.cards.length > 0);
    groups.push({ name: known.get(projectId)?.name ?? projectId, lanes });
  }
  return groups;
}

const headerLine = (response: BoardResponse, projects: readonly BoardProject[], label: string): string => {
  const scope = response.projectId === null ? label : (projects.find(p => p.id === response.projectId)?.name ?? label);
  return `${scope} — ${String(response.cards.length)} cards · ${countsLine(response.counts)}`;
};

const quarantineNotes = (response: BoardResponse): string[] =>
  response.quarantined.map(card => `! ${card.id} could not be read (${card.reason})`);

/** The board as text: one header with the counts, then each lane with its cards, one row per card. */
export function renderBoard(
  response: BoardResponse,
  projects: readonly BoardProject[],
  names: SessionNames,
  label: string,
): string {
  const lines = [headerLine(response, projects, label)];
  const groups = groupBoard(response, projects);
  const titleWidth = Math.min(48, Math.max(0, ...response.cards.map(card => card.title.length)));
  const idWidth = Math.max(0, ...response.cards.map(card => formatTaskRef(card).length));
  const showProject = groups.length > 1;
  for (const group of groups) {
    if (showProject) lines.push('', `# ${group.name}`);
    for (const lane of group.lanes) {
      lines.push('', `${lane.name} (${String(lane.cards.length)})`);
      for (const card of lane.cards) {
        lines.push(
          [
            `  ${formatTaskRef(card).padEnd(idWidth)}`,
            clip(card.title, titleWidth).padEnd(titleWidth),
            whoLabel(card, names),
            activityLabel(card),
            prLabel(card.links.prs),
          ].join('  '),
        );
      }
    }
  }
  if (response.cards.length === 0) lines.push('', 'no cards match');
  if (response.nextCursor !== null) lines.push('', 'more cards exist than this page holds');
  lines.push(...quarantineNotes(response));
  return lines.join('\n');
}

/** The same board as a markdown status report: a heading per lane and a table of its cards. */
export function renderBoardMarkdown(
  response: BoardResponse,
  projects: readonly BoardProject[],
  names: SessionNames,
  label: string,
): string {
  const lines = [`# ${headerLine(response, projects, label)}`];
  const groups = groupBoard(response, projects);
  const showProject = groups.length > 1;
  for (const group of groups) {
    if (showProject) lines.push('', `## ${group.name}`);
    for (const lane of group.lanes) {
      lines.push(
        '',
        `${showProject ? '###' : '##'} ${lane.name} (${String(lane.cards.length)})`,
        '',
        '| Task | Title | Who | Activity | PR |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const card of lane.cards) {
        lines.push(
          `| ${formatTaskRef(card)} | ${cell(card.title)} | ${cell(whoLabel(card, names))} | ${activityLabel(card)} | ${prLabel(card.links.prs)} |`,
        );
      }
    }
  }
  if (response.cards.length === 0) lines.push('', 'No cards match.');
  return lines.join('\n');
}

// ─── one card in full ──────────────────────────────────────────────────────────────────────────

const actorLabel = (actor: BoardTaskEvent['actor'], names: SessionNames): string => {
  if (actor.kind === 'ferret') return names(actor.sessionId);
  const via = actor.sessionId === undefined ? '' : ` via ${names(actor.sessionId)}`;
  return `${actor.kind}${via}`;
};

/** One history line's wording, as the protocol spells it for every surface. */
export const describeEvent = (event: BoardTaskEvent, laneSet: LaneSet | null, names: SessionNames): string =>
  describeBoardEvent(event, id => laneName(laneSet, id), names);

const section = (title: string, body: string): string[] => ['', title, ...body.split('\n').map(line => `  ${line}`)];

const agendaList = (refs: readonly AgendaRef[]): string => refs.map(formatAgendaRef).join(', ');

/** The terms table: the term column is as wide as the longest term, the meaning follows. */
export function renderTermsTable(terms: BoardTaskView['terms']): string {
  const width = Math.max(...terms.map(entry => entry.term.length));
  return terms.map(entry => `${entry.term.padEnd(width)}  ${entry.meaning}`).join('\n');
}

/**
 * The whole card: its ask first (the owner's words, verbatim), then why it exists, what a newcomer needs,
 * the glossary, the brief, how the owner tests it, how it relates to other cards, and its history. Empty parts
 * are left out.
 */
export function renderCard(
  card: BoardTaskView,
  laneSet: LaneSet | null,
  children: readonly BoardTaskView[],
  names: SessionNames,
): string {
  const lines: string[] = [
    `${formatTaskRef(card)}  ${card.title}  [${card.kind}]`,
    `lane      ${laneName(laneSet, card.laneId)}  ·  ${activityLabel(card)}  ·  workflow ${card.workflow}`,
    `who       ${whoLabel(card, names)}`,
    `project   ${card.projectId}`,
  ];
  if (card.summary !== '') lines.push(`summary   ${card.summary}`);
  if (card.parent !== null) lines.push(`parent    ${refOf(card.parent)}`);
  if (card.shippedIn !== null) lines.push(`shipped   ${card.shippedIn.version}`);
  if (card.suggestedLane !== null) lines.push(`suggests  ${laneName(laneSet, card.suggestedLane)}`);
  if (card.blocked !== null) lines.push(`blocked   ${card.blocked.reason}`);
  if (card.dropped !== null) lines.push(`dropped   ${card.dropped.reason}`);

  lines.push(...section('Ask', `${card.ask.text}\n— ${card.ask.source}`));
  for (const clarification of card.clarifications) {
    lines.push(...section('Clarified', `${clarification.text}\n— ${clarification.source}`));
  }
  if (card.premise !== '') lines.push(...section('Premise', card.premise));
  if (card.context !== '') lines.push(...section('Context', card.context));
  if (card.terms.length > 0) lines.push(...section('Terms', renderTermsTable(card.terms)));
  if (card.brief !== '') lines.push(...section('Brief', card.brief));
  if (card.howToTest !== '') lines.push(...section('How to test', card.howToTest));

  if (children.length > 0 || card.rollup.children > 0) {
    const roll = `${String(card.rollup.children)} children, ${String(card.rollup.active)} active`;
    const rows = children.map(
      child => `${formatTaskRef(child)}  ${child.title}  (${laneName(laneSet, child.laneId)}, ${activityLabel(child)})`,
    );
    lines.push(...section(`Children — ${roll}`, rows.length > 0 ? rows.join('\n') : 'not on this board'));
  }
  if (card.dependsOn.length > 0) {
    const waiting = new Set(card.blockedBy.map(refOf));
    const rows = card.dependsOn.map(dependency => {
      const flag =
        dependency.override === undefined ? (waiting.has(refOf(dependency.task)) ? 'waiting' : 'done') : 'overridden';
      return `${refOf(dependency.task)}  until ${dependency.until}  (${flag})`;
    });
    lines.push(...section('Depends on', rows.join('\n')));
  }
  if (card.blocks.length > 0) lines.push(...section('Blocks', card.blocks.map(refOf).join(', ')));

  const linkRows = [
    ...card.links.prs.map(pr => `pr      ${pr.url}  (${prLabel([pr])})`),
    ...(card.links.branch === null ? [] : [`branch  ${card.links.branch}`]),
    ...card.links.commits.map(commit => `commit  ${commit}`),
    ...card.links.docs.map(doc => `doc     ${doc}`),
  ];
  if (linkRows.length > 0) lines.push(...section('Links', linkRows.join('\n')));
  if (card.files.length > 0) lines.push(...section('Files', card.files.join('\n')));
  if (card.openAsks.length > 0) {
    const blocking = agendaList(card.waitingOnOwner);
    lines.push(
      ...section('Asks', `open: ${agendaList(card.openAsks)}${blocking === '' ? '' : `\nwaiting on you: ${blocking}`}`),
    );
  }

  const history = card.history.map(
    event =>
      `${String(event.seq).padStart(3)}  ${event.at}  ${actorLabel(event.actor, names)}  ${describeEvent(event, laneSet, names)}`,
  );
  lines.push(...section('History', history.join('\n')));
  return lines.join('\n');
}

// ─── what a write did ──────────────────────────────────────────────────────────────────────────

export type BoardVerb =
  | 'create'
  | 'move'
  | 'focus'
  | 'block'
  | 'unblock'
  | 'depend'
  | 'undepend'
  | 'drop'
  | 'reopen'
  | 'clarify'
  | 'link'
  | 'assign'
  | 'note'
  | 'order'
  | 'reparent'
  | 'file'
  | 'edit'
  | 'refile';

const PAST: Readonly<Record<BoardVerb, string>> = {
  create: 'created',
  move: 'moved',
  focus: 'is now your focus',
  block: 'blocked',
  unblock: 'unblocked',
  depend: 'dependency recorded',
  undepend: 'dependency removed',
  drop: 'dropped',
  reopen: 'reopened',
  clarify: 'clarified',
  link: 'linked',
  assign: 'assigned',
  note: 'noted',
  order: 'ranked',
  reparent: 're-parented',
  file: 'file recorded',
  edit: 'edited',
  refile: 'refiled',
};

/** One line that says what the verb did and where the card stands now. */
export function renderActed(
  verb: BoardVerb,
  card: BoardTaskView,
  laneSet: LaneSet | null,
  names: SessionNames,
): string {
  return `${formatTaskRef(card)} ${PAST[verb]} — ${laneName(laneSet, card.laneId)}, ${whoLabel(card, names)}, ${activityLabel(card)}`;
}
