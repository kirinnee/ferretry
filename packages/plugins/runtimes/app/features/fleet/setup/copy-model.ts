/**
 * Copy settings from another machine, as data (docs/design/account-model.md §3.8, §4.7).
 *
 * The browser holds both machines: it reads the source's export and its settings, asks THIS machine to review them
 * (`POST /v1/runtimes/clone/review`) and hands the same data back as ONE reviewed change, `clone.import`. No machine
 * talks to another, and nothing here can carry a secret value: the export holds none, a settings file the source does
 * not show whole is not sent, and the review names a key, never what it holds.
 *
 * Pure: reads in, the request and the change out.
 */

import type {
  AccountChange,
  CloneBundle,
  CloneChoice,
  CloneDecisions,
  CloneLoginChoices,
  CloneOutcome,
  CloneReview,
  CloneReviewItem,
  CloneReviewRequest,
  CloneSettingsDecisions,
  CloneSettingsText,
  MachineView,
} from '../../../../contract/index.ts';

/** The settings documents a copy reads from a source's files. */
export const SETTINGS_FILES = ['warden.yaml', 'learning.yaml', 'voice.yaml'] as const;

/** One of the source's settings files as `GET /v1/config/file` answered. */
export interface SourceSettingsRead {
  readonly path: (typeof SETTINGS_FILES)[number];
  readonly exists: boolean;
  readonly text: string;
  readonly issues?: readonly unknown[] | undefined;
}

/** The source's machine controls as the document a copy compares (`agentPermissions`, `defaultRuntime`, `agentControl`). */
export const controlsText = (
  machine: Pick<MachineView, 'agentPermissions' | 'defaultRuntime' | 'agentControl'>,
): string =>
  JSON.stringify({
    agentPermissions: machine.agentPermissions,
    ...(machine.defaultRuntime === null ? {} : { defaultRuntime: machine.defaultRuntime }),
    agentControl: machine.agentControl,
  });

/**
 * The settings documents to hand over. A file the source does not have is sent as the empty text, as the daemon reads
 * it; a file the source shows with a gap (a hidden value, an issue) is left out and named, never sent masked.
 */
export const settingsTexts = (
  files: readonly SourceSettingsRead[],
  machine: Pick<MachineView, 'agentPermissions' | 'defaultRuntime' | 'agentControl'>,
): { readonly settings: readonly CloneSettingsText[]; readonly leftOut: readonly string[] } => ({
  settings: [
    ...files
      .filter(file => (file.issues ?? []).length === 0)
      .map(file => ({ path: file.path, text: file.exists ? file.text : '' })),
    { path: 'controls' as const, text: controlsText(machine) },
  ],
  leftOut: files.filter(file => (file.issues ?? []).length > 0).map(file => file.path),
});

export interface CopySource {
  readonly daemonId: string;
  readonly name: string;
}

/** The review's request: the bundle, who it came from, and what each machine is called. */
export const reviewRequest = (input: {
  readonly bundle: CloneBundle;
  readonly source: CopySource;
  readonly targetName: string;
  readonly settings: readonly CloneSettingsText[];
}): CloneReviewRequest => ({
  bundle: input.bundle as unknown as Record<string, unknown>,
  source: { daemonId: input.source.daemonId },
  names: { source: input.source.name, target: input.targetName },
  settings: [...input.settings],
});

/** Which way a first copy goes where this machine already has a setup: next to it, or in its place. */
export type CopyMode = 'alongside' | 'replace';

export interface CopyChoices {
  /** Items the person LEFT OUT (the ones a copy would run that they do not want): never written. */
  readonly skip: readonly string[];
  readonly mode: CopyMode;
  /** A repeat copy: items the person ticked that the review does not take by default (both machines changed them). */
  readonly take?: readonly string[];
}

/** The refs a copy would run: every item the review shows a `runnable` for. */
export const runnableRefs = (review: CloneReview): readonly string[] =>
  review.items.filter(item => item.runnable !== undefined).map(item => item.ref);

/** What an item's choice does to this machine: it writes the source's version (or removes), or leaves things as they are. */
const WRITES: ReadonlySet<CloneChoice> = new Set(['take', 'add', 'remove']);

/** Whether the review would write this item by default. An item both machines changed has no default and writes nothing. */
export const writesByDefault = (item: CloneReviewItem): boolean => item.choice !== undefined && WRITES.has(item.choice);

/** The choice that leaves an item as it is here, for the outcome it stands at. */
export const leaveOutChoice = (outcome: CloneOutcome): CloneChoice => (outcome === 'new' ? 'skip' : 'keep');

/** The choice that writes the source's version of an item, for the outcome it stands at. */
export const writeChoice = (outcome: CloneOutcome): CloneChoice =>
  outcome === 'new' || outcome === 'removed-here' ? 'add' : outcome === 'gone' ? 'remove' : 'take';

/**
 * The per-item and per-key decisions a repeat copy sends. Nothing is invented in the direction of writing: a choice the
 * review made is kept, an item or key both machines changed (no default) is KEPT as it is here unless the person ticked
 * it, and an item they left out is kept or skipped.
 */
export const decisionsFor = (
  review: CloneReview,
  choices: Pick<CopyChoices, 'skip' | 'take'>,
): {
  readonly decisions: CloneDecisions;
  readonly settingsDecisions: CloneSettingsDecisions;
  readonly logins: CloneLoginChoices;
} => {
  const skipped = new Set(choices.skip);
  const taken = new Set(choices.take ?? []);
  const itemChoice = (item: CloneReviewItem): CloneChoice =>
    skipped.has(item.ref)
      ? leaveOutChoice(item.outcome)
      : taken.has(item.ref)
        ? writeChoice(item.outcome)
        : (item.choice ?? leaveOutChoice(item.outcome));
  return {
    decisions: Object.fromEntries(review.items.map(item => [item.ref, itemChoice(item)])),
    settingsDecisions: Object.fromEntries(
      review.settings.map(doc => [doc.path, Object.fromEntries(doc.keys.map(key => [key.key, key.choice ?? 'keep']))]),
    ),
    logins: Object.fromEntries(review.logins.map(login => [login.sourceId, login.target ?? 'slot'])),
  };
};

/** The one `clone.import` this review and these choices make. */
export const copyChange = (input: {
  readonly review: CloneReview;
  readonly request: CloneReviewRequest;
  readonly choices: CopyChoices;
}): AccountChange => {
  const { review, request, choices } = input;
  const shared = {
    kind: 'clone.import' as const,
    bundle: request.bundle,
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.names === undefined ? {} : { names: request.names }),
  };
  if (review.mode === 'first')
    return { ...shared, mode: choices.mode, ...(choices.skip.length === 0 ? {} : { skip: [...choices.skip] }) };
  const decided = decisionsFor(review, choices);
  return {
    ...shared,
    mode: 'update',
    decisions: decided.decisions,
    logins: decided.logins,
    reviewed: review.fingerprint,
    ...(request.settings === undefined ? {} : { settings: request.settings }),
    settingsDecisions: decided.settingsDecisions,
  };
};

/** How many of the review's items stand each way, for the summary line. */
export const outcomeCounts = (review: CloneReview): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const item of review.items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return counts;
};
