/**
 * Copy settings from another machine — Clone v2 (docs/design/account-model.md §4.7, E27–E31; spec R6).
 *
 * **Source** → **Preview** → **Existing setup** (only when this machine already has profiles or
 * runtimes AND they are being copied) → **Done**. The browser holds both connections, so no machine
 * talks to another: it reads the source through the source's own connection and writes here through
 * this one.
 *
 * WHAT IS COPIED IS CHOSEN, item by item (`clone-settings-model.ts`):
 *
 * - **Profiles, components, runtimes and logins** — the source's export, handed to this machine as ONE
 *   reviewed change, `clone.import`. The Preview lists everything it would RUN here — each MCP
 *   server's command line, each hook, each runnable setting and document — with a box to leave any of
 *   them out, and the change names the source by the daemon id this browser paired with.
 * - **Warden**, **Learning defaults**, **Voice clean-up** — the source's `warden.yaml`, `learning.yaml`
 *   and `voice.yaml`, written here as files. The daemon validates each one, and HOLDS a file that
 *   loosens spend or authority until the owner confirms it; Done offers Confirm on those.
 * - **Agent controls and default runtime** — the source's machine settings, as one reviewed change.
 *
 * API-KEY LOGINS COPY WITH THEIR KEYS; SIGN-INS DO NOT (owner decision 2026-10-20, docs/secrets.md). The
 * Preview splits the logins: an environment login travels as variables and secret NAMES, and the keys the
 * copied setup needs follow in ONE sealed copy the source confirms with a passkey, so the cloned runtime
 * works on arrival. A Claude Code or Codex sign-in is marked "Sign in on <machine>" and arrives as an empty
 * slot; Done offers a Sign in button for each, and **Sign in once for n runtimes** on the busiest (E31).
 * The Preview still lists every secret and sign-in the copied settings need, with a field to add a secret
 * now, and **Copy secrets from <source>…** for anything else, picked by name.
 */

