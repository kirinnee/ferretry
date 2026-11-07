import {
  CLONE_OUTCOME_CHOICES,
  type CloneChoice,
  type CloneDecisions,
  type CloneOutcome,
  type CloneReviewItem,
  type CloneReviewLogin,
  type CloneReview,
} from '@ferretry/plugin-runtimes/contract';
import { MachineCommandError } from './ports.ts';

/**
 * What a repeat `fy machine clone` shows and asks (docs/design/account-model.md §3.8, docs/cross-daemon.md §3).
 *
 * Everything here is pure: the daemon's review goes in, words and decisions come out. The terminal, the
 * prompts and the calls live in `commands.ts`. Nothing here names a login's sign-in, a token or a secret
 * value, because the review it reads holds none: a login is a name and an outcome.
 */

/** The four choice flags as commander parsed them, each a list of `kind/name` items as the review lists them. */
export interface CloneChoiceFlags {
  readonly theirs: readonly string[];
  readonly mine: readonly string[];
  readonly remove: readonly string[];
  readonly skip: readonly string[];
}

type CloneFlagName = keyof CloneChoiceFlags;

const FLAG_WORDS: Record<CloneFlagName, string> = {
  theirs: '--theirs',
  mine: '--mine',
  remove: '--remove',
  skip: '--skip',
};

/** What each flag asks for, for an item whose outcome allows it. `--theirs` adds where there is nothing here to take over. */
function choiceFor(flag: CloneFlagName, outcome: CloneOutcome): CloneChoice | undefined {
  const allowed = CLONE_OUTCOME_CHOICES[outcome] as readonly CloneChoice[];
  const wanted: readonly CloneChoice[] = {
    theirs: ['take', 'add'] as const,
    mine: ['keep'] as const,
    remove: ['remove'] as const,
    // Leaving an item out: a new one is skipped, anything already here is kept as it is.
    skip: ['skip', 'keep'] as const,
  }[flag];
  return wanted.find(choice => allowed.includes(choice));
}

/** The flags an outcome answers to, in the order they are worth suggesting. */
function flagsFor(outcome: CloneOutcome): CloneFlagName[] {
  return (['theirs', 'mine', 'remove', 'skip'] as const).filter(flag => choiceFor(flag, outcome) !== undefined);
}

/** The review item a person's word names: its `ref` here, or else its `sourceRef` when that is unambiguous. */
function itemNamed(review: CloneReview, word: string): CloneReviewItem | undefined {
  const here = review.items.find(item => item.ref === word);
  if (here !== undefined) return here;
  const there = review.items.filter(item => item.sourceRef === word);
  return there.length === 1 ? there[0] : undefined;
}

export interface ResolvedChoices {
  /** One decision per item the flags named, by the item's `ref` as the daemon lists it. */
  readonly decisions: CloneDecisions;
  /** Every flag that cannot be honoured, in words. Empty when the flags are usable. */
  readonly problems: readonly string[];
}

/**
 * The flags as decisions, checked against the review. Nothing is guessed: an item that is not in the review,
 * named twice, or given a choice its outcome does not allow is a problem, and the caller writes nothing.
 */
export function resolveCloneChoices(review: CloneReview, flags: CloneChoiceFlags): ResolvedChoices {
  const decisions: Record<string, CloneChoice> = {};
  const given = new Map<string, CloneFlagName>();
  const problems: string[] = [];
  for (const flag of ['theirs', 'mine', 'remove', 'skip'] as const) {
    for (const word of flags[flag]) {
      const item = itemNamed(review, word);
      if (item === undefined) {
        problems.push(
          `${FLAG_WORDS[flag]} ${word}: nothing called ${word} differs between the two machines. It may already be the same here.`,
        );
        continue;
      }
      const earlier = given.get(item.ref);
      if (earlier !== undefined && earlier !== flag) {
        problems.push(`${item.ref} is named by both ${FLAG_WORDS[earlier]} and ${FLAG_WORDS[flag]}. Pick one.`);
        continue;
      }
      const choice = choiceFor(flag, item.outcome);
      if (choice === undefined) {
        problems.push(
          `${FLAG_WORDS[flag]} ${item.ref}: ${OUTCOME_STATE[item.outcome]}. For it you can use ${flagsFor(item.outcome)
            .map(one => FLAG_WORDS[one])
            .join(' or ')}.`,
        );
        continue;
      }
      given.set(item.ref, flag);
      decisions[item.ref] = choice;
    }
  }
  return { decisions, problems };
}

