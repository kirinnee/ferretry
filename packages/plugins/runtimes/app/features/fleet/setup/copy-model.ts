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

import { type Instant, InstantSchema } from '@ferretry/std';
import type {
  AccountChange,
  CloneBundle,
  CloneChoice,
  CloneDecisions,
  CloneLoginChoices,
  CloneOutcome,
  CloneReview,
  CloneReviewItem,
  CloneReviewKey,
  CloneKeyChoice,
  CloneReviewRequest,
  CloneSettingsDecisions,
  CloneSettingsDoc,
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
  /** The read itself FAILED (refused, timed out, malformed): this is not an absent file, and no text was read. */
  readonly failed?: boolean | undefined;
}

/** A settings file a copy leaves out, and why: the source showed a gap, or could not be read at all. */
export interface LeftOutSettings {
  readonly path: string;
  readonly why: 'gap' | 'unread';
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
 * The settings documents to hand over. A file the source SAYS it does not have is sent as the empty text, as the daemon
 * reads it; a file the source shows with a gap (a hidden value, an issue) and a file whose read FAILED are left out and
 * named, never sent masked and never sent as if they were empty (an unread file is not an absent one).
 */
export const settingsTexts = (
  files: readonly SourceSettingsRead[],
  machine: Pick<MachineView, 'agentPermissions' | 'defaultRuntime' | 'agentControl'>,
): { readonly settings: readonly CloneSettingsText[]; readonly leftOut: readonly LeftOutSettings[] } => ({
  settings: [
    ...files
      .filter(file => file.failed !== true && (file.issues ?? []).length === 0)
      .map(file => ({ path: file.path, text: file.exists ? file.text : '' })),
    { path: 'controls' as const, text: controlsText(machine) },
  ],
  leftOut: files.flatMap((file): LeftOutSettings[] =>
    file.failed === true
      ? [{ path: file.path, why: 'unread' }]
      : (file.issues ?? []).length > 0
        ? [{ path: file.path, why: 'gap' }]
        : [],
  ),
});

/** One API key the source holds, by NAME and the instant it last changed: never what it holds. */
export interface SourceSecretStamp {
  readonly name: string;
  readonly updatedAt: Instant;
}

/** The most stamps a review takes (`CLONE_SOURCE_SECRETS_LIMIT`); a source with more is reviewed without them. */
const SOURCE_SECRETS_LIMIT = 1_024;

/**
 * The stamps out of the source's secrets listing, read leniently: a listing that is not the shape this reads (an older
 * daemon, a refused call) names no key and says nothing about any. Names and instants only: the listing carries no value.
 */
export const sourceStamps = (listing: unknown): readonly SourceSecretStamp[] => {
  const held = (listing as { secrets?: unknown } | null)?.secrets;
  if (!Array.isArray(held)) return [];
  return held.flatMap((entry: unknown): SourceSecretStamp[] => {
    const { name, updatedAt } = (entry ?? {}) as { name?: unknown; updatedAt?: unknown };
    const instant = InstantSchema.safeParse(updatedAt);
    return typeof name === 'string' && name !== '' && instant.success ? [{ name, updatedAt: instant.data }] : [];
  });
};

/** What each outcome of a key says to the person, and what to do about it. */
export const keyOutcomeSentence = (outcome: CloneReviewKey['outcome'], source: string): string =>
  outcome === 'missing'
    ? `needed here and not stored on this machine: add it here (Secrets, or \`secret set\`) — a copy never carries a key's value, and ${source} keeps its own`
    : outcome === 'newer'
      ? `changed on ${source} since the last copy; this machine keeps the key it has until you replace it here`
      : outcome === 'both'
        ? `changed on both machines since the last copy; this machine keeps its own`
        : 'already the same here';

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
  /** The keys the source holds, so the review can say which a copied setup needs and this machine lacks. */
  readonly sourceSecrets?: readonly SourceSecretStamp[];
}): CloneReviewRequest => ({
  bundle: input.bundle as unknown as Record<string, unknown>,
  source: { daemonId: input.source.daemonId },
  names: { source: input.source.name, target: input.targetName },
  settings: [...input.settings],
  ...(input.sourceSecrets === undefined ||
  input.sourceSecrets.length === 0 ||
  input.sourceSecrets.length > SOURCE_SECRETS_LIMIT
    ? {}
    : { sourceSecrets: input.sourceSecrets.map(stamp => ({ name: stamp.name, updatedAt: stamp.updatedAt })) }),
});