import {
  CLONE_REVIEW_STALE,
  CLONE_SOURCE_SECRETS_LIMIT,
  type CloneChoice,
  type CloneKeyChoice,
  type CloneLoginTarget,
  type CloneRunnable,
  type CloneSettingsDoc,
  type ConfigStatusView,
  type FleetCloneBundle,
  type FleetCloneReview,
  type FleetCredentialView,
  isSignInSecretName,
  type SpeedupsView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import {
  configInvalidBody,
  confirmConfigChange,
  readConfigFile,
  readConfigStatus,
  writeConfigFile,
} from '../../config-files/config-files-api.ts';
import { copySecrets as sealSecretsAcross } from '../../secrets/secret-clone-api.ts';
import { copyRefusalSentence } from '../../secrets/secret-clone-model.ts';
import { SecretCopyLauncher } from '../../secrets/secret-copy-panel.tsx';
import { listSecrets, putSecret } from '../../secrets/secrets-api.ts';
import { daemonDisplayName } from '../../settings/daemon-settings.tsx';
import { readSpeedups } from '../../speedups/speedups-api.ts';
import { readFleetMachine, readFleetProfiles } from '../catalog-api.ts';
import { readFleetCredentials } from '../credentials-api.ts';
import { readFleetExport, recordCloneKeys, reviewFleetClone } from '../setup-api.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { type MachineReach, readMachineReach } from '../shell/machine-reach.ts';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { currentFlow, type StepperState, startStepper, stepForward, withSteps } from '../shell/stepper-model.ts';
import {
  CLONE_FLOW_KIND,
  CLONE_NO_DEFAULT,
  type CloneChoiceMode,
  type ClonePreview,
  cloneDefaultView,
  clonePreview,
  cloneSharesSentence,
  cloneSlots,
  cloneSourceState,
  cloneSteps,
  cloneUpdateSteps,
  copiesRows,
  existingSentence,
  runnableTitle,
  updateSentence,
} from './clone-model.ts';
import { CloneReviewSheet, RunnableEntries } from './clone-review.tsx';
import {
  applyHold,
  chooseItem,
  compareItem,
  isStaleReview,
  type LoginPicks,
  lastCopiedWords,
  linksOnly,
  loginChoices,
  nothingDiffers,
  type OtherWrites,
  type ReviewOutcomeGroup,
  type ReviewPicks,
  reviewDecisions,
  reviewedLoginTargets,
  reviewOutcomes,
  sameNames,
  unchosenBoth,
  updateLabel,
  updateWrites,
} from './clone-review-model.ts';
import {
  choiceFor,
  defaultRuntimeToPicker,
  keepItemsDecisions,
  pickId,
  refusedDocuments,
  reviewedFor,
  type SettingsPicks,
  settingsDecisions,
  settingsDocOf,
  settingsToSend,
  undecidedKeys,
  withoutDefaultRuntimePick,
  withoutDefaultRuntime,
} from './clone-settings-merge.ts';
import { CloneSettingsKeys } from './clone-settings-keys.tsx';
import {
  CloneItemsChoices,
  CloneKeysBox,
  CloneLoginsSection,
  CloneNeedsList,
  CloneOutcomes,
  DefaultRuntimeChoice,
} from './clone-settings.tsx';
import {
  ALL_CLONE_ITEMS,
  CLONE_ITEMS,
  CLONE_KEYS_ITEM,
  CLONE_SETTINGS_FILES,
  type CloneItem,
  type CloneItemId,
  type CloneItemOutcome,
  type CloneNeed,
  type CloneOutcomeItem,
  cloneLogins,
  cloneLoginTargets,
  cloneNeeds,
  controlsChange,
  filedKeyStamps,
  keysToCopy,
  type NewerKey,
  newerKeys,
  needsAfterCopy,
  type SourceSettingsFile,
  signInLink,
  sourceItemSummary,
} from './clone-settings-model.ts';
import { machineItemHash } from './settings-route.ts';
import { type Guarded, useSetupAccess } from './setup-access.ts';
import { RadioChoices, SetupNote, SetupRow, SetupSection, TOUCH_BUTTON } from './setup-ui.tsx';
import { closedSentence, countWords, listWords, SETUP_HARNESS_NAMES } from './setup-words.ts';

export interface CloneMachineProps extends MachineTabProps {
  /** Every OTHER machine this browser has paired. */
  readonly sources: readonly DaemonConnectionRecord[];
  readonly onDone: () => void;
  readonly onLeave: () => void;
  /** What Done's main button says; Settings goes to Runtimes, New machine setup continues. */
  readonly doneLabel?: string;
  /** Told the source's name once the copy has run, so a caller can say where the settings came from. */
  readonly onCopied?: (source: string) => void;
  /** `embedded` inside New machine setup's Start from step: no stepper of its own on screen. */
  readonly presentation?: 'inline' | 'embedded';
}

interface CloneResult {
  readonly source: string;
  readonly summary: string | null;
  readonly preview: ClonePreview | null;
  readonly slots: readonly FleetCredentialView[];
  /** What each source sign-in became here: a login this machine already had, or the slot the copy made. */
  readonly logins: ReadonlyMap<string, CloneLoginTarget>;
  /** This machine's logins after the copy, for their sign-in state. */
  readonly after: readonly FleetCredentialView[];
  readonly outcomes: readonly { readonly item: CloneOutcomeItem; readonly outcome: CloneItemOutcome }[];
  /** The source as the person names it, for the Done sentences. */
  readonly sourceName: string;
  /** An Update's outcome per group (added, updated, removed, kept); empty for the other two copies. */
  readonly updated: readonly ReviewOutcomeGroup[];
}

function Foot({ children }: { readonly children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap gap-3">{children}</div>;
}

/** A key the source holds and when it last changed it: names and instants, never a value. */
type SourceStamp = { readonly name: string; readonly updatedAt: string };

/**
 * How asking this machine to review the settings ended. `unsupported` is a machine that positively has no such
 * route (an older version): the only case the settings are copied whole, and the screen says so first. Every other
 * failure is `failed`: nothing is copied until it is reviewed.
 */
type SettingsReview =
  | { readonly kind: 'none' }
  | { readonly kind: 'reviewed'; readonly review: FleetCloneReview }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly sentence: string };

const isUnknownRoute = (error: unknown): boolean =>
  error instanceof FyHttpError && error.status === 404 && error.code === 'unknown_route';

const reasonOf = (error: unknown): string => {
  const invalid = configInvalidBody(error);
  return invalid === undefined
    ? changeRefusalSentence(error)
    : invalid.issues
        .filter(issue => issue.severity === 'error')
        .map(issue => `${issue.message} (${issue.fix})`)
        .join(' ');
};

export function CloneMachine(props: CloneMachineProps) {
  const {
    sources,
    machineName,
    machine,
    connection,
    createClient,
    online,
    checking,
    onRetry,
    onDone,
    onLeave,
    doneLabel = 'Go to Runtimes',
    onCopied,
    presentation = 'inline',
  } = props;
  const target = useSetupAccess({ connection, createClient });
  const { changes } = target;
  const [reach, setReach] = useState<ReadonlyMap<DaemonId, MachineReach>>(new Map());
  const [picked, setPicked] = useState<DaemonId | null>(null);
  const pickedRecord = sources.find(source => source.daemonId === picked);
  const source = useSetupAccess({ connection: pickedRecord ?? connection, createClient });
  const [bundle, setBundle] = useState<FleetCloneBundle | null>(null);
  const [files, setFiles] = useState<ReadonlyMap<string, SourceSettingsFile>>(new Map());
  const [speedups, setSpeedups] = useState<SpeedupsView | null>(null);
  const [held, setHeld] = useState<readonly string[]>([]);
  // The names the SOURCE holds (never values), so only a key it really has is asked for; `null` when unread.
  const [sourceSecrets, setSourceSecrets] = useState<readonly string[] | null>(null);
  // When the SOURCE last changed each key it holds (its own list's `updatedAt`; instants, never values).
  const [sourceStamps, setSourceStamps] = useState<ReadonlyMap<string, string>>(new Map());
  // The keys the source changed since the last copy (this machine decides from timestamps): reported, never copied.
  const [offeredKeys, setOfferedKeys] = useState<readonly NewerKey[]>([]);
  const [copyKeys, setCopyKeys] = useState(true);
  const [chosen, setChosen] = useState<readonly CloneItemId[]>(ALL_CLONE_ITEMS);
  const [sourceIssue, setSourceIssue] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [profiles, setProfiles] = useState(0);
  const [mode, setMode] = useState<CloneChoiceMode>('alongside');
  // This machine's review of what the source sent: for an Update, what differs from the copy of the source made
  // before (every item, login and key); for a copy of the settings, key by key what differs (design §5). One review,
  // so one fingerprint is what the apply names. `null` for a first copy that sends no settings.
  const [review, setReview] = useState<FleetCloneReview | null>(null);
  // The newest Update review made with NO settings sent: its fingerprint names the fleet alone. Finish and link
  // writes only that link and sends no settings, so it names this review, never the settings-bound one on screen
  // (a ticked document, even one identical here, is part of that fingerprint and would make the link stale).
  const [fleetReview, setFleetReview] = useState<FleetCloneReview | null>(null);
  // Whether any settings file the source shared differs from this machine, from the review asked with all of them:
  // an Update whose fleet part is empty still offers them, so a settings-only difference is not "nothing to copy".
  const [settingsDiffer, setSettingsDiffer] = useState(false);
  // What the person picked for each item an Update lists, and which login each sign-in goes to.
  const [picks, setPicks] = useState<ReviewPicks>({});
  const [loginPicks, setLoginPicks] = useState<LoginPicks>({});
  // This machine's own documents and logins, read only so a changed file can show a line diff against them.
  const [mineFiles, setMineFiles] = useState<ReadonlyMap<string, string>>(new Map());
  // This machine's own export, read for the same reason: an item both sides changed shows its value here.
  const [hereBundle, setHereBundle] = useState<FleetCloneBundle | null>(null);
  const [hereLogins, setHereLogins] = useState<readonly FleetCredentialView[]>([]);
  const [skip, setSkip] = useState<readonly string[]>([]);
  // Why there is no review although settings were ticked: this machine cannot review (older), or the review failed.
  const [reviewIssue, setReviewIssue] = useState<Exclude<SettingsReview, { kind: 'none' | 'reviewed' }> | null>(null);
  // What the person picked for each settings key the review lists, by document and key.
  const [keyPicks, setKeyPicks] = useState<SettingsPicks>(new Map());
  // The review is being made again (a settings item was ticked or unticked): the apply names one review, so wait.
  const [reviewing, setReviewing] = useState(false);
  // What the person picked for "Default runtime for new agents": a source runtime name, null for none, undefined until they pick.
  const [defaultPick, setDefaultPick] = useState<string | null | undefined>(undefined);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [stepper, setStepper] = useState<StepperState>(() =>
    startStepper({
      kind: CLONE_FLOW_KIND,
      title: 'Copy settings from another machine',
      steps: cloneSteps(false),
      leave: { question: 'Stop copying?', consequence: 'Nothing is copied.', stopLabel: 'Stop, copy nothing' },
      leaveWithoutConfirm: true,
    }),
  );

  // Each other machine answers once, through its own connection, so offline and not-set-up are known (E27).
  const listed = useRef(sources);
  listed.current = sources;
  const sourceKey = sources.map(record => record.daemonId).join(' ');
  useEffect(() => {
    let live = true;
    for (const record of listed.current.filter(candidate =>
      sourceKey.split(' ').includes(String(candidate.daemonId)),
    )) {
      void readMachineReach(() => createClient(record)).then(next => {
        if (live) setReach(current => new Map(current).set(record.daemonId, next));
      });
    }
    return () => {
      live = false;
    };
  }, [createClient, sourceKey]);

  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    void latest.current
      .read(client => readFleetProfiles(client))
      .then(answer => {
        if (answer.kind === 'done') setProfiles(answer.value.profiles.length);
      });
  }, []);

  /** The secret names this machine holds, read again after every add. Names only: there is no value route. */
  const readHeld = useCallback(async (): Promise<void> => {
    const answer = await latest.current.read(client => listSecrets(client));
    if (answer.kind === 'done') setHeld(answer.value.secrets.map(secret => secret.name));
  }, []);

  const addSecret = useCallback(
    async (name: string, value: string): Promise<string | null> => {
      const stored = await latest.current.read(client => putSecret(client, name, value));
      if (stored.kind === 'refused') return stored.sentence;
      await readHeld();
      return null;
    },
    [readHeld],
  );

  const runtimeCount = machine?.runtimeCount ?? 0;
  const copiesFleet = chosen.includes('fleet');
  const updating = review !== null && review.mode === 'update';
  const hasSetup = copiesFleet && (runtimeCount > 0 || profiles > 0);
  const steps = updating ? cloneUpdateSteps() : cloneSteps(hasSetup);
  const state = withSteps(stepper, steps);
  const at = currentFlow(state).at;
  const next = (): void => setStepper(stepForward(state));
  const preview = bundle === null ? null : clonePreview(bundle, machine, skip);
  const pickedReach = picked === null ? undefined : reach.get(picked);
  // The settings items the daemon reviewed, and what still stops the copy: a setting changed on both machines with
  // no pick, or a document it will not copy. Nothing is picked for the person.
  const perKeyItems =
    review === null ? [] : chosen.filter(id => review.settings.some(document => settingsDocOf(id) === document.path));
  const reviewedAll = review === null ? [] : reviewedFor(review, chosen);
  // With the fleet copied by a first copy, the default runtime is the picker's, not a row: see `defaultRuntimeToPicker`.
  // An Update has no picker: it decides the settings in the same apply as the items, against the model that apply
  // makes, so the default runtime is a row like any other.
  const defaultByPicker = copiesFleet && !(updating && mode === 'update');
  const reviewedSettings = defaultByPicker ? defaultRuntimeToPicker(reviewedAll) : reviewedAll;
  const shownSettings = defaultByPicker ? withoutDefaultRuntime(reviewedAll) : reviewedAll;
  const settingsPicks = defaultByPicker ? withoutDefaultRuntimePick(keyPicks) : keyPicks;
  const undecided = undecidedKeys(reviewedSettings, settingsPicks);
  const refused = refusedDocuments(reviewedSettings);
  const blockedBy = reviewing
    ? 'Checking what differs…'
    : reviewIssue?.kind === 'failed'
      ? `Couldn’t check what differs in the settings you ticked, so none of them is copied yet: ${closedSentence(reviewIssue.sentence)}`
      : refused.length > 0
        ? `${refused[0]?.why ?? ''} Untick it to copy the rest.`
        : undecided.length > 0
          ? `Choose for ${countWords(undecided.length, 'setting')} changed on both machines: ${undecided.join(', ')}.`
          : null;
  const sourceMachine = pickedReach?.kind === 'online' ? pickedReach.machine : null;
  // The person's name for the source (`Liftoff EC2`); the bundle's own `machine` is only what it called itself, often a hostname.
  const sourceName = pickedRecord === undefined ? (bundle?.machine ?? '') : daemonDisplayName(pickedRecord);
  const defaultView =
    bundle === null
      ? null
      : cloneDefaultView({
          bundle,
          mode: mode === 'replace' ? 'replace' : 'alongside',
          machineName,
          targetDefault: machine?.defaultRuntime ?? undefined,
          sourceDefault: chosen.includes('controls') ? (sourceMachine?.defaultRuntime ?? undefined) : undefined,
          picked: defaultPick,
        });

  /**
   * What the ticked settings would change here, key by key. The apply names this review's fingerprint, so it is made
   * with exactly what the apply will send; ticking another settings item reviews again. A machine that has no such
   * route (an older daemon) is the one case the settings are copied whole as they always were, and the screen says so;
   * any other failure blocks the copy until the review is made. An Update is reviewed even with no settings ticked
   * (`always`): its review is the one its items are decided from.
   */
  const reviewSettings = async (
    exported: FleetCloneBundle,
    read: ReadonlyMap<string, SourceSettingsFile>,
    ticked: readonly CloneItemId[],
    sourceView: typeof sourceMachine,
    always = false,
    stamps: readonly SourceStamp[] = [...sourceStamps].map(([name, updatedAt]) => ({ name, updatedAt })),
  ): Promise<SettingsReview> => {
    const settings = settingsToSend(ticked, read, sourceView);
    if ((settings.length === 0 && !always) || pickedRecord === undefined) return { kind: 'none' };
    try {
      const client = await createClient(connection);
      const made = await reviewFleetClone(client, {
        bundle: { ...exported },
        source: { daemonId: String(pickedRecord.daemonId) },
        names: { source: sourceName, target: machineName },
        ...(settings.length === 0 ? {} : { settings: [...settings] }),
        // The keys the source holds (names and instants), so an Update reports a newer or both-changed key too.
        // (More than the route takes are not sent: no key is reported, and the review is still made.)
        ...(stamps.length === 0 || stamps.length > CLONE_SOURCE_SECRETS_LIMIT ? {} : { sourceSecrets: [...stamps] }),
      });
      return { kind: 'reviewed', review: made };
    } catch (error) {
      return isUnknownRoute(error)
        ? { kind: 'unsupported' }
        : { kind: 'failed', sentence: changeRefusalSentence(error) };
    }
  };

  /**
   * Keep what a review answered: its rows, or why there are none. An Update's screen stands on its review, so a
   * settings review that could not be made leaves that review as it was and says why beside the settings.
   */
  const keepReview = (answer: SettingsReview): void => {
    if (answer.kind === 'reviewed' && answer.review.mode === 'update' && answer.review.settings.length === 0) {
      setFleetReview(answer.review);
    }
    setReview(current =>
      answer.kind === 'reviewed'
        ? answer.review
        : current?.mode === 'update' && answer.kind !== 'none'
          ? current
          : null,
    );
    setReviewIssue(answer.kind === 'unsupported' || answer.kind === 'failed' ? answer : null);
  };

  /** Review the ticked settings again (an item was ticked, or the last review failed and the person retries). */
  const reviewAgain = (ticked: readonly CloneItemId[]): void => {
    if (bundle === null) return;
    setReviewing(true);
    void reviewSettings(bundle, files, ticked, sourceMachine, updating).then(next => {
      keepReview(next);
      setReviewing(false);
    });
  };

  const offeredFor = async (
    exported: FleetCloneBundle,
    stamps: readonly SourceStamp[] | null,
  ): Promise<readonly NewerKey[]> => {
    if (stamps === null || stamps.length === 0 || pickedRecord === undefined) return [];
    // `read` turns any failure (a review that is refused, a list too long to send) into a refusal: none offered.
    const reviewed = await target.read(client =>
      reviewFleetClone(client, {
        bundle: { ...exported },
        source: { daemonId: String(pickedRecord.daemonId) },
        names: { source: sourceName, target: machineName },
        sourceSecrets: [...stamps],
      }),
    );
    return reviewed.kind === 'done' ? newerKeys(reviewed.value.keys) : [];
  };

  /**
   * What each mode starts with ticked. An Update copies the fleet only; a settings file stays unticked until the
   * person asks, and is then compared key by key. Every other mode starts with all it can copy.
   */
  const chosenFor = (next: CloneChoiceMode, read: ReadonlyMap<string, SourceSettingsFile>): readonly CloneItemId[] =>
    next === 'update' ? ['fleet'] : ALL_CLONE_ITEMS.filter(id => itemReadable(id, read, pickedReach));

  /**
   * Switching between Update and a full copy starts the new mode's own selection: what was ticked or left out under
   * the other never carries over, so each mode submits exactly what its own screen shows. Add alongside and Start
   * over share one screen, so a choice made on it stays. The settings it ticks are reviewed again, so the apply
   * names a review of exactly those.
   */
  const chooseMode = (next: CloneChoiceMode): void => {
    if ((next === 'update') !== (mode === 'update')) {
      const ticked = chosenFor(next, files);
      setChosen(ticked);
      setKeyPicks(new Map());
      reviewAgain(ticked);
    }
    setMode(next);
  };

  /** Read the source's setup and the review of what a copy would change here. `advance` moves on from Source. */
  const readSource = (advance = true): void => {
    // Only reachable with a source picked: Next waits for one, and Review again comes after reading one.
    if (pickedRecord === undefined) return;
    changes.clear();
    setSourceIssue(null);
    setReading(true);
    void (async () => {
      const exported = await source.read(client => readFleetExport(client));
      if (exported.kind === 'refused') {
        setReading(false);
        setSourceIssue(exported.sentence);
        return;
      }
      const read = new Map<string, SourceSettingsFile>();
      for (const item of CLONE_SETTINGS_FILES) {
        const file = await source.read(client => readConfigFile(client, item.file));
        if (file.kind === 'done')
          read.set(item.file, { path: item.file, exists: file.value.exists, text: file.value.text });
      }
      const [view, sourceList] = await Promise.all([
        target.read(client => readSpeedups(client)),
        source.read(client => listSecrets(client)),
        readHeld(),
      ]);
      // What differs from an earlier copy, when there was one. It is asked about the settings a first copy would
      // send, key by key, so a first copy needs no second question; a machine that cannot answer (an older
      // Ferretry) leaves the first-copy preview as it has always been.
      const stamps =
        sourceList.kind === 'done' && sourceList.value.health === 'ready'
          ? sourceList.value.secrets
              .filter(secret => !isSignInSecretName(secret.name))
              .map(({ name, updatedAt }) => ({ name, updatedAt }))
          : null;
      const keyStamps = stamps ?? [];
      let answer = await reviewSettings(
        exported.value,
        read,
        chosenFor('alongside', read),
        sourceMachine,
        false,
        keyStamps,
      );
      let found: FleetCloneReview | null = answer.kind === 'reviewed' ? answer.review : null;
      const differing = found?.settings.some(file => file.keys.length > 0) ?? false;
      if (found?.mode === 'update') {
        // An Update starts with no settings ticked, and the apply names exactly the review it was made from.
        answer = await reviewSettings(exported.value, read, chosenFor('update', read), sourceMachine, true, keyStamps);
        found = answer.kind === 'reviewed' ? answer.review : null;
      }
      const updatable = found?.mode === 'update';
      const nextMine = new Map<string, string>();
      let nextLogins: readonly FleetCredentialView[] = [];
      let nextHere: FleetCloneBundle | null = null;
      if (updatable) {
        // Only to show a changed document against what is here: both are best-effort and never block the review.
        const [here, logins] = await Promise.all([
          target.read(client => readFleetExport(client)),
          target.read(client => readFleetCredentials(client)),
        ]);
        if (here.kind === 'done') {
          nextHere = here.value;
          for (const file of here.value.files) nextMine.set(file.path, file.content);
        }
        if (logins.kind === 'done') nextLogins = logins.value.credentials;
      }
      setReview(found);
      setFleetReview(found?.mode === 'update' && found.settings.length === 0 ? found : null);
      setSettingsDiffer(differing);
      setPicks({});
      setLoginPicks({});
      setMineFiles(nextMine);
      setHereLogins(nextLogins);
      setHereBundle(nextHere);
      setMode(updatable ? 'update' : 'alongside');
      setSpeedups(view.kind === 'done' ? view.value : null);
      setSourceSecrets(
        sourceList.kind === 'done' && sourceList.value.health === 'ready'
          ? sourceList.value.secrets.map(secret => secret.name)
          : null,
      );
      setSourceStamps(new Map((stamps ?? []).map(({ name, updatedAt }) => [name, updatedAt])));
      // Which keys are newer on the source is this machine's call, from timestamps alone. A review that cannot be
      // read (or a source list too long to send) offers none: the keys the logins need still copy as they always did.
      // A review already asked with the source's keys (every Update, and a first copy with settings) answered it;
      // otherwise one is asked just for the keys.
      const offered = found === null ? await offeredFor(exported.value, stamps) : newerKeys(found.keys);
      setOfferedKeys(offered);
      setCopyKeys(true);
      setFiles(read);
      setBundle(exported.value);
      // A fresh read is a fresh review: nothing it lists has been left out yet, and every item it can copy is ticked.
      setSkip([]);
      setDefaultPick(undefined);
      // An Update copies the fleet only. A settings file stays unticked until the person asks, and is then compared
      // key by key: a repeat copy never changes a setting made here without being asked.
      setChosen(chosenFor(updatable ? 'update' : 'alongside', read));
      setKeyPicks(new Map());
      // Why the settings a first copy ticked could not be reviewed, if they could not: the screen says so and waits.
      setReviewIssue(!updatable && (answer.kind === 'unsupported' || answer.kind === 'failed') ? answer : null);
      setReading(false);
      const nextSteps = updatable ? cloneUpdateSteps() : steps;
      setStepper(current => (advance ? stepForward(withSteps(current, nextSteps)) : withSteps(current, nextSteps)));
    })();
  };

  /** Write one settings file here against what is here now; a loosening is held, not refused. */
  const copyFile = async (path: string, text: string): Promise<CloneItemOutcome> => {
    try {
      const client = await createClient(connection);
      const here = await readConfigFile(client, path);
      const written = await writeConfigFile(client, path, text, here.etag);
      return written.outcome === 'pending' && written.pending !== undefined
        ? { kind: 'pending', path, etag: written.pending.etag, changes: written.pending.changes }
        : { kind: 'copied' };
    } catch (error) {
      return { kind: 'refused', reason: reasonOf(error) };
    }
  };

  /** The sealed copy of the keys: the source asks for the passkey, this browser carries ciphertext. */
  const sealKeys = async (names: readonly string[]): Promise<CloneItemOutcome> => {
    if (pickedRecord === undefined) return { kind: 'refused', reason: 'No source machine is picked.' };
    try {
      const landed = await sealSecretsAcross(await createClient(pickedRecord), await createClient(connection), names);
      // Remember when the source last changed each key that was just filed (a key this machine already held was
      // kept, not filed, and is not remembered), so the next copy can tell "newer there" from "same". Bookkeeping:
      // a refusal here costs only that, never the copy that already landed.
      const stamps = filedKeyStamps(landed.imported, sourceStamps);
      if (landed.filedAt !== undefined && stamps.length > 0) {
        const { filedAt } = landed;
        await target.read(client =>
          recordCloneKeys(client, { source: { daemonId: String(pickedRecord.daemonId) }, filedAt, keys: stamps }),
        );
      }
      return { kind: 'copied' };
    } catch (error) {
      return { kind: 'refused', reason: `${copyRefusalSentence(error)} Copy them from the list below.` };
    }
  };

  /**
   * Run the copy. `link` is the metadata-only finish of an Update that found nothing different: it proposes the
   * reviewed clone (which records where the copy came from) and writes nothing else, whatever else is ticked.
   */
  const copy = (link = false): void => {
    if (bundle === null || preview === null || pickedRecord === undefined) return;
    const todo: readonly CloneItemId[] = link ? ['fleet'] : chosen;
    const copiesFleet = todo.includes('fleet');
    setCopying(true);
    void (async () => {
      let summary: string | null = null;
      const outcomes: { item: CloneOutcomeItem; outcome: CloneItemOutcome }[] = [];
      const item = (id: CloneItemId): CloneItem => CLONE_ITEMS.find(candidate => candidate.id === id) as CloneItem;
      // An Update names the review it was chosen from: this machine re-plans and refuses it if anything moved.
      const asked = mode === 'update' && review !== null ? (link ? (fleetReview ?? review) : review) : null;
      // This machine's logins BEFORE the copy: the sign-ins it already has, which the copy matches against.
      const before = copiesFleet ? await target.read(client => readFleetCredentials(client)) : null;
      // What the daemon reviewed key by key, to decide in the same apply as the items (an Update) or on its own first.
      const settingsApply =
        link || review === null || perKeyItems.length === 0
          ? null
          : {
              settings: [...settingsToSend(chosen, files, sourceMachine)],
              settingsDecisions: settingsDecisions(reviewedSettings, settingsPicks),
            };
      // A file that loosens is written but HELD, and the update's answer is only a count: read which are waiting.
      const merged = new Set<CloneItemId>();
      const markMerged = async (): Promise<void> => {
        const status = await target.read(client => readConfigStatus(client));
        for (const id of perKeyItems) {
          merged.add(id);
          outcomes.push({ item: item(id), outcome: mergedOutcome(settingsDocOf(id), status) });
        }
      };
      // Settings the daemon reviewed key by key go first, in one update that decides settings and nothing else; the
      // files and controls it handled are not written again below. An Update's items and settings name ONE review,
      // so they are one apply below: a second would find this machine already moved.
      if (review !== null && settingsApply !== null && (asked === null || !copiesFleet)) {
        const applied = await changes.apply({
          kind: 'clone.import' as const,
          mode: 'update',
          bundle: { ...bundle },
          source: { daemonId: String(pickedRecord.daemonId) },
          names: { source: sourceName, target: machineName },
          reviewed: review.fingerprint,
          decisions: keepItemsDecisions(review.items),
          ...settingsApply,
        });
        if (applied.kind === 'refused') {
          setCopying(false);
          return;
        }
        summary = applied.outcome.outcome === 'executed' ? applied.outcome.summary : applied.staged.summary;
        await markMerged();
      }
      if (copiesFleet) {
        const applied = await changes.apply(
          asked === null
            ? {
                kind: 'clone.import' as const,
                mode: mode === 'replace' ? ('replace' as const) : ('alongside' as const),
                bundle: { ...bundle },
                ...(skip.length === 0 ? {} : { skip: [...skip] }),
                source: { daemonId: String(pickedRecord.daemonId) },
                names: { source: sourceName, target: machineName },
                ...(defaultView === null || defaultView.send === undefined ? {} : { defaultRuntime: defaultView.send }),
              }
            : {
                kind: 'clone.import' as const,
                mode: 'update' as const,
                bundle: { ...bundle },
                source: { daemonId: String(pickedRecord.daemonId) },
                names: { source: sourceName, target: machineName },
                decisions: reviewDecisions(asked, picks),
                ...(Object.keys(loginChoices(asked, loginPicks)).length === 0
                  ? {}
                  : { logins: loginChoices(asked, loginPicks) }),
                reviewed: asked.fingerprint,
                ...(settingsApply ?? {}),
              },
        );
        // The fleet goes first because a copied default runtime may name a runtime it brings; when it
        // is refused nothing else is copied either, and the refusal stays on screen to act on.
        if (applied.kind === 'refused') {
          setCopying(false);
          return;
        }
        summary = applied.outcome.outcome === 'executed' ? applied.outcome.summary : applied.staged.summary;
        outcomes.push({ item: item('fleet'), outcome: { kind: 'copied' } });
        if (asked !== null && settingsApply !== null) await markMerged();
      }
      for (const settings of CLONE_SETTINGS_FILES) {
        const file = files.get(settings.file);
        if (!todo.includes(settings.id) || file === undefined || merged.has(settings.id)) continue;
        outcomes.push({ item: settings, outcome: await copyFile(settings.file, file.text) });
      }
      if (todo.includes('controls') && sourceMachine !== null && !merged.has('controls')) {
        // The fleet copy already decided this machine's default; read it back so the controls do not undo it.
        const decided = copiesFleet ? await target.read(client => readFleetMachine(client)) : null;
        const applied = await changes.apply(
          controlsChange(sourceMachine, decided?.kind === 'done' ? decided.value.defaultRuntime : undefined),
        );
        outcomes.push({
          item: item('controls'),
          outcome: applied.kind === 'refused' ? { kind: 'refused', reason: applied.sentence } : { kind: 'copied' },
        });
      }
      // The keys the copied setup needs follow, sealed, for ONE passkey on the source. After the fleet, so a
      // refused copy has not already moved a key; before the credentials are read, so a login shows ready.
      if (!link && keyNames.length > 0) {
        outcomes.push({ item: CLONE_KEYS_ITEM, outcome: await sealKeys(keyNames) });
        await readHeld();
      }
      const credentials = copiesFleet ? await target.read(client => readFleetCredentials(client)) : null;
      // What each source sign-in became: the generic rule on the logins from before the copy, then what the
      // review settled (a login matched here, or the one the person picked) over it.
      const predicted: ReadonlyMap<string, CloneLoginTarget> =
        before?.kind === 'done' ? cloneLoginTargets(bundle.credentials, before.value.credentials) : new Map();
      setResult({
        source: bundle.machine,
        summary,
        preview: copiesFleet ? preview : null,
        slots: credentials?.kind === 'done' ? cloneSlots(credentials.value.credentials, bundle.machine) : [],
        logins: asked === null ? predicted : reviewedLoginTargets(asked, loginPicks, predicted),
        after: credentials?.kind === 'done' ? credentials.value.credentials : [],
        outcomes,
        sourceName,
        updated: asked === null ? [] : reviewOutcomes(asked, picks),
      });
      setCopying(false);
      setStepper(current => stepForward(withSteps(current, steps)));
      onCopied?.(sourceName);
      onRetry();
    })();
  };

  const confirm = async (path: string, etag: string): Promise<string | null> => {
    try {
      await confirmConfigChange(await createClient(connection), path, etag);
      return null;
    } catch (error) {
      return reasonOf(error);
    }
  };

  const needs: readonly CloneNeed[] = cloneNeeds(chosen, bundle, files, speedups, held);
  // An update that only links names written nothing else: no key is sealed across for it.
  const linking = mode === 'update' && review !== null && linksOnly(review);
  const keyNames = copyKeys && !linking ? keysToCopy(needs, sourceSecrets) : [];
  // Secrets come only when a person picks them, by name, and the source asks for a passkey (docs/secrets.md).
  // The ones the copied settings need here start ticked.
  const neededSecrets = needs
    .filter(need => need.kind === 'secret' && !need.held && need.secretName !== undefined)
    .map(need => need.secretName as string);
  const copySecrets =
    pickedRecord === undefined ? undefined : (
      <SecretCopyLauncher
        label={`Copy secrets from ${daemonDisplayName(pickedRecord)}…`}
        direction="from"
        here={connection}
        others={[pickedRecord]}
        createClient={createClient}
        machineName={daemonDisplayName}
        preselect={neededSecrets}
        onCopied={() => void readHeld()}
      />
    );

  const copyPanel = (label: string, variant: 'primary' | 'danger' = 'primary') => (
    <div className="mt-4">
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy || copying}
        refusal={changes.refusal}
        submitLabel={label}
        submitClassName={TOUCH_BUTTON}
        busyLabel="Copying…"
        variant={variant}
        disabled={chosen.length === 0 || blockedBy !== null}
        onSubmit={() => copy()}
      />
    </div>
  );

  const toggleItem = (id: CloneItemId, on: boolean): void => {
    const ticked = on
      ? ALL_CLONE_ITEMS.filter(candidate => candidate === id || chosen.includes(candidate))
      : chosen.filter(candidate => candidate !== id);
    setChosen(ticked);
    // The apply names one review, and a review is of exactly the settings that will be sent.
    if (settingsDocOf(id) !== undefined) reviewAgain(ticked);
  };

  /** A source login as a person knows it: its email or label, and the tool it signs in. */
  const sourceLogin = (id: string): { readonly name: string; readonly harness: 'claude' | 'codex' | undefined } => {
    const found = bundle?.credentials.find(credential => credential.id === id);
    return { name: found?.email ?? found?.label ?? id, harness: found?.harness };
  };
  /** A login here by its id: its email or label. */
  const targetName = (id: string): string => {
    const found = hereLogins.find(credential => credential.id === id);
    return found?.email ?? found?.label ?? id;
  };

  /** The settings this machine compared key by key, and what still stops the copy: the same rows on both screens. */
  const settingsReview: ReactNode = (
    <>
      {shownSettings.length === 0 ? null : (
        <CloneSettingsKeys
          review={shownSettings}
          picks={keyPicks}
          source={sourceName}
          machineName={machineName}
          onPick={(path, key, choice: CloneKeyChoice) =>
            setKeyPicks(current => new Map(current).set(pickId(path, key), choice))
          }
        />
      )}
      {blockedBy === null ? null : (
        <SetupNote live tone="warn" name="settings-undecided">
          <span>{blockedBy}</span>
          {reviewIssue?.kind === 'failed' && !reviewing ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={`mt-2 self-start ${TOUCH_BUTTON}`}
              data-clone-review-retry=""
              onClick={() => reviewAgain(chosen)}
            >
              Check again
            </Button>
          ) : null}
        </SetupNote>
      )}
      {reviewIssue?.kind === 'unsupported' ? (
        <SetupNote tone="warn" name="settings-whole" title={`${machineName} can’t compare settings one by one`}>
          <span>
            {machineName} runs a version that predates the key-by-key check, so the settings you ticked are copied whole
            and replace what is there, including any change you made on {machineName}. Untick them to leave them alone,
            or update Ferretry on {machineName} first.
          </span>
        </SetupNote>
      ) : null}
    </>
  );

  /** Changes, for an Update: what differs from the copy made before, and nothing else. */
  const updateStep = (
    sheet: FleetCloneReview,
    summaries: Partial<Record<CloneItemId, string>>,
    unavailable: Partial<Record<CloneItemId, string>>,
    problem: string | null,
  ): ReactNode => {
    const stale = isStaleReview(changes.refusal);
    /** The stale-review note and the Review again action: an apply of this review can be refused as moved. */
    const staleNote = stale ? (
      <SetupNote live tone="warn" name="stale-review" title={CLONE_REVIEW_STALE}>
        <span>Nothing was changed. Review again to see what is different now.</span>
      </SetupNote>
    ) : null;
    const reviewAgainButton = stale ? (
      <Button
        type="button"
        className={TOUCH_BUTTON}
        data-review-again=""
        disabled={reading}
        onClick={() => readSource(false)}
      >
        {reading ? 'Reviewing…' : 'Review again'}
      </Button>
    ) : null;
    const fleetEmpty = nothingDiffers(sheet);
    if (fleetEmpty && !settingsDiffer) {
      const matched = sheet.same.probable;
      return (
        <div className="flex min-w-0 flex-col gap-3" data-clone-step="preview" data-clone-review-state="nothing">
          <SetupNote live tone="ok" name="nothing-to-copy">
            <span>
              Everything from <span className="font-mono">{sourceName}</span> is already here. Nothing to copy.
            </span>
          </SetupNote>
          {matched === 0 ? (
            <Foot>
              <Button type="button" variant="primary" className={TOUCH_BUTTON} data-clone-finish="" onClick={onDone}>
                Done
              </Button>
            </Foot>
          ) : (
            // An older copy has no record of where it came from: finishing writes only that link, so the next
            // update shows what changed on the source instead of calling every edit a conflict.
            <>
              <SetupNote name="link-by-name" title={`${countWords(matched, 'item')} matched by name`}>
                <span>
                  They have the same name and the same content as on <span className="font-mono">{sourceName}</span>.
                  Finishing links them to it, so the next update shows only what changed there. Nothing else is written.
                </span>
              </SetupNote>
              {staleNote}
              <ChangeApplyPanel
                machineName={machineName}
                authority={changes.authority}
                busy={changes.busy || copying}
                refusal={stale ? null : changes.refusal}
                submitLabel={`Finish and link ${countWords(matched, 'item')}`}
                submitClassName={TOUCH_BUTTON}
                busyLabel="Linking…"
                onSubmit={() => copy(true)}
              >
                {reviewAgainButton}
              </ChangeApplyPanel>
            </>
          )}
        </div>
      );
    }
    const unchosen = unchosenBoth(sheet, picks);
    const hold = applyHold(unchosen, sourceName);
    // Everything the one apply handler will do: the reviewed items, and the settings files, controls and keys
    // it writes after them. A button that writes any of them is never labelled "Nothing to copy".
    // A settings document the review compared key by key writes only when some key is taken.
    const writes = (id: CloneItemId): boolean =>
      !perKeyItems.includes(id) ||
      reviewedSettings.some(
        document =>
          settingsDocOf(id) === document.path &&
          document.keys.some(row => choiceFor(document.path, row, settingsPicks) === 'take'),
      );
    const others: OtherWrites = {
      files: CLONE_SETTINGS_FILES.filter(item => chosen.includes(item.id) && files.has(item.file) && writes(item.id))
        .length,
      controls: chosen.includes('controls') && sourceMachine !== null && writes('controls'),
      keys: keyNames.length,
    };
    const count = updateWrites(sheet, picks, loginPicks, others);
    // Nothing on the fleet side differs and no settings file is ticked: the button only links an older copy to its
    // source (when names matched), and waits otherwise. Ticking a settings file turns it into the Update that writes it.
    const idle = fleetEmpty && count === 0;
    const linking = idle && sheet.same.probable > 0;
    // The sign-ins still to do: one this machine already has, signed in, is not asked for again.
    const stillNeeded = needsAfterCopy(
      needs,
      reviewedLoginTargets(sheet, loginPicks, cloneLoginTargets(bundle?.credentials ?? [], hereLogins)),
      hereLogins,
    );
    const theirFiles = new Map((bundle?.files ?? []).map(file => [file.path, file.content] as const));
    const keys = keysToCopy(needs, sourceSecrets);
    const filesOffered = CLONE_SETTINGS_FILES.some(item => summaries[item.id] !== undefined);
    return (
      <div className="flex min-w-0 flex-col gap-4" data-clone-step="preview" data-clone-review-state="changes">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0 text-row font-semibold text-fg">
            Update <span className="font-mono">{machineName}</span> from <span className="font-mono">{sourceName}</span>
          </p>
          <p className="m-0 text-cell leading-base text-muted">
            {lastCopiedWords(sheet.source.lastCopiedAt) ?? ''} Only what is different is shown.
          </p>
        </div>
        <CloneReviewSheet
          review={sheet}
          source={sourceName}
          machineName={machineName}
          picks={picks}
          onPick={(ref: string, choice: CloneChoice) => setPicks(current => chooseItem(sheet, current, ref, choice))}
          loginPicks={loginPicks}
          onLoginPick={(sourceId, target) => setLoginPicks(current => ({ ...current, [sourceId]: target }))}
          sourceLogin={sourceLogin}
          targetName={targetName}
          mineFiles={mineFiles}
          theirFiles={theirFiles}
          sameNames={bundle === null ? null : sameNames(bundle, sheet)}
          compare={item => compareItem(item, hereBundle, bundle)}
          keysAccessory={
            keys.length === 0 ? undefined : (
              <CloneKeysBox
                keys={keys}
                copyKeys={copyKeys}
                onCopyKeys={setCopyKeys}
                machineName={machineName}
                sourceName={sourceName}
              />
            )
          }
        />
        {filesOffered ? (
          <CloneItemsChoices
            chosen={chosen}
            summaries={summaries}
            unavailable={unavailable}
            source={sourceName}
            onToggle={toggleItem}
            omit={['fleet']}
            title="Settings files"
            intro={
              <>
                Ticking one compares it with the one on <span className="font-mono">{machineName}</span> key by key:
                only a key that differs is listed, and one changed on both machines is yours to choose. They start
                unticked so an update changes nothing you didn’t ask for.
              </>
            }
          />
        ) : null}
        {settingsReview}
        <CloneNeedsList needs={stillNeeded} machineName={machineName} onAdd={addSecret} copy={copySecrets} />
        {problem !== null ? (
          <SetupNote live tone="err" name="bundle-refused" title={`${sourceName}’s setup can’t be copied`}>
            <span>{problem}</span>
          </SetupNote>
        ) : (
          <div className="flex min-w-0 flex-col gap-2" data-clone-update-apply="">
            {hold === null ? null : (
              <p className="m-0 text-cell leading-base text-warn" data-review-hold="">
                {hold}
              </p>
            )}
            {staleNote}
            <ChangeApplyPanel
              machineName={machineName}
              authority={changes.authority}
              busy={changes.busy || copying}
              refusal={stale ? null : changes.refusal}
              submitLabel={linking ? `Finish and link ${countWords(sheet.same.probable, 'item')}` : updateLabel(count)}
              submitClassName={TOUCH_BUTTON}
              busyLabel={linking ? 'Linking…' : 'Updating…'}
              disabled={unchosen.length > 0 || blockedBy !== null || (idle && !linking)}
              onSubmit={() => copy(linking)}
            >
              {reviewAgainButton}
            </ChangeApplyPanel>
          </div>
        )}
      </div>
    );
  };

  const body = (): ReactNode => {
    if (at === 'source') {
      const pickedState = pickedRecord === undefined ? null : cloneSourceState(reach.get(pickedRecord.daemonId), '');
      return (
        <div className="flex min-w-0 flex-col gap-3" data-clone-step="source">
          <p className="m-0 text-cell leading-base text-fg">
            Copy settings from which machine into <span className="font-mono">{machineName}</span>?
          </p>
          <p className="m-0 text-cell leading-base text-muted" data-clone-shares="">
            {cloneSharesSentence(machineName)}
          </p>
          {sources.length === 0 ? (
            <SetupNote name="no-sources" title="No other machine is paired">
              <span>Pair another machine with this browser first, from Machines → Add machine.</span>
            </SetupNote>
          ) : (
            <RadioChoices
              legend="Copy from"
              legendHidden
              name="clone-source"
              value={picked}
              onChoose={id => {
                setPicked(id);
                setBundle(null);
                setReview(null);
                setSourceIssue(null);
              }}
              options={sources.map(record => {
                const name = daemonDisplayName(record);
                const sourceState = cloneSourceState(reach.get(record.daemonId), name);
                return {
                  id: record.daemonId,
                  title: <span className="font-mono">{name}</span>,
                  detail:
                    sourceState.kind === 'ready'
                      ? countWords(sourceState.runtimeCount, 'runtime')
                      : sourceState.kind === 'checking'
                        ? 'Checking…'
                        : undefined,
                  extra:
                    sourceState.kind === 'disabled' ? (
                      <span className="text-cell text-warn" data-clone-source-reason="">
                        {sourceState.reason}
                      </span>
                    ) : undefined,
                  disabled: sourceState.kind !== 'ready',
                };
              })}
            />
          )}
          {sourceIssue === null ? null : (
            <SetupNote live tone="warn" name="source-failed" title="Couldn’t read that machine’s setup">
              <span>{sourceIssue}</span>
            </SetupNote>
          )}
          <Foot>
            <Button
              type="button"
              variant="primary"
              className={TOUCH_BUTTON}
              data-step-next=""
              disabled={pickedState?.kind !== 'ready' || reading || source.changes.authority === null}
              onClick={() => readSource(true)}
            >
              {reading ? 'Reading…' : 'Next'}
            </Button>
          </Foot>
        </div>
      );
    }

    if (at === 'done')
      return (
        <DoneStep
          result={result}
          machineName={machineName}
          needs={needs}
          doneLabel={doneLabel}
          onDone={onDone}
          onAdd={addSecret}
          onConfirm={confirm}
          copy={copySecrets}
        />
      );
    if (bundle === null || preview === null) return null;

    const summaries: Partial<Record<CloneItemId, string>> = {};
    const unavailable: Partial<Record<CloneItemId, string>> = {};
    for (const entry of CLONE_ITEMS) {
      if (itemReadable(entry.id, files, pickedReach))
        summaries[entry.id] = sourceItemSummary(entry.id, files, sourceMachine, bundle);
      else unavailable[entry.id] = `${sourceName} didn’t share this one, so it can’t be copied.`;
    }
    const copyLabel = `Copy ${countWords(chosen.length, 'item')} from ${sourceName}`;

    if (at === 'preview' && updating && mode === 'update' && review !== null)
      return updateStep(review, summaries, unavailable, preview.problem);

    if (at === 'preview')
      return (
        <div className="flex min-w-0 flex-col gap-4" data-clone-step="preview">
          <p className="m-0 text-cell leading-base text-fg">
            This copies <span className="font-mono">{sourceName}</span>’s setup now. Later changes on it don’t follow by
            themselves: copy again to see just what changed.
          </p>
          <CloneItemsChoices
            chosen={chosen}
            summaries={summaries}
            unavailable={unavailable}
            source={sourceName}
            onToggle={toggleItem}
          />
          {settingsReview}
          {copiesFleet ? (
            <>
              <SetupSection title="Profiles and runtimes copy" name="copies">
                {copiesRows(preview).map(row => (
                  <SetupRow
                    key={row.title}
                    status="ready"
                    statusLabel="Copies"
                    title={row.title}
                    {...(row.detail === undefined ? {} : { detail: row.detail })}
                  />
                ))}
              </SetupSection>
              {defaultView === null || defaultView.candidates.length === 0 ? null : (
                <DefaultRuntimeChoice
                  view={defaultView}
                  onPick={value => setDefaultPick(value === CLONE_NO_DEFAULT ? null : value)}
                />
              )}
              {preview.runnables.length === 0 ? null : (
                <RunsHere
                  runnables={preview.runnables}
                  skip={skip}
                  source={sourceName}
                  machineName={machineName}
                  onToggle={(reference, copyIt) =>
                    setSkip(current =>
                      copyIt ? current.filter(entry => entry !== reference) : [...current, reference].toSorted(),
                    )
                  }
                />
              )}
            </>
          ) : null}
          <CloneLoginsSection
            logins={cloneLogins(copiesFleet ? bundle : null, held)}
            machineName={machineName}
            sourceName={sourceName}
            keys={keysToCopy(needs, sourceSecrets)}
            copyKeys={copyKeys}
            onCopyKeys={setCopyKeys}
            newer={offeredKeys}
          />
          <CloneNeedsList needs={needs} machineName={machineName} onAdd={addSecret} copy={copySecrets} />
          <SetupSection title="Doesn’t copy" name="not-copied">
            {copiesFleet && preview.skipped > 0 ? (
              <SetupRow
                status="needs_sign_in"
                statusLabel="Doesn’t copy"
                title={`${countWords(preview.skipped, 'component')} you left out`}
                detail={`Not copied to ${machineName}, and removed from every profile that used ${preview.skipped === 1 ? 'it' : 'them'}.`}
              />
            ) : null}
            {copiesFleet ? (
              <SetupRow
                status="needs_sign_in"
                statusLabel="Doesn’t copy"
                title={countWords(preview.signIns, 'sign-in')}
                detail={`Claude Code and Codex sign-ins never copy: a refresh token on two machines would sign one of them out. A sign-in ${machineName} already has (same account) is reused, not added again; each other becomes an empty slot on ${machineName}; sign in there. Runtimes keep pointing at their login.`}
              />
            ) : null}
            <SetupRow
              status="needs_sign_in"
              statusLabel="Doesn’t copy"
              title="Other secret values"
              detail="Only the keys these logins and settings need are copied, sealed. Any other secret, copy by name from Settings › Secrets."
            />
            <SetupRow
              status="needs_sign_in"
              statusLabel="Doesn’t copy"
              title="History and device settings"
              detail={`Past sessions stay on ${sourceName}; appearance and composer choices stay on each device.`}
            />
          </SetupSection>
          {copiesFleet && preview.checkPaths.length > 0 ? (
            <SetupSection title="Check after copying" name="check-paths">
              {preview.checkPaths.map(check => (
                <SetupRow
                  key={check.title}
                  title={check.title}
                  detail={
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="break-all font-mono">{check.path}</span>
                      <span className="text-warn">Check this path on {machineName}</span>
                    </span>
                  }
                />
              ))}
            </SetupSection>
          ) : null}
          {copiesFleet && preview.missingTools.length > 0 ? (
            <SetupNote tone="warn" name="missing-tools">
              <span>
                {listWords(preview.missingTools.map(harness => SETUP_HARNESS_NAMES[harness]))} isn’t installed on{' '}
                {machineName}. Its runtimes are copied and wait until you install it.
              </span>
            </SetupNote>
          ) : null}
          {copiesFleet && preview.notCopied.length > 0 ? (
            <SetupNote
              tone="warn"
              name="files-not-copied"
              title={`${countWords(preview.notCopied.length, 'file')} can’t be copied`}
            >
              {preview.notCopied.map(entry => (
                <span key={entry.path} className="break-all">
                  {entry.path}: {entry.reason}
                </span>
              ))}
            </SetupNote>
          ) : null}
          {copiesFleet && preview.problem !== null ? (
            // Never offered: a bundle the review could misread is one the target refuses anyway.
            <SetupNote live tone="err" name="bundle-refused" title={`${sourceName}’s setup can’t be copied`}>
              <span>{preview.problem}</span>
            </SetupNote>
          ) : updating ? (
            // The Existing setup step came first: the copy is the one it chose.
            mode === 'replace' ? (
              copyPanel('Replace and copy', 'danger')
            ) : (
              copyPanel('Copy alongside')
            )
          ) : hasSetup ? (
            <Foot>
              <Button
                type="button"
                variant="primary"
                className={TOUCH_BUTTON}
                data-step-next=""
                disabled={blockedBy !== null}
                onClick={next}
              >
                Next
              </Button>
            </Foot>
          ) : (
            copyPanel(copyLabel)
          )}
        </div>
      );

    // existing
    return (
      <div className="flex min-w-0 flex-col gap-3" data-clone-step="existing">
        <p className="m-0 text-cell leading-base text-fg">
          {updating && review !== null
            ? updateSentence(machineName, sourceName, lastCopiedWords(review.source.lastCopiedAt))
            : existingSentence(machineName, profiles, runtimeCount)}
        </p>
        <RadioChoices
          legend="Existing setup"
          legendHidden
          name="clone-mode"
          value={mode}
          onChoose={chooseMode}
          options={[
            ...(updating
              ? [
                  {
                    id: 'update' as const,
                    title: 'Update',
                    detail: `Compare with ${sourceName} and show only what is different. Nothing is written until you choose, and a login you already have is never added again.`,
                  },
                ]
              : []),
            {
              id: 'alongside' as const,
              title: 'Add alongside (rename clashes)',
              detail: (
                <>
                  Keep what’s here. Copies with the same name get -2, e.g.{' '}
                  <span className="font-mono">claude-default-2</span>.
                </>
              ),
            },
            {
              id: 'replace' as const,
              title: updating ? 'Start over (Replace)' : 'Replace',
              detail: `Delete ${machineName}’s components, profiles and runtimes first. Its logins stay.`,
            },
          ]}
        />
        {updating ? (
          <Foot>
            <Button type="button" variant="primary" className={TOUCH_BUTTON} data-step-next="" onClick={next}>
              Next
            </Button>
          </Foot>
        ) : null}
        {updating || defaultView === null || defaultView.candidates.length === 0 ? null : (
          <DefaultRuntimeChoice
            view={defaultView}
            onPick={value => setDefaultPick(value === CLONE_NO_DEFAULT ? null : value)}
          />
        )}
        {updating ? null : mode === 'replace' ? copyPanel('Replace and copy', 'danger') : copyPanel('Copy alongside')}
      </div>
    );
  };

  return (
    <MachineStepper
      state={state}
      onChange={nextState => (nextState === null ? onLeave() : setStepper(nextState))}
      machineName={machineName}
      online={online}
      checking={checking}
      onRetry={onRetry}
      presentation={presentation}
    >
      {body()}
    </MachineStepper>
  );
}