/** Why a flag does not fit an outcome, as a clause. */
const OUTCOME_STATE: Record<CloneOutcome, string> = {
  new: 'it is new, so there is nothing here to keep or remove',
  theirs: 'only the other machine changed it, so there is nothing to remove',
  mine: 'only you changed it here, so it is kept and nothing is taken or removed',
  both: 'both machines changed it, so it can be taken or kept, not removed',
  gone: 'the other machine no longer has it, so there is nothing to take',
  'removed-here': 'you removed it here, so it stays removed unless you bring it back with --theirs',
};

/** What is chosen for an item: the person's decision, else the daemon's default (none for a `both` item). */
function choiceOf(item: CloneReviewItem, decisions: CloneDecisions): CloneChoice | undefined {
  return decisions[item.ref] ?? item.choice;
}

/** The both-changed items with no decision. Owner decision §14.1: nothing is chosen for them. */
export function pendingBoth(review: CloneReview, decisions: CloneDecisions): CloneReviewItem[] {
  return review.items.filter(item => item.outcome === 'both' && decisions[item.ref] === undefined);
}

/** `--login <sourceId>=<target|slot>` as an answer table. A repeated source id is refused rather than the last one winning. */
export function parseLoginFlags(values: readonly string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf('=');
    const sourceId = at < 0 ? '' : value.slice(0, at).trim();
    const target = at < 0 ? '' : value.slice(at + 1).trim();
    if (sourceId === '' || target === '') {
      throw new MachineCommandError(
        `--login takes <source login>=<login here>, or <source login>=slot for a new empty one. Got "${value}".`,
      );
    }
    if (Object.hasOwn(answers, sourceId)) throw new MachineCommandError(`--login names ${sourceId} twice.`);
    answers[sourceId] = target;
  }
  return answers;
}

/** The logins the daemon could not settle and the person has not answered yet. */
export function pendingLogins(review: CloneReview, answers: Readonly<Record<string, string>>): CloneReviewLogin[] {
  return review.logins.filter(login => login.outcome === 'ask' && answers[login.sourceId] === undefined);
}

/**
 * Answers refused before anything is sent: a login the review does not ask about, or one that is not among
 * its candidates. An answer only ever picks WHICH existing login a copied runtime uses (or an empty slot);
 * it never changes a login, so there is no answer that could touch a sign-in.
 */
export function loginProblems(review: CloneReview, answers: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const [sourceId, target] of Object.entries(answers)) {
    const login = review.logins.find(candidate => candidate.sourceId === sourceId);
    if (login === undefined) {
      problems.push(`--login ${sourceId}: the other machine's setup has no login called ${sourceId}.`);
    } else if (login.outcome !== 'ask') {
      problems.push(
        `--login ${sourceId}: it is already settled (${login.outcome === 'matched' ? `used as ${login.target ?? 'the one here'}` : 'a new empty slot'}), so there is nothing to answer.`,
      );
    } else if (target !== 'slot' && !(login.candidates ?? []).includes(target)) {
      problems.push(
        `--login ${sourceId}=${target}: pick one of ${(login.candidates ?? []).join(', ')}, or slot for a new empty login.`,
      );
    }
  }
  return problems;
}

const writes = (choice: CloneChoice | undefined): boolean => choice === 'take' || choice === 'add';

type RunnableEntries = NonNullable<CloneReviewItem['runnable']>['entries'];

/**
 * What an environment login would be configured to run with, when this copy could add it as a new login
 * here: not one already matched, nor one the person pointed at a login they have. A sign-in login has none.
 * A login still waiting for its answer counts, because "a new login" is one of the answers.
 */
function addedLoginEntries(login: CloneReviewLogin, answers: Readonly<Record<string, string>>): RunnableEntries {
  const answered = answers[login.sourceId];
  if (login.outcome === 'matched' || (answered !== undefined && answered !== 'slot')) return [];
  return login.runnable?.entries ?? [];
}

