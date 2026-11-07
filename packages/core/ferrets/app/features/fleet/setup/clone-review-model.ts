/**
 * The Update review (docs/design/account-model.md §3.8 L8–L16, §4.7), as data.
 *
 * `POST /v1/runtimes/clone/review` answers every item that DIFFERS from the copy of the other machine, why,
 * and what is chosen for it. This module groups that answer for the screen, holds the person's choices,
 * and counts what the button will write. It is pure: the sheet (`clone-review.tsx`) draws it.
 *
 * TWO RULES the sheet must never break:
 *
 * - **Both changed has no default.** Nothing is pre-selected for an item changed on both machines; the
 *   Apply button stays off until each one is chosen (owner decision, design §14.1). The daemon refuses an
 *   update that leaves one unchosen, too.
 * - **A login is never offered for removal.** A "Gone" row is an item of the setup, never a login; the
 *   logins are listed apart and the only choice they have is WHICH existing login a source sign-in uses.
 */

import { CLONE_OUTCOME_CHOICES, CLONE_REVIEW_STALE, type CloneChoice, type CloneReviewItem, type CloneReviewKind, type CloneReviewLogin } from '@ferretry/plugin-runtimes/contract';
import { type CloneLoginTarget, cloneBundleProblem, cloneRunnables, type FleetCloneBundle, type FleetCloneReview } from '@ferretry/protocol';
import { countWords } from './setup-words.ts';

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

const KIND_TITLES: Readonly<Record<CloneReviewKind, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
  profile: 'Profile',
  runtime: 'Runtime',
};

/** The part of a ref after its kind: `hooks/guard` → `guard`. */
const reviewItemName = (ref: string): string => ref.slice(ref.indexOf('/') + 1);

/** "MCP server · notes". */
export const reviewItemTitle = (item: CloneReviewItem): string =>
  `${KIND_TITLES[item.kind]} · ${reviewItemName(item.ref)}`;

/** "Last copied 28 Oct 2026." — in the reader's own calendar. */
export const lastCopiedWords = (instant: string | undefined): string | null => {
  if (instant === undefined) return null;
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  return `Last copied ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`;
};

// ── Groups ───────────────────────────────────────────────────────────────────────────────────────

type ReviewGroupId = 'new' | 'theirs' | 'both' | 'mine' | 'gone' | 'removed-here';

export interface ReviewGroup {
  readonly id: ReviewGroupId;
  /** Says what will happen: "New on Studio Mac". */
  readonly title: string;
  /** One line under the heading: what the default does and what the person can change. */
  readonly hint: string;
  readonly items: readonly CloneReviewItem[];
}

const GROUP_ORDER: readonly ReviewGroupId[] = ['new', 'theirs', 'both', 'mine', 'gone', 'removed-here'];

const groupWords = (id: ReviewGroupId, source: string): { readonly title: string; readonly hint: string } => {
  switch (id) {
    case 'new':
      return { title: `New on ${source}`, hint: 'Added here. Untick any you don’t want.' };
    case 'theirs':
      return { title: `Changed on ${source}`, hint: 'Updated here. Untick any you want to leave as they are.' };
    case 'both':
      return {
        title: 'Both changed — pick one',
        hint: `Changed here and on ${source}. Nothing is chosen for you: pick one for each.`,
      };
    case 'mine':
      return {
        title: 'Changed here (kept)',
        hint: 'Only you changed these. They stay as they are; nothing is written.',
      };
    case 'gone':
      return {
        title: `Gone from ${source}`,
        hint: `${source} no longer has these. They stay here unless you tick one to remove it.`,
      };
    case 'removed-here':
      return {
        title: 'You removed these here',
        hint: 'They stay removed unless you tick one to bring it back.',
      };
  }
};

/** The groups with something in them, in reading order. An empty group is never listed. */
export const reviewGroups = (review: FleetCloneReview, source: string): readonly ReviewGroup[] =>
  GROUP_ORDER.flatMap(id => {
    const items = review.items.filter(item => item.outcome === id);
    return items.length === 0 ? [] : [{ id, ...groupWords(id, source), items }];
  });

// ── Choices ──────────────────────────────────────────────────────────────────────────────────────

/** What the person picked, by item ref. An item they have not touched is not here. */
export type ReviewPicks = Readonly<Record<string, CloneChoice>>;

/** Whether a choice writes something on this machine. */
const choiceWrites = (choice: CloneChoice | undefined): boolean =>
  choice === 'take' || choice === 'add' || choice === 'remove';

