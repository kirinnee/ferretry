import {
  type AgendaDirection,
  type AgendaId,
  type AgendaItem,
  type AgendaSnapshot,
  agendaCardAnswers,
  agendaInDiscussion,
  agendaShape,
  agendaTurn,
  agendaWakeAt,
  hasOwnTitle,
  type ResolvedAgendaItem,
  unswipedChoices,
} from '@ferretry/protocol';
import { describeAnswer } from './answer.ts';
import { displayHowToResolve } from './how-to-resolve.ts';
import { agendaOrdinal, agendaReference } from './reference.ts';

/** Widest a field is printed at before it is elided. */
const BODY_WIDTH = 84;
const SHORT_WIDTH = 60;
const SUBJECT_WIDTH = 56;
const OPTION_WIDTH = 32;

const INDENT = '      ';

const compact = (value: string, width = BODY_WIDTH): string => {
  const line = value.replaceAll(/\s+/gu, ' ').trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
};

const pluralItems = (count: number): string => (count === 1 ? '1 open item' : `${count} open items`);

/** Who acted: an agent is named where the daemon knows the name. */
function actor(by: 'human' | 'agent' | 'daemon', name: string | null): string {
  if (by !== 'agent') return by;
  return name === null ? 'agent' : `agent ${name}`;
}

const ARROWS: Readonly<Record<AgendaDirection, string>> = { left: '←', up: '↑', right: '→' };

/**
 * The answers a card gives, laid out as the swipes point — `← No · → Yes`. An old item's options past the
 * third have no swipe; they are named after the arrows so nothing the owner could pick is hidden.
 */
function answersLine(item: AgendaItem): string {
  const answers = agendaCardAnswers(item);
  // Only a card asked in words has no answers to swipe: one question, or several answered as a numbered list.
  if (answers.length === 0) {
    return agendaShape(item) === 'answers' ? 'answer: one reply, each answer numbered' : 'answer: write a full answer';
  }
  const swipes = answers.map(answer => `${ARROWS[answer.direction]} ${compact(answer.label, OPTION_WIDTH)}`);
  const rest = unswipedChoices(item).map(option => `"${compact(option.label, OPTION_WIDTH)}"`);
  return `answers: ${swipes.join(' · ')}${rest.length === 0 ? '' : ` · also ${rest.join(' | ')}`}`;
}

/**
 * Oldest first — the order the listing header has always claimed.
 *
 * kteam printed that header and then rendered whatever order the daemon happened to send, so the
 * promise was decorative. Ties break on the item ordinal, which is monotonic per session.
 */
function oldestFirst(left: AgendaItem, right: AgendaItem): number {
  if (left.waitingSince !== right.waitingSince) return left.waitingSince < right.waitingSince ? -1 : 1;
  return agendaOrdinal(left.id) - agendaOrdinal(right.id);
}

/** Newest first: a resolution audit is read from the most recent entry back. */
function newestFirst(left: ResolvedAgendaItem, right: ResolvedAgendaItem): number {
  if (left.resolvedAt !== right.resolvedAt) return left.resolvedAt < right.resolvedAt ? 1 : -1;
  return agendaOrdinal(right.id) - agendaOrdinal(left.id);
}

function itemLines(item: AgendaItem): string[] {
  // A card with a title of its own is headed by it, the ask under it; an old item's ask is its heading.
  const titled = hasOwnTitle(item);
  const lines = [
    `  ${agendaReference(item.id)}  [${item.source}]  ${compact(titled ? (item.title ?? '') : item.subject)}`,
  ];
  if (titled) lines.push(`${INDENT}ask: ${compact(item.subject)}`);
  lines.push(`${INDENT}${answersLine(item)}`);
  if (item.premise !== undefined && item.premise.trim() !== '') {
    lines.push(`${INDENT}premise: ${compact(item.premise)}`);
  }
  if (item.context !== null && item.context !== undefined && item.context.trim() !== '') {
    lines.push(`${INDENT}context: ${compact(item.context)}`);
  }
  if (item.decided !== undefined && item.decided.trim() !== '') {
    lines.push(`${INDENT}decided: ${compact(item.decided)}`);
  }
  if (item.stillOpen !== undefined && item.stillOpen.trim() !== '') {
    lines.push(`${INDENT}still open: ${compact(item.stillOpen)}`);
  }
  lines.push(...agendaLines(item), ...briefLines(item), ...instructionLines(item));
  if (item.why.trim() !== item.subject.trim()) lines.push(`${INDENT}why: ${compact(item.why)}`);
  lines.push(`${INDENT}resolve: ${compact(displayHowToResolve(item.howToResolve))}`);
  lines.push(`${INDENT}since ${item.waitingSince} · raised by ${actor(item.raisedBy, item.raisedByName)}`);
  if (item.notice === true) {
    lines.push(`${INDENT}notice: read, not answered${item.ping === true ? ' (pinged)' : ''}`);
  } else if (item.parked?.reason === 'snoozed') {
    lines.push(
      `${INDENT}snoozed by the owner until ${agendaWakeAt(item) ?? item.parked.until}: it comes back then — \`agenda surface --now\` only if it is urgent`,
    );
  } else if (item.parked?.reason === 'replied') {
    lines.push(
      `${INDENT}replied ${item.parked.at}: parked — bring it back with \`agenda edit ${item.id} --summary … --premise … --context …\` (the whole card, refreshed), or \`agenda done\` it`,
    );
  } else if (agendaInDiscussion(item)) {
    lines.push(
      `${INDENT}ferret's turn: the owner wrote about this — \`agenda edit\` it, \`agenda surface\` it back, or \`agenda done\` it ${item.askedAt ?? ''}`.trimEnd(),
    );
  } else if (item.waitingOn !== undefined) {
    lines.push(`${INDENT}ferret's turn: more information asked ${item.askedAt ?? ''}`.trimEnd());
  } else if (agendaTurn(item) === 'owner') {
    lines.push(`${INDENT}owner's turn`);
  }
  return lines;
}