/**
 * Whether applying would make this machine run something new, or remove something: the cases that ask first.
 * A configured login is only added for a runtime that is written, and the review does not say which runtime
 * uses which login, so any written runtime counts: asking too often is the safe side.
 */
export function cloneNeedsYes(
  review: CloneReview,
  decisions: CloneDecisions,
  logins: Readonly<Record<string, string>>,
): boolean {
  const writesRuntime = review.items.some(item => item.kind === 'runtime' && writes(choiceOf(item, decisions)));
  const addsConfiguredLogin = review.logins.some(login => addedLoginEntries(login, logins).length > 0);
  return (
    (writesRuntime && addsConfiguredLogin) ||
    review.items.some(item => {
      const choice = choiceOf(item, decisions);
      return choice === 'remove' || (writes(choice) && item.runnable !== undefined);
    })
  );
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export interface RenderOptions {
  readonly decisions: CloneDecisions;
  readonly logins: Readonly<Record<string, string>>;
  /** The command's own name, for the hints. */
  readonly binaryName: string;
}

const MARKERS: Record<CloneOutcome, string> = {
  new: '+',
  theirs: '~',
  mine: '=',
  both: '!',
  gone: '-',
  'removed-here': 'x',
};

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/** The day a copy was last made, for a heading: `2026-10-28`. */
const dayOf = (instant: string): string => instant.slice(0, 10);

/** One changed document in a few words: `send.sh: +3 −1 lines`. */
function fileWords(file: CloneReviewItem['files'][number]): string {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (file.change === 'added') return `${name} (new)`;
  if (file.change === 'removed') return `${name} (removed)`;
  return file.lines === undefined ? `${name} changed` : `${name}: +${file.lines.added} −${file.lines.removed} lines`;
}

/** What differs about an item, in one line: the documents that changed, else the fields. */
function whatChanged(item: CloneReviewItem): string {
  if (item.files.length > 0) return item.files.map(fileWords).join(', ');
  if (item.fields !== undefined && item.fields.length > 0) return item.fields.join(', ');
  return '';
}

/** Every entry on its own line under what writes it, exactly as the other machine exported it. */
function entryLines(entries: RunnableEntries): string[] {
  return entries.flatMap(entry => {
    if (!entry.document) return [`      Runs: ${entry.label}: ${entry.text}`];
    const body = entry.text.replace(/\n$/u, '').split('\n');
    return [`      Runs: ${entry.label}, ${plural(body.length, 'line')}:`, ...body.map(line => `        ${line}`)];
  });
}

/** Everything a written item runs. */
const runLines = (item: CloneReviewItem): string[] => entryLines(item.runnable?.entries ?? []);

/** What the decision for an item says, when it is one the person made or one the item needs. */
function decisionWords(item: CloneReviewItem, options: RenderOptions, source: string): string {
  const decided = options.decisions[item.ref];
  if (item.outcome === 'both') {
    if (decided === 'take') return `taking ${source}'s`;
    if (decided === 'keep') return 'keeping yours';
    return 'needs your choice';
  }
  if (decided === undefined || decided === item.choice) return '';
  if (decided === 'skip') return 'left out';
  if (decided === 'keep') return 'keeping yours';
  if (decided === 'remove') return 'will be removed here';
  return decided === 'add' ? 'will be brought back' : '';
}

function itemLines(item: CloneReviewItem, width: number, options: RenderOptions, source: string): string[] {
  const decided = options.decisions[item.ref];
  const choice = choiceOf(item, options.decisions);
  const parts = [whatChanged(item), decisionWords(item, options, source)].filter(part => part !== '');
  if (item.note !== undefined) parts.push(item.note);
  const head =
    `  ${MARKERS[item.outcome]} ${item.ref.padEnd(width)}${parts.length === 0 ? '' : `  ${parts.join('; ')}`}`.trimEnd();
  // Everything an item would run is listed, unless the person already left it out or kept theirs off.
  const listed = decided === 'keep' || decided === 'skip' || decided === 'remove' ? [] : runLines(item);
  const needs = (item.needs ?? []).map(need => `      Needs: ${need}`);
  return [head.trimEnd(), ...listed, ...(choice === 'remove' || decided === 'remove' ? [] : needs)];
}

function loginLine(login: CloneReviewLogin, answers: Readonly<Record<string, string>>, binaryName: string): string[] {
  const answered = answers[login.sourceId];
  // An environment login is not an empty slot: it is added already configured, and all of that is listed.
  const added = entryLines(addedLoginEntries(login, answers));
  const fresh =
    login.runnable === undefined
      ? `new empty slot, needs sign-in (${binaryName} login ls)`
      : 'new login, configured to run the following';
  if (login.outcome === 'matched') {
    return [`  ${login.sourceId} → already here as ${login.target ?? 'a login here'}, no new sign-in`];
  }
  if (login.outcome === 'slot' || answered === 'slot') return [`  ${login.sourceId} → ${fresh}`, ...added];
  if (answered !== undefined) return [`  ${login.sourceId} → ${answered}, no new sign-in`];
  return [
    `  ${login.sourceId} → could be any of ${(login.candidates ?? []).join(', ')}`,
    `      choose with --login ${login.sourceId}=<one of those>, or --login ${login.sourceId}=slot for ${login.runnable === undefined ? 'a new empty one' : 'a new configured one, listed below'}`,
    ...added,
  ];
}

/**
 * The review as the terminal prints it (docs/design/account-model.md §7): only what differs, in groups that
 * each say what will happen, then how many things are already the same. `--dry-run` prints exactly this.
 */
export function renderCloneDiff(review: CloneReview, options: RenderOptions): string {
  const source = review.source.name;
  const lines: string[] = [];
  const heading =
    review.mode === 'update'
      ? `Update from ${source}${review.source.lastCopiedAt === undefined ? '' : ` (last copied ${dayOf(review.source.lastCopiedAt)})`}`
      : `Copy from ${source}`;
  lines.push(heading, '');
  const width = review.items.reduce((most, item) => Math.max(most, item.ref.length), 0);
  const groups: { outcome: CloneOutcome; title: string; hint?: string }[] = [
    { outcome: 'new', title: `New on ${source}`, hint: 'leave one out with --skip <item>' },
    { outcome: 'theirs', title: `Changed on ${source}`, hint: 'keep yours instead with --mine <item>' },
    { outcome: 'mine', title: 'Changed here, kept' },
    {
      outcome: 'both',
      title: 'Both changed — choose',
      hint: `needs --theirs <item> to take ${source}'s, or --mine <item> to keep yours`,
    },
    { outcome: 'gone', title: `Gone from ${source} — kept here`, hint: 'use --remove <item> to remove' },
    { outcome: 'removed-here', title: 'Removed here — staying removed', hint: 'use --theirs <item> to bring one back' },
  ];
  for (const group of groups) {
    const items = review.items.filter(item => item.outcome === group.outcome);
    if (items.length === 0) continue;
    lines.push(`${group.title} (${items.length})${group.hint === undefined ? '' : `   ${group.hint}`}`);
    for (const item of items) lines.push(...itemLines(item, width, options, source));
  }
  if (review.logins.length > 0) {
    lines.push('Logins');
    for (const login of review.logins) lines.push(...loginLine(login, options.logins, options.binaryName));
  }
  if (review.items.length === 0 && review.logins.every(login => login.outcome === 'matched')) {
    lines.push(`Everything from ${source} is already here. Nothing to copy.`);
  }
  if (review.same.count > 0) {
    lines.push(
      `${plural(review.same.count, 'thing')} already the same${review.same.probable > 0 ? ` (${review.same.probable} matched by name)` : ''}.`,
    );
  }
  return lines.join('\n');
}

/** Everything the review knows about one item, for "show both": what differs and why, and what it would run. */
export function renderItemDetail(item: CloneReviewItem, source: string): string {
  const lines = [`${item.ref} — both sides changed it${item.match === 'probable' ? ' (matched by name only)' : ''}`];
  for (const file of item.files) lines.push(`  ${fileWords(file)}`);
  if (item.files.length === 0 && item.fields !== undefined) lines.push(`  fields: ${item.fields.join(', ')}`);
  if (item.note !== undefined) lines.push(`  ${item.note}`);
  lines.push(...runLines(item).map(line => line.slice(2)));
  lines.push(`  ${source}'s version is the one that would be copied; yours is what is here now.`);
  return lines.join('\n');
}