/** Writes a document, as opposed to removing one: the choices a dependency follows. */
const choiceBrings = (choice: CloneChoice | undefined): boolean => choice === 'take' || choice === 'add';

/** The choice in force: the person's own, else the daemon's default. ABSENT for a `both` nobody chose. */
export const chosenFor = (item: CloneReviewItem, picks: ReviewPicks): CloneChoice | undefined =>
  picks[item.ref] ?? item.choice;

/** The choice that writes nothing for an item. */
const idleChoice = (item: CloneReviewItem): CloneChoice => (item.outcome === 'new' ? 'skip' : 'keep');

/** The choice that brings an item in, for the outcomes that allow one. */
const bringChoice = (item: CloneReviewItem): CloneChoice | undefined => {
  const allowed = CLONE_OUTCOME_CHOICES[item.outcome] as readonly CloneChoice[];
  return allowed.includes('add') ? 'add' : allowed.includes('take') ? 'take' : undefined;
};

/**
 * Sets one item's choice and lets its dependencies follow (L11): bringing in a profile that needs a new
 * component brings that component too; leaving a component out leaves out whatever needs it. The daemon
 * refuses a set that breaks this, so the sheet never offers one.
 */
export const chooseItem = (
  review: FleetCloneReview,
  picks: ReviewPicks,
  ref: string,
  choice: CloneChoice,
): ReviewPicks => {
  const byRef = new Map(review.items.map(item => [item.ref, item]));
  const next: Record<string, CloneChoice> = { ...picks, [ref]: choice };
  const queue: string[] = [ref];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const item = byRef.get(current);
    if (item === undefined) continue;
    const now = next[current] ?? item.choice;
    if (choiceBrings(now)) {
      for (const need of item.needs ?? []) {
        const wanted = byRef.get(need);
        const bring = wanted === undefined ? undefined : bringChoice(wanted);
        if (wanted === undefined || bring === undefined) continue;
        if (!choiceBrings(next[need] ?? wanted.choice)) {
          next[need] = bring;
          queue.push(need);
        }
      }
    } else {
      for (const other of review.items) {
        if (!(other.needs ?? []).includes(current)) continue;
        if (!choiceBrings(next[other.ref] ?? other.choice)) continue;
        next[other.ref] = idleChoice(other);
        queue.push(other.ref);
      }
    }
  }
  return next;
};

/** The `both` items nobody has chosen yet: Apply waits for every one. */
export const unchosenBoth = (review: FleetCloneReview, picks: ReviewPicks): readonly CloneReviewItem[] =>
  review.items.filter(item => item.outcome === 'both' && chosenFor(item, picks) === undefined);

/** One decision per item the review listed: what is sent with `reviewed`. */
export const reviewDecisions = (review: FleetCloneReview, picks: ReviewPicks): Readonly<Record<string, CloneChoice>> =>
  Object.fromEntries(
    review.items.flatMap(item => {
      const choice = chosenFor(item, picks);
      return choice === undefined ? [] : [[item.ref, choice] as const];
    }),
  );

// ── Logins ───────────────────────────────────────────────────────────────────────────────────────

/** The id the person picked for an `ask` login: an existing login here, or {@link NEW_SLOT}. */
export type LoginPicks = Readonly<Record<string, string>>;

/** The answer that adds an empty slot rather than reusing a login here. */
export const NEW_SLOT = 'slot';

/** The login a source sign-in will use: its match here, the person's pick, else a new empty slot. */
export const loginTarget = (login: CloneReviewLogin, picks: LoginPicks): string => {
  if (login.outcome === 'matched') return login.target ?? NEW_SLOT;
  if (login.outcome === 'ask') return picks[login.sourceId] ?? NEW_SLOT;
  return NEW_SLOT;
};

/** What `clone.import` carries as `logins`: only the sign-ins the person was asked about. */
export const loginChoices = (review: FleetCloneReview, picks: LoginPicks): Readonly<Record<string, string>> =>
  Object.fromEntries(
    review.logins.flatMap(login =>
      login.outcome === 'ask' ? [[login.sourceId, loginTarget(login, picks)] as const] : [],
    ),
  );

// ── What the button says ─────────────────────────────────────────────────────────────────────────

