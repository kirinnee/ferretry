/**
 * A repeat copy's settings, key by key (docs/design/account-model.md §5, docs/config-files.md "Copy and Export"),
 * as data: what the browser sends for review, what it shows, what it still needs from the person, and what it sends
 * back to apply.
 *
 * The daemon decides every outcome. This file only reads its review and builds the decisions:
 *
 * - **Nothing is chosen for a key both machines changed.** It stays unpicked until the person picks, and
 *   {@link undecidedKeys} is what keeps the Copy button off.
 * - **Values are config text.** A `${secret:NAME}` stays a reference; no route returns a secret value, so there is
 *   none to show.
 * - **Only settings are decided here.** Every item in the review is left as it is ({@link keepItemsDecisions}); the
 *   existing fleet copy still does the items.
 *
 * Pure: the review, the source's files and the picks in; rows and a change out.
 */
import type {
  CloneKeyChoice,
  CloneOutcome,
  CloneReviewItem,
  CloneSettingsDecisions,
  CloneSettingsDoc,
  CloneSettingsText,
  FleetCloneReview,
  FleetMachineView,
} from '@ferretry/protocol';
import { CLONE_SETTINGS_FILES, type CloneItemId, type SourceSettingsFile } from './clone-settings-model.ts';

export type ReviewedSettings = FleetCloneReview['settings'][number];
type ReviewedKey = ReviewedSettings['keys'][number];

/** Which settings item (a checkbox) each reviewed document belongs to. */
const ITEM_OF: Readonly<Record<CloneSettingsDoc, CloneItemId>> = {
  'warden.yaml': 'warden',
  'learning.yaml': 'learning',
  'voice.yaml': 'voice',
  controls: 'controls',
};

/** The document a settings item is, or none for the fleet. */
export const settingsDocOf = (item: CloneItemId): CloneSettingsDoc | undefined =>
  (Object.keys(ITEM_OF) as CloneSettingsDoc[]).find(doc => ITEM_OF[doc] === item);

/**
 * The source's controls as the document the daemon compares: only what the source reports. An unset default
 * runtime is left out, not sent as null, so "the source has none" and "the source says nothing" read alike.
 */
export const controlsText = (machine: FleetMachineView): string =>
  JSON.stringify({
    agentPermissions: machine.agentPermissions,
    ...(machine.defaultRuntime === null ? {} : { defaultRuntime: machine.defaultRuntime }),
    agentControl: machine.agentControl,
  });

/**
 * The documents to send for review: one per ticked settings item the source could be read for. A file the source has
 * none of is the empty text (it runs on defaults), which the daemon reads as "nothing set".
 */
export const settingsToSend = (
  chosen: readonly CloneItemId[],
  files: ReadonlyMap<string, SourceSettingsFile>,
  sourceMachine: FleetMachineView | null,
): readonly CloneSettingsText[] => {
  const sent: CloneSettingsText[] = [];
  for (const item of CLONE_SETTINGS_FILES) {
    const file = files.get(item.file);
    if (!chosen.includes(item.id) || file === undefined) continue;
    sent.push({ path: item.file as CloneSettingsDoc, text: file.exists ? file.text : '' });
  }
  if (chosen.includes('controls') && sourceMachine !== null) {
    sent.push({ path: 'controls', text: controlsText(sourceMachine) });
  }
  return sent;
};

// ── Picks ────────────────────────────────────────────────────────────────────────────────────────

/** What the person picked, by `<document>\u0000<key>`. Nothing is in it until they pick. */
export type SettingsPicks = ReadonlyMap<string, CloneKeyChoice>;

export const pickId = (path: string, key: string): string => `${path}\u0000${key}`;

/** The choice in force for one key: the person's pick, else the daemon's default (none for a key both changed). */
export const choiceFor = (path: string, row: ReviewedKey, picks: SettingsPicks): CloneKeyChoice | undefined =>
  picks.get(pickId(path, row.key)) ?? row.choice;

/** Every key still waiting for a choice, as `warden.yaml: caps.jevUsdPerDay`: the Copy button stays off while any is. */
export const undecidedKeys = (documents: readonly ReviewedSettings[], picks: SettingsPicks): readonly string[] =>
  documents.flatMap(document =>
    document.keys
      .filter(row => choiceFor(document.path, row, picks) === undefined)
      .map(row => `${document.path}: ${row.key}`),
  );