/** Which way a first copy goes where this machine already has a setup: next to it, or in its place. */
export type CopyMode = 'alongside' | 'replace';

/**
 * Which settings documents the person includes, and for each key what to do with it. A key both machines changed has
 * NO default, so it is absent until the person decides it. Nothing is included on the person's behalf in a repeat copy
 * (v4: a repeat copy starts with settings unselected); a first copy starts with every document that differs selected,
 * since the machine being set up has nothing of its own to lose.
 */
export interface SettingsPick {
  readonly docs: ReadonlySet<CloneSettingsDoc>;
  readonly keys: Readonly<Record<string, Readonly<Record<string, CloneKeyChoice>>>>;
}

/** The documents a copy can write: those that differ, and are not refused. */
const writableDocs = (review: CloneReview) =>
  review.settings.filter(doc => doc.keys.length > 0 && doc.refused === undefined);

export const initialPick = (review: CloneReview): SettingsPick => ({
  docs: new Set(review.mode === 'first' ? writableDocs(review).map(doc => doc.path) : []),
  keys: Object.fromEntries(
    review.settings.map(doc => [
      doc.path,
      Object.fromEntries(doc.keys.flatMap(key => (key.choice === undefined ? [] : [[key.key, key.choice] as const]))),
    ]),
  ),
});

/** The included keys the person has not decided: both machines changed them, and nothing is written until each is settled. */
export const undecidedKeys = (review: CloneReview, pick: SettingsPick): readonly string[] =>
  review.settings
    .filter(doc => pick.docs.has(doc.path))
    .flatMap(doc =>
      doc.keys.filter(key => pick.keys[doc.path]?.[key.key] === undefined).map(key => `${doc.path}: ${key.key}`),
    );

/** The documents handed over and each key's decision, for the included documents only. */
export const pickedSettings = (
  review: CloneReview,
  request: CloneReviewRequest,
  pick: SettingsPick,
): { readonly settings: readonly CloneSettingsText[]; readonly settingsDecisions: CloneSettingsDecisions } => {
  const included = review.settings.filter(doc => pick.docs.has(doc.path) && doc.refused === undefined);
  const paths = new Set(included.map(doc => doc.path));
  return {
    settings: (request.settings ?? []).filter(doc => paths.has(doc.path)),
    settingsDecisions: Object.fromEntries(
      included.map(doc => [
        doc.path,
        Object.fromEntries(doc.keys.map(key => [key.key, pick.keys[doc.path]?.[key.key] ?? key.choice ?? 'keep'])),
      ]),
    ),
  };
};

export interface CopyChoices {
  /** Items the person LEFT OUT (the ones a copy would run that they do not want): never written. */
  readonly skip: readonly string[];
  readonly mode: CopyMode;
  /** A repeat copy: items the person ticked that the review does not take by default (both machines changed them). */
  readonly take?: readonly string[];
  /** A repeat copy: the settings documents and keys the person included. */
  readonly settings?: SettingsPick;
  /** A repeat copy: which login here each sign-in uses (an id, or `slot`), where the person chose. */
  readonly logins?: Readonly<Record<string, string>>;
  /** Copy everything (alongside or replace) even where the review is a repeat's: the person chose a full copy over an update. */
  readonly full?: boolean;
  /** A full copy: the source's runtime to make this machine's default, `null` for none; absent: the machine decides. */
  readonly defaultRuntime?: string | null;
}

/** The runtimes a copy brings that agents can run: the choices for "default runtime for new agents". */
export const defaultRuntimeCandidates = (bundle: CloneBundle): readonly string[] =>
  Object.entries(bundle.runtimes ?? {})
    .filter(([, runtime]) => (runtime as { agent?: unknown } | null)?.agent !== false)
    .map(([name]) => name);

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
  choices: Pick<CopyChoices, 'skip' | 'take' | 'settings' | 'logins'>,
  request?: CloneReviewRequest,
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
    settingsDecisions:
      choices.settings === undefined || request === undefined
        ? {}
        : pickedSettings(review, request, choices.settings).settingsDecisions,
    logins: Object.fromEntries(
      review.logins.map(login => [login.sourceId, choices.logins?.[login.sourceId] ?? login.target ?? 'slot']),
    ),
  };
};

/** The settings a copy offers, by the name a person knows them by. */
const SETTINGS_LABEL: Readonly<Record<CloneSettingsText['path'], string>> = {
  'warden.yaml': 'Warden',
  'learning.yaml': 'Lessons (learning)',
  'voice.yaml': 'Voice',
  controls: 'Agent controls',
};