/** How many things the update will write: chosen items, and each login that becomes an empty slot. */
export const updateCount = (review: FleetCloneReview, picks: ReviewPicks, logins: LoginPicks): number =>
  review.items.filter(item => choiceWrites(chosenFor(item, picks))).length +
  review.logins.filter(login => loginTarget(login, logins) === NEW_SLOT).length;

/** "Update 4 things"; "Nothing to copy" when the choices write nothing. */
export const updateLabel = (count: number): string =>
  count === 0 ? 'Nothing to copy' : `Update ${countWords(count, 'thing')}`;

/** Why Apply is off, said next to the button; `null` when it is on. */
export const applyHold = (unchosen: readonly CloneReviewItem[], source: string): string | null =>
  unchosen.length === 0
    ? null
    : `Choose ${unchosen.length === 1 ? 'one' : String(unchosen.length)} more under “Both changed” first: keep yours, or use ${source}’s.`;

/** The review lists nothing to write and nothing to ask: one note instead of empty sections. */
export const nothingDiffers = (review: FleetCloneReview): boolean =>
  review.items.length === 0 &&
  review.logins.every(login => login.outcome === 'matched') &&
  review.keys.every(key => key.outcome === 'same') &&
  review.settings.every(file => file.keys.length === 0);

/** Whether the daemon refused the apply because the review no longer matches this machine. */
export const isStaleReview = (sentence: string | null): boolean =>
  sentence !== null && sentence.includes(CLONE_REVIEW_STALE);

// ── "Already the same" ───────────────────────────────────────────────────────────────────────────

/** "14 things already the same". */
export const sameTitle = (review: FleetCloneReview): string =>
  `${countWords(review.same.count, 'thing')} already the same`;

/** "3 matched by name", or `null` when every one is linked by its origin key. */
export const sameMatchedByName = (review: FleetCloneReview): string | null =>
  review.same.probable === 0 ? null : `${String(review.same.probable)} matched by name`;

/**
 * The names behind the count: every item the source carries that the review does not list. Names only.
 * `null` when the two do not add up, so a count is never dressed up with names that might be wrong.
 */
export const sameNames = (bundle: FleetCloneBundle, review: FleetCloneReview): readonly string[] | null => {
  const listed = new Set(review.items.flatMap(item => (item.sourceRef === undefined ? [] : [item.sourceRef])));
  const carried = [
    ...Object.entries(bundle.components).flatMap(([kind, entries]) =>
      Object.keys(entries).map(name => `${kind}/${name}`),
    ),
    ...Object.keys(bundle.profiles).map(name => `profile/${name}`),
    ...Object.keys(bundle.runtimes).map(name => `runtime/${name}`),
  ];
  const names = carried.filter(ref => !listed.has(ref)).toSorted();
  return names.length === review.same.count ? names : null;
};

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

type ReviewOutcomeId = 'added' | 'updated' | 'removed' | 'kept';

export interface ReviewOutcomeGroup {
  readonly id: ReviewOutcomeId;
  readonly title: string;
  readonly names: readonly string[];
}

/** What the update did, per group, from the review and the choices it was applied with. */
export const reviewOutcomes = (review: FleetCloneReview, picks: ReviewPicks): readonly ReviewOutcomeGroup[] => {
  const named = (match: (item: CloneReviewItem, choice: CloneChoice | undefined) => boolean): string[] =>
    review.items.filter(item => match(item, chosenFor(item, picks))).map(item => item.ref);
  const groups: ReviewOutcomeGroup[] = [
    { id: 'added', title: 'Added', names: named((_, choice) => choice === 'add') },
    { id: 'updated', title: 'Updated', names: named((_, choice) => choice === 'take') },
    { id: 'removed', title: 'Removed', names: named((_, choice) => choice === 'remove') },
    {
      id: 'kept',
      title: 'Kept as they were',
      names: named((_, choice) => choice === 'keep' || choice === 'skip'),
    },
  ];
  return groups.filter(group => group.names.length > 0);
};

// ── A line diff ──────────────────────────────────────────────────────────────────────────────────

export type DiffLine =
  | { readonly kind: 'same' | 'add' | 'del'; readonly text: string }
  /** `count` unchanged lines left out between two changes. */
  | { readonly kind: 'skip'; readonly count: number };

/** Documents longer than this many lines on both sides are not compared line by line. */
const DIFF_CELLS = 4_000_000;
/** Unchanged lines kept around each change. */
const CONTEXT = 2;

/**
 * A line diff of `before` (here) against `after` (the other machine), with two unchanged lines around each
 * change and the rest folded. `null` when the documents are too long to compare, so the caller shows the
 * whole file instead.
 */