/** Documents the daemon will not copy, and why: the Copy button stays off until they are left out. */
export const refusedDocuments = (
  documents: readonly ReviewedSettings[],
): readonly { readonly path: CloneSettingsDoc; readonly why: string }[] =>
  documents.flatMap(document =>
    document.refused === undefined ? [] : [{ path: document.path, why: document.refused }],
  );

/** Every key's choice, explicit, for `settingsDecisions`. A key with no choice is left out (and the daemon refuses). */
export const settingsDecisions = (
  documents: readonly ReviewedSettings[],
  picks: SettingsPicks,
): CloneSettingsDecisions => {
  const decisions: Partial<Record<CloneSettingsDoc, Record<string, CloneKeyChoice>>> = {};
  for (const document of documents) {
    const keys: Record<string, CloneKeyChoice> = {};
    for (const row of document.keys) {
      const choice = choiceFor(document.path, row, picks);
      if (choice !== undefined) keys[row.key] = choice;
    }
    if (Object.keys(keys).length > 0) decisions[document.path] = keys;
  }
  return decisions;
};

/**
 * Leave every item the review lists exactly as it is: `skip` for one that is new here, `keep` for the rest. The
 * settings update then writes settings only, and the fleet copy beside it does the items as it always has.
 */
export const keepItemsDecisions = (items: readonly CloneReviewItem[]): Record<string, 'keep' | 'skip'> =>
  Object.fromEntries(items.map(item => [item.ref, item.outcome === 'new' ? 'skip' : 'keep'] as const));

// ── The default runtime ──────────────────────────────────────────────────────────────────────────

const DEFAULT_RUNTIME = 'defaultRuntime';

/**
 * When the fleet is copied, the default runtime is the "Default runtime for new agents" picker's: it may name a
 * runtime the copy is about to bring (or add as `-2`), which the settings-only update that runs first could not
 * yet resolve. The row is left as it is there ("keep"), so the update never names a runtime this machine lacks.
 */
export const defaultRuntimeToPicker = (documents: readonly ReviewedSettings[]): readonly ReviewedSettings[] =>
  documents.map(document =>
    document.path === 'controls'
      ? {
          ...document,
          keys: document.keys.map(row => (row.key === DEFAULT_RUNTIME ? { ...row, choice: 'keep' as const } : row)),
        }
      : document,
  );

/**
 * The picks without one on that row. A saved pick outranks a row's own choice, so a Take made while the fleet was
 * unticked would otherwise survive re-ticking it and still reach the settings-only update that runs first.
 */
export const withoutDefaultRuntimePick = (picks: SettingsPicks): SettingsPicks =>
  new Map([...picks].filter(([id]) => id !== pickId('controls', DEFAULT_RUNTIME)));

/** The same documents without that row, for the screen: the picker below them is where it is decided. */
export const withoutDefaultRuntime = (documents: readonly ReviewedSettings[]): readonly ReviewedSettings[] =>
  documents.map(document =>
    document.path === 'controls'
      ? { ...document, keys: document.keys.filter(row => row.key !== DEFAULT_RUNTIME) }
      : document,
  );

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

const OUTCOME_WORDS: Readonly<Record<CloneOutcome, (source: string) => string>> = {
  new: source => `New on ${source}`,
  theirs: source => `Changed on ${source}`,
  mine: () => 'Changed here, kept',
  both: () => 'Changed on both',
  gone: source => `${source} no longer sets it`,
  'removed-here': () => 'You removed it here',
};

export const outcomeWords = (outcome: CloneOutcome, source: string): string => OUTCOME_WORDS[outcome](source);

/** What taking a key does, in a few words, for its checkbox. */
export const takeWords = (row: ReviewedKey, source: string): string =>
  row.outcome === 'gone' ? 'Remove it here too' : row.outcome === 'new' ? `Add it from ${source}` : `Use ${source}’s`;

/** The review's documents for the ticked settings items only, in the order the checkboxes list them. */
export const reviewedFor = (review: FleetCloneReview, chosen: readonly CloneItemId[]): readonly ReviewedSettings[] =>
  review.settings.filter(document => chosen.includes(ITEM_OF[document.path]));

/** A document's name for the screen. */
export const documentLabel = (path: CloneSettingsDoc): string =>
  path === 'controls' ? 'Agent controls and default runtime' : path;
