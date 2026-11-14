/**
 * Copy settings from another machine (docs/design/account-model.md §4.7): **Source** → **Review** → **Done**.
 *
 * The browser reads the source's export and settings through the Runtimes client it holds on that machine, asks THIS
 * machine to review them, and sends ONE reviewed change (`clone.import`) that the daemon describes again when it is
 * staged. What a copy would RUN (an MCP server's command, a hook, a launch flag) is listed in full and each can be left
 * out; a sign-in never travels (it becomes an empty slot to sign in to), and an API key is named, never carried.
 */

import { daemonOfClient, type DaemonReach, useEveryDaemon } from '@ferretry/app';
import { RadioChoices, SetupNote, SetupSection } from '@ferretry/app/ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type AccountChangeView,
  type CloneBundle,
  CloneBundleSchema,
  CLONE_REVIEW_STALE,
  type CloneReview,
  CloneReviewSchema,
  type CloneSettingsDoc,
  type MachineView,
} from '../../../../contract/index.ts';
import type { RuntimesClient } from '../../../lib/client.ts';
import { readConfigFile } from '../../../lib/config-files.ts';
import { Button } from '../../../ui.ts';
import { ChangeApplyPanel, type AccountChanges } from '../shell/apply-change-panel.tsx';
import { changeRefusalSentence, readMachine } from '../shell/apply-change.ts';
import {
  type CopyMode,
  copyChange,
  defaultRuntimeCandidates,
  outcomeCounts,
  reviewRequest,
  type CopyDoneReport,
  doneReport,
  followupChange,
  hasWritableSettings,
  initialPick,
  undecidedKeys,
  type SettingsPick,
  type LeftOutSettings,
  keyOutcomeSentence,
  runnableRefs,
  SETTINGS_FILES,
  settingsTexts,
  type SourceSettingsRead,
  sourceStamps,
  writesByDefault,
} from './copy-model.ts';
import { ConfirmDescription, DoneReport, LoginRows, ReviewItem, SettingsPicker } from './copy-review-parts.tsx';

const DEFAULT_LEAVE = '\u0000leave';
const DEFAULT_NONE = '\u0000none';

export interface CopySettingsProps {
  readonly client: RuntimesClient;
  readonly machineName: string;
  /** This machine already has runtimes: the copy goes next to them, or in their place. */
  readonly hasSetup: boolean;
  readonly changes: AccountChanges;
  /** The copy landed: the step is set and setup continues. */
  readonly onDone?: () => void;
  /** The copy was applied (before the person continues): where a setup step marks itself done. */
  readonly onCopied?: () => void;
  readonly doneLabel?: string;
  /** The machines to copy from, where the shell is not the one to say (a suite); absent: every paired machine the shell lists. */
  readonly reaches?: readonly DaemonReach[];
}

type Phase =
  | { readonly kind: 'source' }
  | { readonly kind: 'reading'; readonly source: string }
  | {
      readonly kind: 'review';
      readonly source: { readonly daemonId: string; readonly name: string };
      readonly bundle: CloneBundle;
      readonly review: CloneReview;
      readonly request: ReturnType<typeof reviewRequest>;
      readonly leftOut: readonly LeftOutSettings[];
    }
  | { readonly kind: 'followup'; readonly source: string }
  | ({ readonly kind: 'confirm' } & Confirm)
  | { readonly kind: 'done'; readonly source: string; readonly report: CopyDoneReport };

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** The source's settings files and controls: what a copy merges key by key. */
const readSource = async (reach: DaemonReach) => {
  const client = reach.client as RuntimesClient;
  const [bundle, machine, stamps, ...files] = await Promise.all([
    client.call('GET /v1/runtimes/export').then(answer => CloneBundleSchema.parse(answer)),
    readMachine(client),
    // The names and instants of the keys the source holds (never a value); a listing that is refused names none.
    client
      .call('GET /v1/secrets')
      .then(sourceStamps)
      .catch(() => []),
    ...SETTINGS_FILES.map(async (path): Promise<SourceSettingsRead> => {
      // A refused or failed read is NOT an absent file: it is left out and said so, never sent as the empty text.
      const file = await readConfigFile(client, path).catch(() => null);
      return file === null
        ? { path, exists: false, text: '', issues: [], failed: true }
        : { path, exists: file.exists, text: file.text, issues: file.issues ?? [] };
    }),
  ]);
  return { bundle, machine: machine as MachineView, files, stamps };
};