export const lineDiff = (before: string, after: string): readonly DiffLine[] | null => {
  const left = before === '' ? [] : before.replace(/\n$/u, '').split('\n');
  const right = after === '' ? [] : after.replace(/\n$/u, '').split('\n');
  if (left.length * right.length > DIFF_CELLS) return null;
  // Longest common subsequence, bottom-up, in one flat table.
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let col = right.length - 1; col >= 0; col -= 1) {
      table[row * width + col] =
        left[row] === right[col]
          ? (table[(row + 1) * width + col + 1] as number) + 1
          : Math.max(table[(row + 1) * width + col] as number, table[row * width + col + 1] as number);
    }
  }
  const all: { kind: 'same' | 'add' | 'del'; text: string }[] = [];
  let row = 0;
  let col = 0;
  while (row < left.length && col < right.length) {
    if (left[row] === right[col]) {
      all.push({ kind: 'same', text: left[row] as string });
      row += 1;
      col += 1;
    } else if ((table[(row + 1) * width + col] as number) >= (table[row * width + col + 1] as number)) {
      all.push({ kind: 'del', text: left[row] as string });
      row += 1;
    } else {
      all.push({ kind: 'add', text: right[col] as string });
      col += 1;
    }
  }
  for (; row < left.length; row += 1) all.push({ kind: 'del', text: left[row] as string });
  for (; col < right.length; col += 1) all.push({ kind: 'add', text: right[col] as string });

  const near = all.map((line, index) => {
    if (line.kind !== 'same') return true;
    for (let step = 1; step <= CONTEXT; step += 1) {
      if (all[index - step]?.kind === 'add' || all[index - step]?.kind === 'del') return true;
      if (all[index + step]?.kind === 'add' || all[index + step]?.kind === 'del') return true;
    }
    return false;
  });
  const shown: DiffLine[] = [];
  let folded = 0;
  all.forEach((line, index) => {
    if (near[index] === true) {
      if (folded > 0) shown.push({ kind: 'skip', count: folded });
      folded = 0;
      shown.push(line);
    } else folded += 1;
  });
  if (folded > 0) shown.push({ kind: 'skip', count: folded });
  return shown;
};

/** "+3 −1 lines", for a file the review counted. */
export const lineCountWords = (lines: { readonly added: number; readonly removed: number }): string =>
  `+${String(lines.added)} −${String(lines.removed)} ${lines.added + lines.removed === 1 ? 'line' : 'lines'}`;

// ── What the button says: every write, not just the fleet's ──────────────────────────────────────

/**
 * What the shared apply handler writes besides the fleet: each ticked settings file the source shared,
 * the agent controls, and each sealed key. The button counts these with the reviewed items, so a screen
 * that writes configuration is never labelled "Nothing to copy".
 */
export interface OtherWrites {
  /** Ticked settings files the source shared, which `copy` writes whole. */
  readonly files: number;
  /** The agent controls are ticked and the source answered, so `copy` proposes them. */
  readonly controls: boolean;
  /** API keys that will be sealed across. */
  readonly keys: number;
}

/** How many things the button writes in all: the fleet's, then {@link OtherWrites}. */
export const updateWrites = (
  review: FleetCloneReview,
  picks: ReviewPicks,
  logins: LoginPicks,
  others: OtherWrites,
): number => updateCount(review, picks, logins) + others.files + (others.controls ? 1 : 0) + others.keys;

/** The review lists nothing to write, but names were matched by name alone: finishing only links them. */
export const linksOnly = (review: FleetCloneReview): boolean => nothingDiffers(review) && review.same.probable > 0;

// ── Logins, as the copy settled them ─────────────────────────────────────────────────────────────

/**
 * What each source sign-in becomes on this machine, from the review the person saw and the logins they
 * picked: a login already here (`matched`, or an explicit pick from several that fit) is reused as it is; the
 * rest take the slot the generic rule predicts (`predicted`). The generic rule alone knows nothing of the
 * review, so it would call a chosen login a new slot.
 */
export const reviewedLoginTargets = (
  review: FleetCloneReview,
  picks: LoginPicks,
  predicted: ReadonlyMap<string, CloneLoginTarget>,
): ReadonlyMap<string, CloneLoginTarget> => {
  const settled = new Map(predicted);
  for (const login of review.logins) {
    const target = loginTarget(login, picks);
    if (login.outcome === 'matched')
      settled.set(login.sourceId, { kind: 'matched', id: login.target ?? login.sourceId });
    else if (login.outcome === 'ask' && target !== NEW_SLOT)
      settled.set(login.sourceId, { kind: 'matched', id: target });
  }
  return settled;
};