/** What the item blocks: stopped now, a named thing, and when it is needed — each only when set. */
function agendaLines(item: AgendaItem): string[] {
  return [
    ...(item.blockingNow === true ? [`${INDENT}blocking now: the ferret is stopped until this is answered`] : []),
    ...(item.willBlock === undefined ? [] : [`${INDENT}will block: ${compact(item.willBlock, SHORT_WIDTH)}`]),
    ...(item.neededBy === undefined ? [] : [`${INDENT}needed by: ${item.neededBy}`]),
  ];
}

/** The structured brief, one line per part: questions, the recommendation, the stakes, terms and links. */
function briefLines(item: AgendaItem): string[] {
  const lines: string[] = [];
  const questions = item.questions ?? [];
  questions.forEach((question, index) => {
    const label = questions.length === 1 ? 'question' : `q${index + 1}`;
    lines.push(`${INDENT}${label}: ${compact(question.question)}`);
    if (question.options !== undefined) {
      const picks = question.options.map(option => `"${compact(option.label, OPTION_WIDTH)}"`).join(' | ');
      lines.push(`${INDENT}  options: ${picks}`);
    }
    if (question.recommended !== undefined) {
      const why = question.why === undefined ? '' : ` — ${compact(question.why, SHORT_WIDTH)}`;
      lines.push(`${INDENT}  recommended: ${compact(question.recommended, SHORT_WIDTH)}${why}`);
    }
  });
  for (const each of item.optionDetails ?? []) {
    lines.push(`${INDENT}option "${compact(each.label, OPTION_WIDTH)}": ${compact(each.detail)}`);
  }
  if (item.recommendation !== undefined) {
    const why = item.recommendation.why === undefined ? '' : ` — ${compact(item.recommendation.why, SHORT_WIDTH)}`;
    lines.push(`${INDENT}recommend: ${compact(item.recommendation.decision, SHORT_WIDTH)}${why}`);
  }
  if (item.impact !== undefined || item.urgency !== undefined) {
    const by = item.urgency === undefined ? '' : `by ${compact(item.urgency, SHORT_WIDTH)}`;
    const impact = item.impact === undefined ? '' : compact(item.impact);
    lines.push(`${INDENT}impact: ${[impact, by].filter(part => part !== '').join(' — ')}`);
  }
  if (item.terms !== undefined) {
    lines.push(`${INDENT}terms: ${compact(item.terms.map(term => `${term.term} = ${term.meaning}`).join('; '))}`);
  }
  if (item.links !== undefined) {
    lines.push(`${INDENT}links: ${compact(item.links.map(link => link.label ?? link.target).join(' · '))}`);
  }
  return lines;
}

/** The instructions the owner follows: the steps numbered from 1 with a tick on the done ones, then the body. */
function instructionLines(item: AgendaItem): string[] {
  const lines: string[] = [];
  const done = new Set(item.stepsDone ?? []);
  const steps = item.steps ?? [];
  if (steps.length > 0) {
    lines.push(`${INDENT}steps (${done.size}/${steps.length} done):`);
    steps.forEach((step, index) => {
      lines.push(`${INDENT}  ${index + 1}. ${done.has(index) ? '✓' : '·'} ${compact(step)}`);
    });
  }
  if (item.body !== undefined) lines.push(`${INDENT}body: ${compact(item.body)}`);
  return lines;
}