/** How one merged settings item ended, from the machine's own list of the edits it is holding. */
const mergedOutcome = (document: CloneSettingsDoc | undefined, status: Guarded<ConfigStatusView>): CloneItemOutcome => {
  // The controls are one reviewed change of the copy itself: nothing of theirs is held back as a file.
  if (document === undefined || document === 'controls') return { kind: 'copied' };
  if (status.kind === 'refused') return { kind: 'unchecked', reason: status.sentence };
  const held = status.value.pending.find(pending => pending.path === document);
  return held === undefined
    ? { kind: 'copied' }
    : { kind: 'pending', path: held.path, etag: held.etag, changes: held.changes };
};

/** Whether the source shared an item: its export always, its files when they were read, its controls when it answered. */
const itemReadable = (
  id: CloneItemId,
  files: ReadonlyMap<string, SourceSettingsFile>,
  reach: MachineReach | undefined,
): boolean => {
  if (id === 'fleet') return true;
  if (id === 'controls') return reach?.kind === 'online';
  const file = CLONE_SETTINGS_FILES.find(candidate => candidate.id === id) as CloneItem & { readonly file: string };
  return files.has(file.file);
};

/**
 * Everything the copy would run on this machine, one panel per component, each with a box that
 * leaves it out. A document is folded, because a hook script can be long — but every line of it is
 * there, and its size is on the fold.
 */