/**
 * What a finished copy did NOT bring across, said plainly beside what it did. A first copy imports the fleet (logins,
 * components, profiles, runtimes) and nothing else: the daemon refuses a settings payload for it, so Warden, Lessons,
 * Voice and the agent controls the source offered are named here as NOT copied. Nothing here claims a write that did
 * not happen.
 */
export interface CopyDoneReport {
  /** What the machine said it did: the executor's own sentence. */
  readonly did: string;
  /** Settings the source offered that this copy did not write. */
  readonly notWritten: readonly string[];
  /** Why the settings step did not finish, when it did not. */
  readonly settingsProblem?: string;
  /** Items the person left out. */
  readonly leftOutItems: readonly string[];
  /** Settings files that were not read or not shown whole, and so were not offered. */
  readonly leftOutFiles: readonly string[];
  /** The sign-ins that arrive empty: the person signs in to each on this machine. */
  readonly signIns: readonly string[];
  /** API keys a copied setup needs that this machine does not hold. */
  readonly missingKeys: readonly string[];
}

export const doneReport = (input: {
  readonly review: CloneReview;
  readonly request: CloneReviewRequest;
  readonly skipped: readonly string[];
  readonly leftOut: readonly LeftOutSettings[];
  readonly did: string;
  /** The settings documents the source offered that were NOT written, by path. Absent: a first copy wrote none. */
  readonly notWritten?: readonly CloneSettingsDoc[];
  /** Why the settings step did not finish, when it did not. */
  readonly settingsProblem?: string;
}): CopyDoneReport => {
  const { review, request } = input;
  const offered = (request.settings ?? []).map(doc => doc.path);
  return {
    did: input.did,
    notWritten: (input.notWritten ?? (review.mode === 'first' ? offered : [])).map(path => SETTINGS_LABEL[path]),
    ...(input.settingsProblem === undefined ? {} : { settingsProblem: input.settingsProblem }),
    leftOutItems: input.skipped,
    leftOutFiles: input.leftOut.map(entry => entry.path),
    signIns: review.logins.filter(login => login.outcome !== 'matched').map(login => login.sourceId),
    missingKeys: review.keys.filter(key => key.outcome === 'missing').map(key => key.name),
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
  if (review.mode === 'first' || choices.full === true)
    return {
      ...shared,
      mode: choices.mode,
      ...(choices.skip.length === 0 ? {} : { skip: [...choices.skip] }),
      ...(choices.defaultRuntime === undefined ? {} : { defaultRuntime: choices.defaultRuntime }),
    };
  const decided = decisionsFor(review, choices, request);
  const picked = choices.settings === undefined ? undefined : pickedSettings(review, request, choices.settings);
  return {
    ...shared,
    mode: 'update',
    decisions: decided.decisions,
    logins: decided.logins,
    reviewed: review.fingerprint,
    ...(picked === undefined || picked.settings.length === 0
      ? {}
      : { settings: [...picked.settings], settingsDecisions: picked.settingsDecisions }),
  };
};

/**
 * The second step of a first copy: the settings, as a reviewed REPEAT copy of the same source (the daemon merges
 * settings key by key only against a record of an earlier copy, which the first copy has just written). Every item is
 * left as it is — what the person left out of the first step is not brought in by the back door — and only the
 * included documents are written, each key by the person's choice.
 */
export const followupChange = (input: {
  readonly review: CloneReview;
  readonly request: CloneReviewRequest;
  readonly pick: SettingsPick;
}): AccountChange => {
  const { review, request, pick } = input;
  const decided = decisionsFor(review, { skip: review.items.map(item => item.ref) }, request);
  const picked = pickedSettings(review, request, pick);
  return {
    kind: 'clone.import',
    bundle: request.bundle,
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.names === undefined ? {} : { names: request.names }),
    mode: 'update',
    decisions: decided.decisions,
    logins: decided.logins,
    reviewed: review.fingerprint,
    settings: [...picked.settings],
    settingsDecisions: picked.settingsDecisions,
  };
};

/** Whether a review has settings a copy could write. */
export const hasWritableSettings = (review: CloneReview): boolean => writableDocs(review).length > 0;

/** How many of the review's items stand each way, for the summary line. */
export const outcomeCounts = (review: CloneReview): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const item of review.items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return counts;
};