// ── Local values beside the source's ─────────────────────────────────────────────────────────────

/** One line of a comparison: the value here and the value on the source, `null` when a side has none. */
interface CompareRow {
  readonly label: string;
  readonly here: string | null;
  readonly source: string | null;
  readonly differs: boolean;
}

/** What the comparison for one both-changed item says. */
export type ItemCompare =
  | { readonly kind: 'none' }
  /** This machine's own setup could not be read, so only the source's side is known. */
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'rows'; readonly rows: readonly CompareRow[] };

/** A value long enough to hide the rest of the sheet is cut; the item's own entries show it in full. */
const COMPARE_CLIP = 400;
const clip = (text: string): string => (text.length > COMPARE_CLIP ? `${text.slice(0, COMPARE_CLIP)}…` : text);

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const entityOf = (bundle: FleetCloneBundle, kind: CloneReviewKind, name: string): unknown =>
  kind === 'profile'
    ? bundle.profiles[name]
    : kind === 'runtime'
      ? bundle.runtimes[name]
      : bundle.components[kind]?.[name];

/** The top-level field of an item, as text; a runtime's `login` is the `credential` it stores. */
const fieldText = (entity: unknown, field: string): string | null => {
  if (!isPlain(entity)) return null;
  const value = entity[field === 'login' ? 'credential' : field];
  if (value === undefined) return null;
  return clip(typeof value === 'string' ? value : JSON.stringify(value));
};

/** Each line keyed by its label and how many lines of that label came before it, so repeated labels pair in order. */
const numbered = (
  lines: readonly { readonly label: string; readonly text: string }[],
): readonly (readonly [string, string, string])[] => {
  const counts = new Map<string, number>();
  return lines.map(line => {
    const count = counts.get(line.label) ?? 0;
    counts.set(line.label, count + 1);
    return [`${line.label}\u0000${String(count)}`, line.label, line.text] as const;
  });
};

/** Pairs two lists line by line, the nth line of a label with the nth line of the same label on the other side. */
const pairRows = (
  source: readonly { readonly label: string; readonly text: string }[],
  here: readonly { readonly label: string; readonly text: string }[],
): CompareRow[] => {
  const mine = new Map(numbered(here).map(([key, , text]) => [key, text] as const));
  const theirs = numbered(source);
  const known = new Set(theirs.map(([key]) => key));
  return [
    ...theirs.map(([key, label, text]) => {
      const local = mine.get(key);
      return { label, here: local === undefined ? null : clip(local), source: clip(text), differs: local !== text };
    }),
    ...numbered(here)
      .filter(([key]) => !known.has(key))
      .map(([, label, text]) => ({ label, here: clip(text), source: null, differs: true })),
  ];
};

/**
 * This machine's value beside the source's for an item both sides changed (design §6b). A component that
 * runs something compares what it runs, line by line, from this machine's own export; any other item
 * compares the top-level fields the review named. Documents are compared as documents, by their line diff.
 */
export const compareItem = (
  item: CloneReviewItem,
  here: FleetCloneBundle | null,
  source: FleetCloneBundle | null,
): ItemCompare => {
  const theirs = (item.runnable?.entries ?? []).filter(entry => !entry.document);
  const fields = item.fields ?? [];
  if (theirs.length === 0 && fields.length === 0) return { kind: 'none' };
  if (here === null || cloneBundleProblem(here) !== null) return { kind: 'unreadable' };
  if (theirs.length > 0) {
    const mine = (cloneRunnables(here).find(runnable => runnable.reference === item.ref)?.entries ?? []).filter(
      entry => !entry.document,
    );
    return { kind: 'rows', rows: pairRows(theirs, mine) };
  }
  const kind = item.kind;
  const theirEntity = source === null ? undefined : entityOf(source, kind, reviewItemName(item.sourceRef ?? item.ref));
  const hereEntity = entityOf(here, kind, reviewItemName(item.ref));
  return {
    kind: 'rows',
    rows: fields.map(field => {
      const mine = fieldText(hereEntity, field);
      const their = fieldText(theirEntity, field);
      return { label: field, here: mine, source: their, differs: mine !== their };
    }),
  };
};
