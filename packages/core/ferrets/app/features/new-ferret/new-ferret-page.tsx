import { PanelSlot, useSlotHasPanels, useSlotHasUsablePanels } from '@ferretry/app';
import {
  type ChosenFerretAccount,
  type ContinuePick,
  NEW_FERRET_ACCOUNT_SLOT,
  NEW_FERRET_CONTINUE_SLOT,
  type NewFerretContinueSlotProps,
  NEW_FERRET_PROJECT_SLOT,
  type NewFerretAccountSlotProps,
  type NewFerretProjectSlotProps,
} from '@ferretry/core-ferrets/contract';
import { type ComponentType, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { LiveFerretsClient } from '../../lib/client.ts';
import {
  Button,
  Card,
  cn,
  FastSwitch,
  Loading,
  ModelSelect,
  PanelBody,
  SegmentedChoice,
  Textarea,
  useNow,
} from '../../ui.ts';
import { FolderPicker } from './folder-picker.tsx';
import { daemonHomeHref, ferretChatHref, addLoginHref } from './hrefs.ts';
import {
  canStartFerret,
  emptyNewFerretDraft,
  type NewFerretDraft,
  type StartAttempt,
  startAttemptFor,
  startFerret,
} from './new-ferret-draft.ts';
import { type FolderRead, LOADING_FOLDERS, readRecentFolders } from './recent-folders.ts';
import { type AccountSlotProps, ShellAccountSlot } from './shell-account-slot.tsx';

/** The runtime a first run makes for Claude Code — the example a person can actually type. */
const FIRST_RUN_RUNTIME = 'claude-default';

/**
 * How long the page waits for the fields' first reads before it draws the form anyway. A read that never answers must
 * not hold the whole page; past this the form shows what it has (a field still reading says so in its own place).
 */
const FIELDS_READ_LIMIT_MS = 10_000;

/** The one sentence about what fast mode costs, said once in the form's hint. */
const FAST_COST_NOTE = 'Fast mode can cost more.';

type TextDraftField = Exclude<keyof NewFerretDraft, 'mode' | 'fast' | 'remoteControl'>;

const fieldId = (field: TextDraftField): string => `fy-new-ferret-${field}`;

/** The sentence saying why Create is unavailable, and the button's description. */
const CREATE_BLOCKER_ID = 'fy-new-ferret-create-blocker';

/**
 * What the Folder box says while empty: both spellings of the box (the picker and the plain fallback) accept a typed
 * path, so both say so; the picker's list is the easy way on a phone, and typing is always the way out.
 */
const TYPED_PATH_PLACEHOLDER = 'Full path, e.g. /home/you/my-project';
const PICKED_PATH_PLACEHOLDER = 'Choose a folder, or type its full path';

const CONTINUE_LIST_ID = 'fy-new-ferret-continue-list';

/** The Runtime label's id, which the picker (or its typed fallback) is named by. */
const RUNTIME_LABEL_ID = 'fy-new-ferret-runtime-label';

/** The model box's suggestion list, referenced by the input's own `list`. */
const MODEL_LIST_ID = 'fy-new-ferret-model-options';

const REMOTE_CONTROL_ID = 'fy-new-ferret-remote-control';
const REMOTE_CONTROL_REASON_ID = 'fy-new-ferret-remote-control-reason';
/** Codex has no Remote Control surface, so its ferrets can never ask for one. */
const REMOTE_CONTROL_CODEX_REASON = 'Codex has no Remote Control.';

/**
 * WHAT A CHOSEN RUNTIME MAY DO TO THE MODEL BOX, WHICH IS EXACTLY ONE THING.
 *
 * It may suggest. It may not write: a blank model means "this runtime's own default", the daemon resolves that itself,
 * and typing the default in would turn it into a pin the reader never asked for. A wrapper name alone is not enough
 * either: in a control whose typed value is its output, a reader who chose one runtime and then typed another has
 * changed the answer, and the first runtime's models no longer describe the ferret this form is about to start.
 */
const chosenForDraft = (chosen: ChosenFerretAccount | null, runtime: string): ChosenFerretAccount | null =>
  chosen === null || chosen.wrapper !== runtime.trim() ? null : chosen;

const modelSuggestions = (account: ChosenFerretAccount | null): readonly string[] =>
  account === null ? [] : account.models.filter(model => model.available).map(model => model.id);

/**
 * The model box's placeholder, from the same chosen runtime under the same fence — or nothing at all. A placeholder is
 * not a value, so naming the runtime's own default here pins nothing; it tells a reader what a blank box will get them.
 */
const modelPlaceholder = (account: ChosenFerretAccount | null): string =>
  account?.defaultModel ? `default: ${account.defaultModel}` : '';

const FAST_REASON_ID = 'fy-new-ferret-fast-reason';

/** Why the chosen model cannot launch in fast mode, or nothing when it can or nobody can say. */
const fastUnavailableReason = (account: ChosenFerretAccount | null, typed: string): string | undefined => {
  if (account === null) return undefined;
  const id = typed.trim() === '' ? (account.defaultModel ?? undefined) : typed.trim();
  const model = account.models.find(candidate => candidate.id === id);
  return model?.fast === false ? `${model.label ?? model.id} has no fast mode.` : undefined;
};

/**
 * One segment's words: the whole phrase from `sm` up, and on a phone ONE short word so a segment never wraps. The whole phrase
 * stays the segment's name for a screen reader at every width (the short word is `aria-hidden`; the phrase is only clipped).
 */
const startLabel = (short: string, whole: string): ReactNode => (
  <>
    <span aria-hidden="true" className="sm:hidden">
      {short}
    </span>
    <span className="sr-only sm:not-sr-only">{whole}</span>
  </>
);

/** The two ways in the page offers, as the switch at its top spells them. */
const START_CHOICES = [
  { value: 'new', label: startLabel('New', 'New conversation') },
  { value: 'continue', label: startLabel('Continue', 'Continue a conversation') },
] as const;

/** What each mode MEANS to the person starting it, one short line each. */
const MODE_MEANING: Readonly<Record<NewFerretDraft['mode'], string>> = {
  auto: 'the agent works through your request on its own',
  interactive: 'opens a live terminal you type into, like a chat',
};

/**
 * Why `Create ferret` cannot be pressed yet, in the reader's words — or `null` when it can. `canStartFerret` owns the
 * decision; this only names it, checking the same facts in the same order so the sentence can never describe a
 * different blocker from the one actually holding the button.
 */
const createBlocker = (
  draft: NewFerretDraft,
  submitting: boolean,
  noRunnableAccount: boolean,
  awaitingPick: boolean,
  whereOffered: boolean,
): string | null => {
  if (submitting) return null;
  // Continue mode starts a ferret only from a conversation: until one is picked, Create would start a fresh one.
  if (awaitingPick) return 'Pick a conversation to continue.';
  if (draft.runtime.trim() === '') {
    return noRunnableAccount ? 'No runtime can run a ferret yet — add a login first.' : 'Choose a runtime first.';
  }
  // With Projects' panel the field is "Where it works" (a folder OR a project), so the sentence must not name a folder box.
  if (draft.folder.trim() === '') {
    return whereOffered ? 'Choose where the agent works first.' : 'Choose the folder the agent works in first.';
  }
  return draft.mode === 'auto' && draft.prompt.trim() === '' ? 'Say what you want the agent to do first.' : null;
};

export interface NewFerretPageProps {
  /** The daemon this page is on: the slot's panels are drawn for it. */
  readonly daemon: string;
  /** The per-daemon client; every read and the one write go through it by route key. */
  readonly client: LiveFerretsClient;
  /** Receives in-app addresses for both cancel and a successful start. */
  readonly onNavigate: (path: string) => void;
  /** "← Home": a step back through history when that is where the reader came from. Absent, an ordinary `onNavigate`. */
  readonly onBack?: (path: string) => void;
  /** Where "back" leads and what it is called. Absent, the daemon's home. */
  readonly backPlace?: { readonly path: string; readonly label: string };
  /**
   * The runtime a Launch button named (`?agent=` on this page's address). A HINT ONLY: the runtime picker fills it in
   * when it offers that runtime as usable and ignores it otherwise. Nothing starts from it.
   */
  readonly initialAgent?: string;
  /**
   * The folder a project's "Start a ferret here" named (`?folder=`). A PREFILL ONLY: it starts in the Folder box and the
   * daemon's start route still decides whether it may be used.
   */
  readonly initialFolder?: string;
  /** Open with "Continue a conversation" chosen (`?continue=1`: the Runtimes and setup links to it). */
  readonly initialContinue?: boolean;
  /** What draws the runtime field's slot. The shell's by default; a test hands a stand-in. */
  readonly AccountSlot?: ComponentType<AccountSlotProps>;
}

/**
 * The new-ferret page.
 *
 * NOTHING ON THIS SCREEN WRITES TO THE HOST EXCEPT `Create ferret`. Choosing a recent folder registers nothing,
 * choosing a runtime probes nothing, and mounting the form runs no check — the ferret list read behind the Folder box
 * is all the traffic it causes.
 */
export function NewFerretPage({
  daemon,
  client,
  onNavigate,
  onBack = onNavigate,
  backPlace,
  initialAgent,
  initialFolder,
  initialContinue = false,
  AccountSlot = ShellAccountSlot,
}: NewFerretPageProps) {
  const [draft, setDraft] = useState<NewFerretDraft>(() =>
    initialFolder === undefined
      ? emptyNewFerretDraft
      : { ...emptyNewFerretDraft, folder: initialFolder, folderExact: initialFolder },
  );
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef<StartAttempt | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [chosenRuntime, setChosenRuntime] = useState<ChosenFerretAccount | null>(null);
  const [noRunnableAccount, setNoRunnableAccount] = useState(false);
  const [folders, setFolders] = useState<FolderRead>(LOADING_FOLDERS);
  // A past conversation picked from the Continue list: it fills the form, and Create starts with it named so it resumes.
  const [picked, setPicked] = useState<ContinuePick | null>(null);
  // Which of the two ways in the page is on: a fresh conversation, or one picked from the Continue list.
  const [starting, setStarting] = useState<'new' | 'continue'>(initialContinue ? 'continue' : 'new');
  const continueOffered = useSlotHasPanels(NEW_FERRET_CONTINUE_SLOT);
  const whereOffered = useSlotHasPanels(NEW_FERRET_PROJECT_SLOT);
  // THE FORM IS DRAWN ONCE, FROM WHAT THE FIELDS READ. The runtime roster and the registered projects decide what the
  // form first shows (the runtime, Project or Folder), so until both fields that read them have said so the page shows
  // ONE centred loading state and nothing else; the fields stay mounted (hidden) so their reads run meanwhile. A field
  // nothing draws (its plugin is off here) has nothing to wait for. Once drawn the form never goes back to the loader.
  const accountReads = useSlotHasUsablePanels(daemon, NEW_FERRET_ACCOUNT_SLOT);
  const whereReads = useSlotHasUsablePanels(daemon, NEW_FERRET_PROJECT_SLOT);
  const [accountRead, setAccountRead] = useState(false);
  const [whereRead, setWhereRead] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const accountSettled = useCallback(() => setAccountRead(true), []);
  const whereSettled = useCallback(() => setWhereRead(true), []);
  const drawn = useRef(false);
  if (gaveUp || ((!accountReads || accountRead) && (!whereReads || whereRead))) drawn.current = true;
  const formDrawn = drawn.current;
  useEffect(() => {
    if (formDrawn) return undefined;
    const timer = setTimeout(() => setGaveUp(true), FIELDS_READ_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [formDrawn]);
  const pick = (next: ContinuePick | null): void => {
    setPicked(next);
    setError(null);
    // The pick is in the form: the list gives way to a one-line "Continuing" so the form is what the page shows.
    setDraft(current => {
      const { harnessConversation: _before, harness: _harness, ...rest } = current;
      if (next === null) return { ...rest, folder: '', folderExact: undefined };
      // The conversation brings its folder; a runtime of another harness cannot resume it, so that one is cleared.
      return {
        ...rest,
        folder: next.folder,
        folderExact: next.folder,
        runtime: next.harness === picked?.harness ? current.runtime : '',
        harnessConversation: next.conversation,
        harness: next.harness,
      };
    });
  };

  const chooseStart = (choice: 'new' | 'continue'): void => {
    if (choice === starting) return;
    // Going back to a new conversation drops a pick: no conversation is sent and no harness limits the runtime. With NO
    // pick there is nothing derived from a conversation to drop, and the Folder (a `?folder=` prefill or typed) stays.
    if (choice === 'new' && picked !== null) pick(null);
    setStarting(choice);
  };

  // The Folder box's catalogue: one read of the daemon's ferrets. A failure is a status, never a throw.
  useEffect(() => {
    let live = true;
    readRecentFolders(client).then(
      recent => {
        if (live) setFolders({ status: 'ready', folders: recent, error: null });
      },
      (caught: unknown) => {
        if (live)
          setFolders(current => ({
            status: 'error',
            folders: current.folders,
            error: caught instanceof Error && caught.message !== '' ? caught.message : null,
          }));
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const update = (field: TextDraftField, value: string): void => setDraft(current => ({ ...current, [field]: value }));
  // Continue is a way in only while the list is offered (the switch is drawn); on it, nothing starts before a pick.
  const awaitingPick = continueOffered && starting === 'continue' && picked === null;
  const canSubmit = canStartFerret(draft, submitting) && !awaitingPick;
  const homePath = daemonHomeHref(daemon);
  const back = backPlace ?? { path: homePath, label: '← Home' };
  const chosen = chosenForDraft(chosenRuntime, draft.runtime);
  const now = useNow();
  const models = modelSuggestions(chosen);
  const blocker = createBlocker(draft, submitting, noRunnableAccount, awaitingPick, whereOffered);
  // A model the panel says has no fast mode cannot be launched with it, so the switch says why it is unavailable and
  // the request never carries it (the daemon would refuse it too).
  const fastReason = fastUnavailableReason(chosen, draft.model);
  const remoteControlReason = chosen?.kind === 'codex' ? REMOTE_CONTROL_CODEX_REASON : undefined;
  const typedRuntime = (
    <input
      className="kt-input w-full font-mono"
      id={fieldId('runtime')}
      onChange={event => update('runtime', event.target.value)}
      placeholder={`e.g. ${FIRST_RUN_RUNTIME}`}
      value={draft.runtime}
    />
  );
  const slot: NewFerretAccountSlotProps = {
    value: draft.runtime,
    onValueChange: value => update('runtime', value),
    onChosen: setChosenRuntime,
    onSettled: accountSettled,
    fallbackId: fieldId('runtime'),
    labelId: RUNTIME_LABEL_ID,
    fallbackPlaceholder: `e.g. ${FIRST_RUN_RUNTIME}`,
    noAccounts: (
      <NoFerretAccounts onOpenSettings={() => onNavigate(addLoginHref(daemon))} onShown={setNoRunnableAccount} />
    ),
    ...(initialAgent === undefined ? {} : { preferred: initialAgent }),
    ...(picked === null ? {} : { harness: picked.harness }),
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const sent = {
        ...draft,
        fast: draft.fast && fastReason === undefined,
        remoteControl: draft.remoteControl && remoteControlReason === undefined,
      };
      // The attempt is kept until a start succeeds: a resubmit of the same draft after a lost answer is the same
      // request (same id), so the daemon answers the ferret it already started instead of starting a second one.
      attempt.current = startAttemptFor(sent, attempt.current);
      const id = await startFerret(client, sent, attempt.current);
      attempt.current = undefined;
      onNavigate(ferretChatHref(daemon, id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  };

  return (
    <main
      aria-labelledby="new-ferret-heading"
      className="mx-auto flex h-full min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-y-auto px-3 pb-3 sm:px-0"
    >
      <div className="mb-3 mt-3 flex items-center gap-2.5">
        <button className="text-meta text-muted hover:text-fg" onClick={() => onBack(back.path)} type="button">
          {back.label}
        </button>
        <h1 className="m-0 text-title font-semibold tracking-tight" id="new-ferret-heading">
          New ferret
        </h1>
      </div>

      {formDrawn ? null : <Loading kind="page" label="Reading this machine…" />}
      <Card
        data-new-ferret-form={formDrawn ? 'drawn' : 'reading'}
        {...(formDrawn ? {} : { hidden: true, style: { display: 'none' } })}
      >
        <PanelBody className="space-y-5">
          {continueOffered ? (
            <section data-new-ferret-continue="">
              <SegmentedChoice
                className="max-w-[28rem]"
                data-new-ferret-switch=""
                label="New or continue"
                onChange={chooseStart}
                options={START_CHOICES}
                value={starting}
              />
              {starting === 'continue' ? (
                picked === null ? (
                  <div className="mt-3" id={CONTINUE_LIST_ID}>
                    <PanelSlot
                      daemon={daemon}
                      props={{ picked: null, onPick: pick } satisfies NewFerretContinueSlotProps}
                      slot={NEW_FERRET_CONTINUE_SLOT}
                    />
                  </div>
                ) : (
                  <p
                    className="m-0 mt-3 flex items-center justify-between gap-sm text-meta leading-base text-fg-soft"
                    data-new-ferret-picked={picked.key}
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">Continuing: {picked.title}</span>
                    <button
                      className="min-h-[44px] shrink-0 px-2 text-ui font-medium text-fg underline"
                      onClick={() => pick(null)}
                      type="button"
                    >
                      Choose another
                    </button>
                  </p>
                )
              ) : null}
            </section>
          ) : null}

          <FerretField
            hint="what will run this ferret"
            inputId={fieldId('runtime')}
            label="Runtime"
            labelId={RUNTIME_LABEL_ID}
          >
            <AccountSlot daemon={daemon} fallback={typedRuntime} slot={slot} />
          </FerretField>

          <FerretField
            hint={whereOffered ? 'a folder, or one of your projects' : 'the folder the agent works in'}
            inputId={fieldId('folder')}
            label={whereOffered ? 'Where it works' : 'Folder'}
          >
            {whereOffered ? (
              // Projects' panel: a Folder | Project choice (the project-setup finder, recent folders, a searchable
              // project list). It puts the label's id on its main control and only proposes a folder through `onPick`.
              <PanelSlot
                daemon={daemon}
                props={
                  {
                    daemon,
                    value: draft.folder,
                    id: fieldId('folder'),
                    recent: folders.folders?.map(folder => folder.path) ?? [],
                    onPick: folder => setDraft(current => ({ ...current, folder, folderExact: folder })),
                    onSettled: whereSettled,
                  } satisfies NewFerretProjectSlotProps
                }
                slot={NEW_FERRET_PROJECT_SLOT}
              />
            ) : (
              <FolderPicker
                id={fieldId('folder')}
                label="Folder"
                onValueChange={value => update('folder', value)}
                placeholder={
                  folders.folders === null && folders.status === 'error'
                    ? TYPED_PATH_PLACEHOLDER
                    : PICKED_PATH_PLACEHOLDER
                }
                read={folders}
                value={draft.folder}
              />
            )}
          </FerretField>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FerretField hint="blank = runtime default" inputId={fieldId('model')} label="Model override">
              {chosen?.modelCatalog === undefined ? (
                <>
                  {models.length === 0 ? null : (
                    <datalist id={MODEL_LIST_ID}>
                      {models.map(model => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  )}
                  <input
                    className="kt-input w-full font-mono"
                    id={fieldId('model')}
                    list={models.length === 0 ? undefined : MODEL_LIST_ID}
                    onChange={event => update('model', event.target.value)}
                    placeholder={modelPlaceholder(chosen)}
                    value={draft.model}
                  />
                </>
              ) : (
                // A login with a model catalog (docs/model-catalog.md): exactly its models.
                <ModelSelect
                  customIds={chosen.modelCatalog.customIds}
                  defaultModel={chosen.defaultModel}
                  id={fieldId('model')}
                  models={chosen.models}
                  onChange={value => update('model', value)}
                  {...(chosen.live === undefined
                    ? {}
                    : { live: { ...chosen.live, now, providerLabel: chosen.modelCatalog.label } })}
                  value={draft.model}
                />
              )}
            </FerretField>

            <fieldset>
              <legend className="mb-1.5 flex items-baseline gap-2">
                <span className="text-ui font-semibold text-fg">Mode</span>
                <span className="text-meta text-faint">how the agent runs</span>
              </legend>
              <div
                aria-label="Ferret mode"
                className="inline-flex rounded-control border border-border bg-surface-2 p-0.5"
                role="toolbar"
              >
                {(['auto', 'interactive'] as const).map(mode => (
                  <button
                    aria-pressed={draft.mode === mode}
                    className={cn(
                      'h-control-sm rounded-control px-3 text-ui font-medium transition-colors',
                      draft.mode === mode ? 'bg-surface text-fg shadow-control' : 'text-muted hover:text-fg',
                    )}
                    key={mode}
                    onClick={() => setDraft(current => ({ ...current, mode }))}
                    type="button"
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <dl className="m-0 mt-1.5 grid gap-0.5 text-meta leading-base text-muted" data-new-ferret-mode-meaning="">
                {(['auto', 'interactive'] as const).map(mode => (
                  <div key={mode}>
                    <dt className="inline font-medium text-fg-soft">{mode}</dt>{' '}
                    <dd className="m-0 inline">— {MODE_MEANING[mode]}</dd>
                  </div>
                ))}
              </dl>
            </fieldset>
          </div>

          <div data-new-ferret-fast="">
            <FastSwitch
              ariaLabel="Fast mode"
              disabled={fastReason !== undefined}
              {...(fastReason === undefined ? {} : { disabledReason: fastReason })}
              onPress={() => setDraft(current => ({ ...current, fast: !current.fast }))}
              pressed={draft.fast && fastReason === undefined}
              reasonId={FAST_REASON_ID}
              variant="field"
            />
            {fastReason === undefined ? null : (
              <p className="sr-only" id={FAST_REASON_ID}>
                {fastReason}
              </p>
            )}
            <p className="m-0 mt-1.5 text-meta leading-base text-muted">
              Faster output on models that offer it. {FAST_COST_NOTE}
            </p>
          </div>

          <details className="rounded-panel border border-border-strong px-panel py-2" data-new-ferret-advanced="">
            <summary className="cursor-pointer text-ui font-medium text-fg-soft">Advanced options</summary>
            <div className="mt-2" data-new-ferret-remote-control="">
              <label className="flex min-h-[44px] items-start gap-sm text-ui text-fg" htmlFor={REMOTE_CONTROL_ID}>
                <input
                  aria-describedby={remoteControlReason === undefined ? undefined : REMOTE_CONTROL_REASON_ID}
                  checked={draft.remoteControl && remoteControlReason === undefined}
                  className="mt-1 h-4 w-4 shrink-0"
                  disabled={remoteControlReason !== undefined}
                  id={REMOTE_CONTROL_ID}
                  onChange={() => setDraft(current => ({ ...current, remoteControl: !current.remoteControl }))}
                  type="checkbox"
                />
                <span>Start with Remote Control on</span>
              </label>
              <p
                className="m-0 mt-1 text-meta leading-base text-muted"
                {...(remoteControlReason === undefined ? {} : { id: REMOTE_CONTROL_REASON_ID })}
              >
                {remoteControlReason ??
                  'Lets claude.ai/code and the Claude app drive this ferret. Off by default; Ferretry switches it off even if your Claude settings turn it on.'}
              </p>
            </div>
          </details>

          <FerretField hint="optional — groups related ferrets" inputId={fieldId('label')} label="Label">
            <input
              className="kt-input w-full"
              id={fieldId('label')}
              onChange={event => update('label', event.target.value)}
              placeholder="e.g. website-redesign"
              value={draft.label}
            />
          </FerretField>

          <FerretField
            hint={
              draft.mode === 'interactive' ? 'leave empty to start with a blank chat' : 'what you want the agent to do'
            }
            inputId={fieldId('prompt')}
            label={draft.mode === 'interactive' ? 'Opening message (optional)' : 'Opening prompt'}
          >
            <Textarea
              id={fieldId('prompt')}
              onChange={event => update('prompt', event.target.value)}
              placeholder={
                draft.mode === 'interactive' ? '(optional) first message…' : 'Describe what you want the agent to do…'
              }
              rows={6}
              value={draft.prompt}
            />
          </FerretField>

          {error ? (
            <div
              className="rounded-panel border border-err-border bg-err-bg px-panel py-row-y text-ui text-err"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-sm">
            {/* The reason sits beside the button it explains and is the button's description, so a screen reader hears
                why it is unavailable. A disabled primary still reads as a filled accent button at 55% opacity — which
                is how it looked pressable — so until it can be pressed it wears the outline look instead. */}
            {blocker === null ? null : (
              <p
                className="m-0 min-w-0 basis-full text-right text-meta leading-base text-muted sm:basis-0 sm:flex-1"
                id={CREATE_BLOCKER_ID}
              >
                {blocker}
              </p>
            )}
            <Button onClick={() => onNavigate(homePath)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              aria-describedby={blocker === null ? undefined : CREATE_BLOCKER_ID}
              disabled={!canSubmit}
              onClick={() => void submit()}
              type="button"
              variant={canSubmit || submitting ? 'primary' : 'outline'}
            >
              {submitting ? 'Creating…' : 'Create ferret'}
            </Button>
          </div>
        </PanelBody>
      </Card>
    </main>
  );
}

/**
 * The Runtime field's place when the picker found NO runtime that can run a ferret: one sentence and one way forward,
 * rather than an empty list. Runtimes are added in Settings › Runtimes. The picker draws this node; the page hears
 * `onShown` so Create can say why it is unavailable.
 */
function NoFerretAccounts({
  onOpenSettings,
  onShown,
}: {
  readonly onOpenSettings: () => void;
  /** Told while this notice is on screen. */
  readonly onShown: (shown: boolean) => void;
}) {
  useEffect(() => {
    onShown(true);
    return () => onShown(false);
  }, [onShown]);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-sm rounded-panel border border-border-strong bg-surface-2 px-panel py-row-y"
      data-new-ferret-no-accounts=""
    >
      <p className="m-0 min-w-[14rem] flex-1 text-ui leading-base text-fg-soft">
        No runtime on this machine can run ferrets yet. Add a login (Claude Code or Codex) and it appears here, ready.
      </p>
      <Button onClick={onOpenSettings} type="button" variant="primary">
        Add a login
      </Button>
    </div>
  );
}

interface FerretFieldProps {
  readonly label: string;
  readonly hint: string;
  readonly inputId: string;
  /** Set when something other than the input names itself by this label (a radio group). */
  readonly labelId?: string;
  readonly children: ReactNode;
}

function FerretField({ label, hint, inputId, labelId, children }: FerretFieldProps) {
  return (
    <div className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <label className="text-ui font-semibold text-fg" htmlFor={inputId} id={labelId}>
          {label}
        </label>
        <span className="text-meta text-faint">{hint}</span>
      </span>
      {children}
    </div>
  );
}