function RunsHere({
  runnables,
  skip,
  source,
  machineName,
  onToggle,
}: {
  readonly runnables: readonly CloneRunnable[];
  readonly skip: readonly string[];
  readonly source: string;
  readonly machineName: string;
  readonly onToggle: (reference: string, copy: boolean) => void;
}) {
  return (
    <SetupSection title={`Runs on ${machineName}`} name="runs">
      <SetupNote
        tone="warn"
        name="runs-warning"
        title={`${countWords(runnables.length, 'component')} can make ${machineName} run something`}
      >
        <span>
          MCP servers, hooks and settings start programs the next time an agent launches on{' '}
          <span className="font-mono">{machineName}</span>. Instructions and skills are text an agent follows, and one
          running unattended will act on it. Read each one and untick any you don’t trust: if{' '}
          <span className="font-mono">{source}</span> was ever broken into, this is where it would plant a command.
        </span>
      </SetupNote>
      {runnables.map(runnable => {
        const copy = !skip.includes(runnable.reference);
        return (
          <div
            key={runnable.reference}
            className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
            data-clone-runnable={runnable.reference}
            data-copy={copy ? 'yes' : 'no'}
          >
            <label className="relative flex min-h-[44px] min-w-0 cursor-pointer items-center gap-3 has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus">
              <input
                type="checkbox"
                checked={copy}
                onChange={event => onToggle(runnable.reference, event.currentTarget.checked)}
                className="shrink-0 accent-[var(--accent)]"
                data-clone-copy={runnable.reference}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">
                  {runnableTitle(runnable)}
                </span>
                <span className={copy ? 'text-cell text-muted' : 'text-cell text-warn'}>
                  {copy ? `Copies to ${machineName}` : 'Left out: not copied'}
                </span>
              </span>
            </label>
            <RunnableEntries entries={runnable.entries} />
          </div>
        );
      })}
    </SetupSection>
  );
}