/**
 * A warning about unreadable entries, which never replaces the readable ones.
 *
 * kteam returned only this warning and dropped the whole list, so one corrupt record hid every valid
 * item on the board — exactly when a human most needs to see what is waiting.
 */
function parseErrorWarning(snapshot: AgendaSnapshot): string | undefined {
  if (snapshot.parseErrors === 0) return undefined;
  const entries = snapshot.parseErrors === 1 ? '1 entry' : `${snapshot.parseErrors} entries`;
  return `Warning: ${entries} on this agenda could not be read; the list below may be incomplete.`;
}

/** The open agenda as a human reads it. */
export function renderAgendaList(snapshot: AgendaSnapshot): string {
  const warning = parseErrorWarning(snapshot);
  const preamble = warning === undefined ? [] : [warning];
  if (snapshot.items.length === 0) return [...preamble, 'Nothing on the agenda.'].join('\n');

  const header = `${pluralItems(snapshot.count)} in ${snapshot.sessionId} — oldest first`;
  const body = [...snapshot.items].sort(oldestFirst).flatMap(itemLines);
  return [...preamble, header, ...body].join('\n');
}

/** One item as `agenda show` prints it: the open item's full brief, or the line its resolution left. */
export function renderAgendaItem(item: AgendaItem | ResolvedAgendaItem): string {
  return 'resolvedAt' in item ? resolutionLine(item) : itemLines(item).join('\n');
}

function resolutionLine(item: ResolvedAgendaItem): string {
  const verb = item.disposition === 'dismissed' ? 'dismissed' : item.disposition === 'replied' ? 'replied' : 'resolved';
  const answer = item.response === undefined ? '' : ` — ${compact(describeAnswer(item.response), SHORT_WIDTH)}`;
  const note =
    item.resolutionNote === null || item.resolutionNote.trim() === ''
      ? ''
      : ` — ${compact(item.resolutionNote, SHORT_WIDTH)}`;
  const who = actor(item.resolvedBy, item.resolvedByName);
  return `  ${agendaReference(item.id)}  ${compact(item.subject, SUBJECT_WIDTH)} · ${verb} by ${who} at ${item.resolvedAt}${answer}${note}`;
}

/** The resolution audit, newest first. */
export function renderAgendaHistory(snapshot: AgendaSnapshot): string {
  const warning = parseErrorWarning(snapshot);
  const preamble = warning === undefined ? [] : [warning];
  if (snapshot.resolved.length === 0) return [...preamble, 'No recorded resolutions.'].join('\n');
  const header = `Recent resolutions in ${snapshot.sessionId} — newest first`;
  return [...preamble, header, ...[...snapshot.resolved].sort(newestFirst).map(resolutionLine)].join('\n');
}

/** Confirmation for a mutation: what happened, and what is still waiting. */
export function renderAgendaMutation(
  verb: string,
  reference: string | undefined,
  snapshot: AgendaSnapshot,
  raised?: AgendaId,
): string {
  const subject = reference === undefined ? verb : `${verb} ${reference}`;
  const line = `${subject} — ${pluralItems(snapshot.count)} in ${snapshot.sessionId}`;
  return [line, ...enrolmentWarning(snapshot.enrolled), ...writingAdvice(snapshot.warnings, raised ?? undefined)].join(
    '\n',
  );
}

/**
 * Said when the raise reached nobody. The daemon counts the enrolled devices only on the response to a
 * raise, so an absent count is "not this response", never zero.
 */
function enrolmentWarning(enrolled: number | undefined): string[] {
  if (enrolled !== 0) return [];
  return [
    'Warning: no device will be notified (0 enrolled). The item is on the agenda, but nobody was told — the owner turns notifications on in the app, under Settings › Notifications.',
  ];
}

/**
 * The daemon's advice on how the item reads. Never a refusal — the owner has already been told — so it
 * says what to change and how: reword it with `agenda edit`.
 */
function writingAdvice(warnings: readonly string[] | undefined, id: AgendaId | undefined): string[] {
  if (warnings === undefined || warnings.length === 0) return [];
  const fix = id === undefined ? 'agenda edit <id>' : `agenda edit ${agendaReference(id)}`;
  return [
    `Reads hard for someone who hasn't followed — fix it with \`${fix}\`:`,
    ...warnings.map(warning => `  - ${warning}`),
  ];
}

/** Confirmation for "Send now": which held answers went, or that nothing was held. */
export function renderRepliesSent(held: readonly AgendaId[], sessionId: string): string {
  if (held.length === 0) return `no answers were held for ${sessionId} — nothing to send`;
  return `sent ${held.map(agendaReference).join(', ')} to ${sessionId} now`;
}