/** A staged change waiting for its confirm, with what the Done view needs to say what was and was not brought. */
interface Confirm {
  readonly staged: AccountChangeView;
  readonly source: string;
  readonly review: CloneReview;
  readonly request: ReturnType<typeof reviewRequest>;
  readonly skipped: readonly string[];
  readonly leftOut: readonly LeftOutSettings[];
  readonly pick: SettingsPick;
  /** The settings were sent with the fleet change (an update), not as a second step. */
  readonly settingsWithFleet: boolean;
  /** `fleet`: the setup itself (and, in a repeat copy, its settings). `settings`: a first copy's second step. */
  readonly step: 'fleet' | 'settings';
  /** What the first step said it did, carried to the second. */
  readonly did?: string;
}

/** What a copy starts with ticked: an update, what the review writes by default; a full copy, every item. */
const ticksFor = (review: CloneReview, updating: boolean): ReadonlySet<string> =>
  new Set(review.items.filter(item => !updating || writesByDefault(item)).map(item => item.ref));

/** The documents that differ and were not written: not ticked, refused, or (before the second step) all of them. */
const unwritten = (review: CloneReview, pick: SettingsPick, wrote: boolean): readonly CloneSettingsDoc[] =>
  review.settings
    .filter(doc => doc.keys.length > 0 || doc.refused !== undefined)
    .filter(doc => !wrote || !pick.docs.has(doc.path) || doc.refused !== undefined)
    .map(doc => doc.path);