function DoneStep({
  result,
  machineName,
  needs,
  doneLabel,
  onDone,
  onAdd,
  onConfirm,
  copy,
}: {
  readonly result: CloneResult | null;
  readonly machineName: string;
  readonly needs: readonly CloneNeed[];
  readonly doneLabel: string;
  readonly onDone: () => void;
  readonly onAdd: (name: string, value: string) => Promise<string | null>;
  readonly onConfirm: (path: string, etag: string) => Promise<string | null>;
  readonly copy?: ReactNode;
}) {
  if (result === null) return null;
  const busiest = result.slots[0];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-clone-step="done">
      <SetupNote live tone="ok" name="cloned" title={`Copied from ${result.sourceName}`}>
        <span>{result.summary ?? `${countWords(result.outcomes.length, 'item')} copied.`}</span>
      </SetupNote>
      {result.updated.length === 0 ? null : (
        <SetupSection title="What changed" name="update-outcomes">
          {result.updated.map(group => (
            <SetupRow
              key={group.id}
              name={`update-${group.id}`}
              status="ready"
              statusLabel={group.title}
              title={`${group.title} · ${countWords(group.names.length, 'item')}`}
              detail={<span className="font-mono">{group.names.join(', ')}</span>}
            />
          ))}
        </SetupSection>
      )}
      <CloneOutcomes outcomes={result.outcomes} machineName={machineName} onConfirm={onConfirm} />
      <CloneNeedsList
        needs={needsAfterCopy(needs, result.logins, result.after)}
        machineName={machineName}
        onAdd={onAdd}
        copy={copy}
        signIn={need => {
          const target = signInLink(need, result.logins, result.after);
          return target === undefined ? null : (
            <a
              href={machineItemHash(machineName, 'sign-ins', target)}
              className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-accent underline"
              data-clone-need-sign-in={target}
            >
              Sign in
              <ChevronRight size={14} aria-hidden="true" />
            </a>
          );
        }}
      />
      {result.slots.length === 0 ? null : (
        <SetupSection title="Sign in to use them" name="slots">
          {result.slots.map(slot => (
            <a
              key={slot.id}
              href={machineItemHash(machineName, 'sign-ins', slot.id)}
              data-clone-slot={slot.id}
              className="kt-panel flex min-h-[44px] min-w-0 items-center gap-3 p-panel no-underline hover:border-accent"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">
                  {SETUP_HARNESS_NAMES[slot.harness]} ·{' '}
                  <span className="font-mono">{slot.email ?? slot.label ?? slot.id}</span>
                </span>
                <span className="text-cell text-muted">
                  Empty slot · used by {countWords(slot.usedBy.length, 'runtime')}
                  {result.preview?.missingTools.includes(slot.harness)
                    ? ` · ${SETUP_HARNESS_NAMES[slot.harness]} isn’t installed here`
                    : ''}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-accent">
                Sign in
                <ChevronRight size={16} aria-hidden="true" />
              </span>
            </a>
          ))}
          <p className="m-0 text-meta text-muted">
            A sign-in never copies, so each login is signed in on {machineName}. Sign in once per login: every runtime
            that uses it is fixed together.
          </p>
        </SetupSection>
      )}
      {result.preview === null || result.preview.checkPaths.length === 0 ? null : (
        <SetupNote
          tone="warn"
          name="check-paths-after"
          title={`Check ${countWords(result.preview.checkPaths.length, 'path')} on ${machineName}`}
        >
          <span>
            {listWords(result.preview.checkPaths.map(check => check.title))} point at folders on {result.sourceName}.
          </span>
        </SetupNote>
      )}
      <Foot>
        <Button type="button" className={TOUCH_BUTTON} data-clone-finish="" onClick={onDone}>
          {doneLabel}
        </Button>
        {busiest === undefined ? null : (
          <a
            href={machineItemHash(machineName, 'sign-ins', busiest.id)}
            data-clone-sign-in={busiest.id}
            className={`kt-btn ${TOUCH_BUTTON}`}
            data-variant="primary"
          >
            Sign in once for {countWords(busiest.usedBy.length, 'runtime')}
          </a>
        )}
      </Foot>
    </div>
  );
}