export function CopySettings({
  client,
  machineName,
  hasSetup,
  changes,
  onDone,
  onCopied,
  doneLabel,
  reaches,
}: CopySettingsProps) {
  const own = daemonOfClient(client);
  const live = useEveryDaemon();
  const everyone = reaches ?? live;
  const sources = useMemo(() => everyone.filter(row => row.daemon !== own), [everyone, own]);
  const [phase, setPhase] = useState<Phase>({ kind: 'source' });
  const [picked, setPicked] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** A repeat copy updates (the default) or starts over with a full copy; a first copy is always a full copy. */
  const [mode, setMode] = useState<CopyMode | 'update'>('alongside');
  /** The items of an update both machines changed, once the person has decided each. */
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  /** Which login here each sign-in uses, where the person chose. */
  const [loginPick, setLoginPick] = useState<Readonly<Record<string, string>>>({});
  /** A full copy: the source's runtime to make the default (`null`: none); `undefined`: the machine decides. */
  const [defaultPick, setDefaultPick] = useState<string | null | undefined>(undefined);
  const lastReach = useRef<DaemonReach | null>(null);
  /** The items that RUN something which the copy writes: ticked by what the review takes by default, changed by the person. */
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  /** The settings documents and keys the person includes. */
  const [pick, setPick] = useState<SettingsPick>({ docs: new Set(), keys: {} });

  const read = useCallback(
    async (reach: DaemonReach): Promise<void> => {
      setProblem(null);
      lastReach.current = reach;
      setPhase({ kind: 'reading', source: reach.machine });
      try {
        const { bundle, machine, files, stamps } = await readSource(reach);
        const { settings, leftOut } = settingsTexts(files, machine);
        const source = { daemonId: reach.daemon, name: reach.machine };
        const request = reviewRequest({
          bundle,
          source,
          targetName: machineName,
          settings,
          sourceSecrets: stamps,
        });
        const review = CloneReviewSchema.parse(await client.call('POST /v1/runtimes/clone/review', { body: request }));
        setPick(initialPick(review));
        setMode(review.mode === 'update' ? 'update' : 'alongside');
        setTicked(ticksFor(review, review.mode === 'update'));
        setDecided(new Set());
        setLoginPick({});
        setDefaultPick(undefined);
        setPhase({ kind: 'review', source, bundle, review, request, leftOut });
      } catch (error) {
        setProblem(changeRefusalSentence(error));
        setPhase({ kind: 'source' });
      }
    },
    [client, machineName],
  );

  if (phase.kind === 'done')
    return (
      <div className="flex min-w-0 flex-col gap-3" data-copy-done="">
        <DoneReport report={phase.report} source={phase.source} />
        {onDone === undefined ? null : (
          <div>
            <Button type="button" variant="primary" data-copy-continue="" onClick={onDone}>
              {doneLabel ?? 'Continue'}
            </Button>
          </div>
        )}
      </div>
    );

  if (phase.kind === 'followup')
    return (
      <p role="status" className="m-0 text-cell text-muted" data-copy-followup="">
        The setup landed. Reading the settings review from {phase.source}…
      </p>
    );

  if (phase.kind === 'confirm') {
    const here = phase;
    const finish = (
      did: string,
      extra: { readonly notWritten?: readonly CloneSettingsDoc[]; readonly settingsProblem?: string },
    ) => {
      setPhase({
        kind: 'done',
        source: here.source,
        report: doneReport({
          review: here.review,
          request: here.request,
          skipped: here.skipped,
          leftOut: here.leftOut,
          did,
          ...extra,
        }),
      });
      onCopied?.();
    };
    /** A first copy's second step: re-review (the first copy has just recorded this source) and stage the settings. */
    const settingsStep = async (did: string): Promise<void> => {
      setPhase({ kind: 'followup', source: here.source });
      const left = unwritten(here.review, here.pick, true);
      try {
        const second = CloneReviewSchema.parse(
          await client.call('POST /v1/runtimes/clone/review', { body: here.request }),
        );
        if (second.mode !== 'update')
          return finish(did, {
            notWritten: unwritten(here.review, here.pick, false),
            settingsProblem: `This machine did not record the copy, so ${here.source}'s settings could not be merged. Copy again from Settings › Export & copy.`,
          });
        if (!hasWritableSettings(second)) return finish(did, { notWritten: left });
        const result = await changes.stage(followupChange({ review: second, request: here.request, pick: here.pick }));
        if (result.kind !== 'staged')
          return finish(did, {
            notWritten: unwritten(here.review, here.pick, false),
            settingsProblem: result.sentence,
          });
        setPhase({ ...here, kind: 'confirm', staged: result.staged, review: second, step: 'settings', did });
      } catch (error) {
        finish(did, {
          notWritten: unwritten(here.review, here.pick, false),
          settingsProblem: changeRefusalSentence(error),
        });
      }
    };
    return (
      <div className="flex min-w-0 flex-col gap-3" data-copy-confirm="" data-copy-step={here.step}>
        {here.step === 'settings' ? (
          <p className="m-0 text-cell leading-base text-muted">
            The setup landed. Second step: the settings you ticked, as the machine will write them.
          </p>
        ) : null}
        <ConfirmDescription staged={here.staged} />
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel={here.step === 'settings' ? 'Write the settings' : `Copy from ${here.source}`}
          onSubmit={() => {
            void changes.applyStaged(here.staged).then(result => {
              if (result.kind !== 'applied') return;
              // What the machine says it did, not what was previewed.
              const said = result.outcome.outcome === 'executed' ? result.outcome.summary : here.staged.summary;
              if (here.step === 'settings')
                return finish(`${here.did ?? ''} ${said}`.trim(), {
                  notWritten: unwritten(here.review, here.pick, true),
                });
              if (!here.settingsWithFleet && here.review.mode === 'first' && here.pick.docs.size > 0)
                return void settingsStep(said);
              finish(said, { notWritten: unwritten(here.review, here.pick, here.settingsWithFleet) });
            });
          }}
        >
          <Button type="button" data-copy-back="" onClick={() => setPhase({ kind: 'source' })}>
            Back
          </Button>
        </ChangeApplyPanel>
      </div>
    );
  }

  if (phase.kind === 'review') {
    const { review, request, source, leftOut } = phase;
    const counts = outcomeCounts(review);
    const running = runnableRefs(review);
    const updating = review.mode === 'update' && mode === 'update';
    /** A first copy, or a repeat copy that starts over: everything is copied, and settings follow as a second step. */
    const showSettings = updating || review.mode === 'first';
    const undecided = [
      ...(updating
        ? review.items.filter(item => item.outcome === 'both' && !decided.has(item.ref)).map(item => item.ref)
        : []),
      ...(showSettings ? undecidedKeys(review, pick) : []),
    ];
    const nothing = updating && review.items.length === 0 && !hasWritableSettings(review);
    const candidates = updating ? [] : defaultRuntimeCandidates(phase.bundle);
    const chooseMode = (next: CopyMode | 'update'): void => {
      setMode(next);
      setTicked(ticksFor(review, next === 'update'));
      setDecided(new Set());
    };
    const stage = (): void => {
      // Every item the person unticked is left out (kept, or not brought); in an update, one they ticked that the
      // review does not take by default (both machines changed it) is taken. Nothing else is the person's to infer.
      const skip = review.items.map(item => item.ref).filter(ref => !ticked.has(ref));
      const take = updating
        ? review.items.filter(item => ticked.has(item.ref) && !writesByDefault(item)).map(item => item.ref)
        : [];
      const chosenPick = showSettings ? pick : { ...pick, docs: new Set<CloneSettingsDoc>() };
      const change = copyChange({
        review,
        request,
        choices: {
          skip,
          take,
          mode: mode === 'update' ? 'alongside' : mode,
          settings: chosenPick,
          logins: loginPick,
          full: !updating,
          ...(defaultPick === undefined ? {} : { defaultRuntime: defaultPick }),
        },
      });
      void changes.stage(change).then(result => {
        if (result.kind === 'staged')
          setPhase({
            kind: 'confirm',
            staged: result.staged,
            source: source.name,
            review,
            request,
            skipped: skip,
            leftOut,
            pick: chosenPick,
            settingsWithFleet: updating,
            step: 'fleet',
          });
      });
    };
    return (
      <div className="flex min-w-0 flex-col gap-4" data-copy-review="">
        <SetupSection title={`What ${source.name} brings`} name="copy-summary">
          <p className="m-0 text-cell leading-base text-muted" data-copy-counts="">
            {plural(review.items.length, 'item')}
            {Object.entries(counts).length === 0
              ? ''
              : ` (${Object.entries(counts)
                  .map(([outcome, count]) => `${String(count)} ${outcome}`)
                  .join(', ')})`}
            , {plural(review.same.count, 'thing')} already the same here.
          </p>
        </SetupSection>
        {review.logins.length === 0 ? null : (
          <SetupNote tone="warn" name="copy-logins" title="Sign-ins stay behind">
            <span>
              A sign-in never leaves {source.name}: {plural(review.logins.length, 'login')} arrive as an empty slot to
              sign in to here.
            </span>
          </SetupNote>
        )}
        <LoginRows
          logins={review.logins}
          {...(updating
            ? {
                picks: loginPick,
                onPick: (id: string, target: string) => setLoginPick(current => ({ ...current, [id]: target })),
              }
            : {})}
        />
        {review.keys.length === 0 ? null : (
          <SetupNote tone="pend" name="copy-keys" title="API keys are named, never carried">
            {review.keys.map(key => (
              <span key={key.name} className="block [overflow-wrap:anywhere]" data-copy-key={key.name}>
                <span className="font-mono">{key.name}</span>: {keyOutcomeSentence(key.outcome, source.name)}
              </span>
            ))}
          </SetupNote>
        )}
        {leftOut.length === 0 ? null : (
          <SetupNote tone="warn" name="copy-left-out" title="Not copied">
            <span className="[overflow-wrap:anywhere]">
              {leftOut.map(entry => (
                <span key={entry.path} className="block" data-copy-left-out={entry.path}>
                  {entry.path}:{' '}
                  {entry.why === 'unread'
                    ? `reading it from ${source.name} failed, so it is left out — it is not the same as a file that is not there. Review again to retry.`
                    : `${source.name} does not show the whole file, so it is left out rather than sent with a gap.`}
                </span>
              ))}
            </span>
          </SetupNote>
        )}
        {review.items.length === 0 ? null : (
          <SetupSection title={review.mode === 'first' ? 'What would be copied' : 'What changed'} name="copy-items">
            {running.length === 0 ? null : (
              <p className="m-0 text-meta leading-base text-muted">
                What is marked “Copy this” starts or runs what is shown, in full, on {machineName}. Untick any you don’t
                want; a profile that names it leaves it out too.
              </p>
            )}
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {review.items.map(item => (
                <ReviewItem
                  key={item.ref}
                  item={item}
                  ticked={ticked.has(item.ref)}
                  updating={updating}
                  decided={decided.has(item.ref)}
                  onTick={on => {
                    setDecided(current => new Set(current).add(item.ref));
                    setTicked(current => {
                      const next = new Set(current);
                      if (on) next.add(item.ref);
                      else next.delete(item.ref);
                      return next;
                    });
                  }}
                />
              ))}
            </ul>
          </SetupSection>
        )}
        {showSettings ? <SettingsPicker review={review} pick={pick} onPick={setPick} source={source.name} /> : null}
        {review.mode === 'update' || hasSetup ? (
          <SetupSection title="Existing setup" name="copy-existing">
            <RadioChoices
              legend="Existing setup"
              legendHidden
              name="copy-mode"
              value={mode}
              onChoose={chooseMode}
              options={[
                ...(review.mode === 'update'
                  ? [
                      {
                        id: 'update' as const,
                        title: 'Update',
                        detail: `Compare with ${source.name} and show only what is different. Nothing is written until you choose.`,
                      },
                    ]
                  : []),
                {
                  id: 'alongside' as const,
                  title: 'Add alongside',
                  detail: `Keep what ${machineName} has and add the copy next to it (a name that clashes gets -2).`,
                },
                {
                  id: 'replace' as const,
                  title: review.mode === 'update' ? 'Start over (Replace)' : 'Replace',
                  detail: `Replace what ${machineName} has with the copy. Its logins stay.`,
                },
              ]}
            />
          </SetupSection>
        ) : null}
        {candidates.length === 0 ? null : (
          <SetupSection title="Default runtime for new agents" name="copy-default-runtime">
            <RadioChoices
              legend="Default runtime for new agents"
              legendHidden
              name="copy-default-runtime"
              value={defaultPick === undefined ? DEFAULT_LEAVE : defaultPick === null ? DEFAULT_NONE : defaultPick}
              onChoose={value =>
                setDefaultPick(value === DEFAULT_LEAVE ? undefined : value === DEFAULT_NONE ? null : value)
              }
              options={[
                {
                  id: DEFAULT_LEAVE,
                  title: 'Let this machine decide',
                  detail: 'It keeps its own default where it still stands.',
                },
                ...candidates.map(name => ({
                  id: name,
                  title: name,
                  detail: `${source.name}’s runtime, by the name it has here.`,
                })),
                { id: DEFAULT_NONE, title: 'No default', detail: 'Leave the default unset.' },
              ]}
            />
          </SetupSection>
        )}
        {nothing ? (
          <SetupNote live tone="ok" name="copy-nothing" title="Nothing to copy">
            <span>Everything from {source.name} is already here.</span>
          </SetupNote>
        ) : null}
        {changes.refusal === null ? null : (
          <p role="alert" className="m-0 text-cell leading-base text-warn" data-copy-refusal="">
            {changes.refusal}
          </p>
        )}
        {changes.refusal === CLONE_REVIEW_STALE && lastReach.current !== null ? (
          <div>
            <Button
              type="button"
              data-copy-review-again=""
              onClick={() => {
                changes.clear();
                if (lastReach.current !== null) void read(lastReach.current);
              }}
            >
              Review again
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            data-copy-stage=""
            disabled={changes.busy || nothing || undecided.length > 0}
            onClick={stage}
          >
            {changes.busy ? 'Checking…' : 'Preview the copy'}
          </Button>
          {undecided.length === 0 ? null : (
            <p className="m-0 w-full text-meta leading-base text-warn" data-copy-undecided="">
              Decide first: {undecided.join(', ')}
            </p>
          )}
          <Button type="button" data-copy-back="" onClick={() => setPhase({ kind: 'source' })}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-copy-source="">
      <p className="m-0 text-cell leading-base text-muted">
        {machineName} receives a copy of the instructions, skills, settings and hooks of the machine you pick, so only
        pick one whose setup you’re happy for {machineName} to see. A sign-in never leaves it, and no API key is
        carried.
      </p>
      {sources.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-copy-no-sources="">
          Pair another machine first: a copy is made from a machine this browser is paired with.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {sources.map(row => (
            <li key={row.daemon} className="kt-panel flex min-w-0 items-center justify-between gap-2 p-3">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-cell font-semibold text-fg">
                <input
                  type="radio"
                  name="copy-source"
                  disabled={!row.online || row.locked}
                  checked={picked === row.daemon}
                  onChange={() => setPicked(row.daemon)}
                />
                <span className="[overflow-wrap:anywhere]">{row.machine}</span>
                {row.online ? null : <span className="text-meta font-normal text-muted">asleep or offline</span>}
                {row.locked ? <span className="text-meta font-normal text-muted">locked — unlock it first</span> : null}
              </label>
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : (
        <SetupNote live tone="err" name="copy-failed" title="Couldn’t read that machine">
          <span>{problem}</span>
        </SetupNote>
      )}
      {sources.length === 0 ? null : (
        <div>
          <Button
            type="button"
            variant="primary"
            data-copy-read=""
            disabled={picked === null || phase.kind === 'reading'}
            onClick={() => {
              const row = sources.find(candidate => candidate.daemon === picked);
              if (row !== undefined) void read(row);
            }}
          >
            {phase.kind === 'reading' ? `Reading ${phase.source}…` : 'Review the copy'}
          </Button>
        </div>
      )}
    </div>
  );
}
