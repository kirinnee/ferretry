import type { StartSessionRequest } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ContinueConversation } from '../features/fleet/conversations/continue-conversation.tsx';
import { Segmented } from '../features/fleet/conversations/conversation-picker.tsx';
import type { FleetClientFactory } from '../features/fleet/fleet-client.ts';
import { machineHash } from '../features/fleet/shell/machine-route.ts';
import { daemonDisplayName } from '../features/settings/daemon-settings.tsx';
import { useProjectsSlice } from '../hooks/use-projects.ts';
import { useUsage } from '../hooks/use-usage.ts';
import type { DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import { cn } from '../lib/class-names.ts';
import { type DaemonConnection, sameDaemonConnection } from '../lib/daemon-connection.ts';
import { FAST_COST_NOTE } from '../lib/fast-mode.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';
import {
  canSubmitNewSession,
  emptyNewSessionDraft,
  type NewSessionDraft,
  submitNewSession,
} from '../lib/pages/new-session.ts';
import { daemonSessionPath, daemonHomePath, daemonSettingsPath } from '../lib/pages/routes.ts';
import type { DaemonProjectsStore } from '../lib/projects-store.ts';
import type { DaemonUsageSlice, DaemonUsageStore } from '../lib/usage-store.ts';
import { Button, Card, PanelBody, Textarea } from '../shell/primitives.tsx';
import { PageThemeSwitch } from '../shell/theme-toggle.tsx';
import type { AccountPickerOption, AccountUsageRow } from './daemon-picker-model.ts';
import { projectPickerOptions } from './daemon-picker-model.ts';
import { DaemonProjectPicker } from './daemon-pickers.tsx';
import { FastSwitch } from './fast-switch.tsx';
import { ModelSelect } from './model-select.tsx';
import { type ChosenRuntime, RuntimeButtons } from './runtime-buttons.tsx';

/**
 * The agent runtime a first run makes for Claude Code — the example a person can actually type.
 *
 * Spelled here rather than imported: `importedRuntimeName` lives in the fleet package's root, which
 * pulls Node modules into a browser bundle. `new-session-page.test.tsx` holds this to that function.
 */
const FIRST_RUN_RUNTIME = 'claude-default';

/** The page's two ways in: a fresh session, or one carried on from a conversation already on the machine. */
const NEW_SESSION_KINDS = [
  { id: 'new', label: 'New' },
  { id: 'continue', label: 'Continue a conversation' },
] as const;

export interface NewSessionPageProps {
  /** The concrete daemon selected by pairing and matched by the current route. */
  readonly connection: DaemonConnection;
  /**
   * The name this browser shows for the machine, so "Open Settings" lands on its Runtimes tab
   * (`#machines/<machine>/runtimes`). Defaults to the name the switcher shows.
   */
  readonly machineName?: string;
  /**
   * The host's typed-client adapter. Passing the connection through this seam is
   * deliberate: a browser paired to two daemons must never create a session on
   * whichever client happened to be initialized most recently.
   */
  readonly startSession: (
    connection: DaemonConnection,
    request: StartSessionRequest,
  ) => Promise<{ readonly config: { readonly id: string } }>;
  /** Receives canonical daemon-scoped paths for both cancel and successful creation. */
  readonly onNavigate: (path: string) => void;
  /**
   * "← Sessions": a step back through history when that is where the reader came from (the router's
   * `back`), so the list returns as it was left. Absent, it is an ordinary `onNavigate`.
   */
  readonly onBack?: (path: string) => void;
  /** Where "back" leads and what it is called: the list the reader came from, or the home. Absent, the home. */
  readonly backPlace?: { readonly path: string; readonly label: string };
  /**
   * Whether Continue is the open choice, owned by the host so it survives Back and a reload — the list
   * the reader scrolled is only there to return to if Continue is still chosen. Absent, the page keeps
   * the choice itself and every visit opens on New.
   */
  readonly continuing?: boolean;
  readonly onContinuingChange?: (continuing: boolean) => void;
  /**
   * Resumes a stopped ferret in place, through the same typed client as `startSession`. With `fleet`, it
   * adds "Ferretry sessions" to Continue: every stopped ferret on this machine, resumed with its
   * conversation intact.
   */
  readonly resumeSession?: (connection: DaemonConnection, sessionId: string) => Promise<unknown>;
  /**
   * The runtime a Launch button named (`?agent=` on this page's address). A HINT ONLY: the Runtime field
   * fills it in when it offers that runtime as usable and ignores it otherwise. Nothing starts from it.
   */
  readonly initialAgent?: string;
  /**
   * THE FOUR DAEMON-SCOPED READS THIS FORM OFFERS, AND WHY EVERY ONE IS OPTIONAL.
   *
   * A store handed in turns the matching free-text box into the picker beside it;
   * a store left out keeps the plain box. That is not indecision — the boxes are
   * the real fallback surface. A host answering none of these routes, a suite
   * exercising the mutation alone, and a future shell that has not built its
   * stores yet must all still be able to start a session by typing, so the
   * absence of a catalogue never takes the field away.
   *
   * The roster. Present means the Runtime field offers this daemon's published
   * accounts; absent means it is a wrapper name typed by hand.
   */
  readonly accounts?: DaemonAccountPickerStore;
  /**
   * The CACHED quota feed, joined onto those accounts by wrapper name. It is a
   * separate prop from the roster because it is a separate read with its own
   * failure: a daemon that cannot say how much quota is left still has accounts
   * worth choosing, and rows simply read `quota —`. Nothing here ever asks a
   * fleet-wide usage route of its own; this joins the feed the app already polls.
   */
  readonly usage?: DaemonUsageStore;
  /** Registered folders. Half of the Project box's catalogue. */
  readonly projects?: DaemonProjectsStore;
  /**
   * The session list, which is the ONLY evidence for a recently used folder.
   * Recent paths are projected from it, so the Project box offers registered
   * folders alone until both this and `projects` are present — a folder nobody
   * has read a session for is not a folder anybody used.
   */
  readonly fleet?: DaemonFleetStore;
  /**
   * Present means the page also offers "Continue a conversation": search the Claude Code and Codex
   * conversations already on this machine and carry one on as a ferret. Absent keeps the form alone.
   */
  readonly createFleetClient?: FleetClientFactory;
}

type TextDraftField = Exclude<keyof NewSessionDraft, 'mode' | 'fast' | 'remoteControl'>;

const fieldId = (field: TextDraftField): string => `fy-new-session-${field}`;

/** The sentence saying why Create is unavailable, and the button's description. */
const CREATE_BLOCKER_ID = 'fy-new-session-create-blocker';

/**
 * What the Project box says while empty. Both spellings of the box — the picker
 * and the plain fallback — accept a typed path, so both say so; the picker's
 * list is the easy way on a phone, and typing is always the way out.
 */
const TYPED_PATH_PLACEHOLDER = 'Full path, e.g. /home/you/my-project';
const PICKED_PATH_PLACEHOLDER = 'Choose a folder, or type its full path';

/** The Runtime label's id, which the button group (or its typed fallback) is named by. */
const RUNTIME_LABEL_ID = 'fy-new-session-agent-label';

/** The model box's suggestion list, referenced by the input's own `list`. */
const MODEL_LIST_ID = 'fy-new-session-model-options';

/** No cached feed at all: every row says `quota —`, which is the honest reading. */
const NO_USAGE_ROWS: readonly AccountUsageRow[] = Object.freeze([]);

/**
 * WHAT A CHOSEN ACCOUNT MAY DO TO THE MODEL BOX, WHICH IS EXACTLY ONE THING.
 *
 * It may suggest. It may not write: a blank model means "this account's own
 * default", the daemon resolves that itself, and typing the default in would
 * turn it into a pin the reader never asked for — one that survives the account
 * being reconfigured on the host.
 *
 * Two things have to agree before a single model is offered, and a WRAPPER NAME
 * IS NOT ONE OF THEM ON ITS OWN:
 *
 *   1. THE SAME PAIRING. `claude-studio` on a laptop and on a workstation
 *      are unrelated accounts that happen to share a string, and a re-paired
 *      daemon keeps its id while everything the browser proved about it expires.
 *      So the choice carries its connection and is compared with
 *      `sameDaemonConnection` — the identical fence every daemon-scoped store in
 *      this app uses. Suggestions from the daemon a reader has left are worse
 *      than none: they read as evidence about the host now selected.
 *   2. THE SAME TEXT. In a control whose typed value is its output, a reader who
 *      chose one account and then typed another wrapper has changed the answer,
 *      and the first account's models no longer describe the session this form is
 *      about to start.
 *
 * Unavailable models are left out for a third reason: the manifest has already
 * said they cannot serve.
 */
const chosenForDraft = (
  chosen: ChosenRuntime | null,
  connection: DaemonConnection,
  agent: string,
): AccountPickerOption | null =>
  chosen === null || !sameDaemonConnection(chosen.connection, connection) || chosen.account.wrapper !== agent.trim()
    ? null
    : chosen.account;

const modelSuggestions = (account: AccountPickerOption | null): readonly string[] =>
  account === null ? [] : account.models.filter(model => model.available).map(model => model.id);

/**
 * The model box's placeholder, from the SAME chosen account and under the same
 * two fences as the suggestions — or nothing at all.
 *
 * It used to be a fixed `e.g. gpt-5.6-sol`, which on a Claude account named a
 * model that account cannot run. A placeholder is not a value, so naming the
 * account's own default here pins nothing; it tells a reader what a blank box
 * will get them. No chosen account, or one that declares no default, gets an
 * empty placeholder rather than a guess.
 */
/** Why the chosen model cannot launch in fast mode, or nothing when it can or nobody can say. */
const fastUnavailableReason = (account: AccountPickerOption | null, typed: string): string | undefined => {
  if (account === null) return undefined;
  const id = typed.trim() === '' ? (account.defaultModel ?? undefined) : typed.trim();
  const model = account.models.find(candidate => candidate.id === id);
  return model?.fast === false ? `${model.label ?? model.id} has no fast mode.` : undefined;
};

const FAST_REASON_ID = 'fy-new-session-fast-reason';
const REMOTE_CONTROL_ID = 'fy-new-session-remote-control';
const REMOTE_CONTROL_REASON_ID = 'fy-new-session-remote-control-reason';
/** Codex has no Remote Control surface, so its sessions can never ask for one. */
const REMOTE_CONTROL_CODEX_REASON = 'Codex has no Remote Control.';

const modelPlaceholder = (account: AccountPickerOption | null): string =>
  account?.defaultModel ? `default: ${account.defaultModel}` : '';

/**
 * What each mode MEANS to the person starting it, one short line each.
 *
 * The legend used to read "kteam turn handling" — the name of the internal tool
 * this product replaced, and a description of the mechanism rather than of what
 * the reader gets. Both lines are shown, because the reader needs the difference
 * BEFORE choosing, not after.
 */
const MODE_MEANING: Readonly<Record<NewSessionDraft['mode'], string>> = {
  auto: 'the agent works through your request on its own',
  interactive: 'opens a live terminal you type into, like a chat',
};

/**
 * Why `Create session` cannot be pressed yet, in the reader's words — or `null`
 * when it can.
 *
 * `canSubmitNewSession` owns the decision; this only names it, and checks the
 * same facts in the same order so the sentence can never describe a different
 * blocker from the one actually holding the button. A disabled button with no
 * reason is the defect this exists for: on a host with no runnable account the
 * button looked pressable and said nothing.
 */
const createBlocker = (draft: NewSessionDraft, submitting: boolean, noRunnableAccount: boolean): string | null => {
  if (submitting) return null;
  if (draft.agent.trim() === '') {
    return noRunnableAccount ? 'No runtime can run a session yet — add one first.' : 'Choose a runtime first.';
  }
  return draft.mode === 'auto' && draft.prompt.trim() === '' ? 'Say what you want the agent to do first.' : null;
};

/**
 * Why the cached quota feed cannot be trusted, whenever it cannot be.
 *
 * A FAILED REFRESH COUNTS, even though the rows below it survive. Every
 * daemon-scoped store here keeps its last good answer through a failure, which is
 * the right thing to render and the wrong thing to render silently: percentages
 * from before an outage look exactly like percentages from a second ago. So any
 * `error` status earns the sentence, and the rows stay.
 *
 * A read still in flight earns nothing: not-yet is not a failure, and rows with
 * no quota already say `quota —` on their own.
 */
const quotaAdvisory = (slice: DaemonUsageSlice): string | null =>
  slice.status === 'error' ? (slice.error ?? 'the cached quota feed could not be read') : null;

/**
 * The PWA new-session surface.
 *
 * The typed draft is the source of truth from end to end. The pickers are a way
 * to fill it in quickly: choosing a row types that row's literal string into the
 * box, and `NewSessionDraft` — not a selection — is what `canSubmitNewSession`
 * gates and `submitNewSession` sends. That is why a wrapper the last published
 * manifest never mentioned, or a folder registered a second ago, still starts:
 * the daemon is the thing that knows, and it gets to accept or refuse.
 *
 * NOTHING ON THIS SCREEN WRITES TO THE HOST EXCEPT `Create session`. Choosing a
 * recent folder registers no project, choosing an account probes no wrapper, and
 * mounting the form runs no health check — the account roster's manifest read and
 * the two folder reads are all the traffic it causes.
 */
export function NewSessionPage({
  connection,
  machineName = daemonDisplayName(connection),
  startSession,
  resumeSession,
  onNavigate,
  onBack = onNavigate,
  backPlace,
  continuing: hostContinuing,
  onContinuingChange,
  accounts,
  usage,
  projects,
  fleet,
  initialAgent,
  createFleetClient,
}: NewSessionPageProps) {
  const [draft, setDraft] = useState<NewSessionDraft>(emptyNewSessionDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosenRuntime, setChosenRuntime] = useState<ChosenRuntime | null>(null);
  const [noRunnableAccount, setNoRunnableAccount] = useState(false);
  const [ownContinuing, setOwnContinuing] = useState(false);
  const continuing = hostContinuing ?? ownContinuing;
  const setContinuing = (next: boolean): void => {
    setOwnContinuing(next);
    onContinuingChange?.(next);
  };

  const update = (field: TextDraftField, value: string): void => setDraft(current => ({ ...current, [field]: value }));
  const canSubmit = canSubmitNewSession(draft, connection, submitting);
  const homePath = daemonHomePath(connection.daemonId);
  const back = backPlace ?? { path: homePath, label: '← Home' };
  const chosen = chosenForDraft(chosenRuntime, connection, draft.agent);
  const models = modelSuggestions(chosen);
  const blocker = createBlocker(draft, submitting, noRunnableAccount);
  // A model the catalog says has no fast mode cannot be launched with it, so the switch says why it is
  // unavailable and the request never carries it (the daemon would refuse it too).
  const fastReason = fastUnavailableReason(chosen, draft.model);
  const remoteControlReason = chosen?.kind === 'codex' ? REMOTE_CONTROL_CODEX_REASON : undefined;
  const noAccounts = (
    <NoSessionAccounts
      onOpenSettings={() =>
        onNavigate(`${daemonSettingsPath(connection.daemonId)}${machineHash(machineName, 'runtimes')}`)
      }
      onShown={setNoRunnableAccount}
    />
  );

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const scope = await submitNewSession(
        {
          ...draft,
          fast: draft.fast && fastReason === undefined,
          remoteControl: draft.remoteControl && remoteControlReason === undefined,
        },
        {
          connection,
          start: request => startSession(connection, request),
        },
      );
      onNavigate(daemonSessionPath(scope.daemonId, scope.sessionId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  };

  return (
    <main
      aria-labelledby="new-session-heading"
      className="mx-auto flex h-full min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-y-auto px-3 pb-3 sm:px-0"
    >
      <div className="mb-3 mt-3 flex items-center gap-2.5">
        <button className="text-meta text-muted hover:text-fg" onClick={() => onBack(back.path)} type="button">
          {back.label}
        </button>
        <h1 className="m-0 text-title font-semibold tracking-tight" id="new-session-heading">
          New session
        </h1>
        <div className="ml-auto">
          <PageThemeSwitch />
        </div>
      </div>

      {createFleetClient === undefined ? null : (
        <div className="mb-3">
          <Segmented<'new' | 'continue'>
            label="Start"
            name="new-session-kind"
            options={NEW_SESSION_KINDS}
            value={continuing ? 'continue' : 'new'}
            onChoose={kind => setContinuing(kind === 'continue')}
          />
        </div>
      )}
      {createFleetClient === undefined || !continuing ? null : (
        <Card>
          <PanelBody>
            {fleet === undefined || resumeSession === undefined ? (
              <ContinueConversation connection={connection} createClient={createFleetClient} onNavigate={onNavigate} />
            ) : (
              <ContinueFromMachine
                connection={connection}
                createClient={createFleetClient}
                fleet={fleet}
                onNavigate={onNavigate}
                resumeSession={resumeSession}
              />
            )}
          </PanelBody>
        </Card>
      )}
      <Card hidden={continuing}>
        <PanelBody className="space-y-5">
          <SessionField
            hint="what will run this session"
            inputId={fieldId('agent')}
            label="Runtime"
            labelId={RUNTIME_LABEL_ID}
          >
            {accounts === undefined ? (
              <input
                className="kt-input w-full font-mono"
                id={fieldId('agent')}
                onChange={event => update('agent', event.target.value)}
                placeholder={`e.g. ${FIRST_RUN_RUNTIME}`}
                value={draft.agent}
              />
            ) : usage === undefined ? (
              <RuntimeField
                connection={connection}
                onChosen={setChosenRuntime}
                noAccounts={noAccounts}
                onValueChange={value => update('agent', value)}
                {...(initialAgent === undefined ? {} : { preferred: initialAgent })}
                store={accounts}
                usage={NO_USAGE_ROWS}
                usageError={null}
                value={draft.agent}
              />
            ) : (
              <QuotaRuntimeField
                connection={connection}
                noAccounts={noAccounts}
                onChosen={setChosenRuntime}
                onValueChange={value => update('agent', value)}
                {...(initialAgent === undefined ? {} : { preferred: initialAgent })}
                store={accounts}
                usage={usage}
                value={draft.agent}
              />
            )}
          </SessionField>

          <SessionField hint="the folder the agent works in" inputId={fieldId('cwd')} label="Project">
            {projects === undefined || fleet === undefined ? (
              <input
                className="kt-input w-full font-mono"
                id={fieldId('cwd')}
                onChange={event => update('cwd', event.target.value)}
                placeholder={TYPED_PATH_PLACEHOLDER}
                value={draft.cwd}
              />
            ) : (
              <ProjectCatalogField
                connection={connection}
                fleet={fleet}
                onValueChange={value => update('cwd', value)}
                projects={projects}
                value={draft.cwd}
              />
            )}
          </SessionField>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <SessionField hint="blank = account default" inputId={fieldId('model')} label="Model override">
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
                // A login with a model catalog (docs/model-catalog.md): exactly its models, by tier.
                <ModelSelect
                  customIds={chosen.modelCatalog.customIds}
                  defaultModel={chosen.defaultModel}
                  id={fieldId('model')}
                  local={chosen.modelCatalog.local}
                  models={chosen.models}
                  onChange={value => update('model', value)}
                  value={draft.model}
                />
              )}
            </SessionField>

            <fieldset>
              <legend className="mb-1.5 flex items-baseline gap-2">
                <span className="text-ui font-semibold text-fg">Mode</span>
                <span className="text-meta text-faint">how the agent runs</span>
              </legend>
              <div
                aria-label="Session mode"
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
              <dl
                className="m-0 mt-1.5 grid gap-0.5 text-meta leading-base text-muted"
                data-new-session-mode-meaning=""
              >
                {(['auto', 'interactive'] as const).map(mode => (
                  <div key={mode}>
                    <dt className="inline font-medium text-fg-soft">{mode}</dt>{' '}
                    <dd className="m-0 inline">— {MODE_MEANING[mode]}</dd>
                  </div>
                ))}
              </dl>
            </fieldset>
          </div>

          <div data-new-session-fast="">
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

          <details className="rounded-control border border-border-strong px-3 py-2" data-new-session-advanced="">
            <summary className="cursor-pointer text-ui font-medium text-fg-soft">Advanced options</summary>
            <div className="mt-2" data-new-session-remote-control="">
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
                  'Lets claude.ai/code and the Claude app drive this session. Off by default; Ferretry switches it off even if your Claude settings turn it on.'}
              </p>
            </div>
          </details>

          <SessionField hint="optional — groups related sessions" inputId={fieldId('label')} label="Label">
            <input
              className="kt-input w-full"
              id={fieldId('label')}
              onChange={event => update('label', event.target.value)}
              placeholder="e.g. website-redesign"
              value={draft.label}
            />
          </SessionField>

          <SessionField
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
          </SessionField>

          {error ? (
            <div
              className="rounded-control border border-err-border bg-err-bg px-control-x py-row-y text-ui text-err"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-sm">
            {/* The reason sits beside the button it explains and is the button's
                description, so a screen reader hears why it is unavailable. A
                disabled primary still reads as a filled accent button at 55%
                opacity — which is how it looked pressable — so until it can be
                pressed it wears the outline look instead. */}
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
              {submitting ? 'Creating…' : 'Create session'}
            </Button>
          </div>
        </PanelBody>
      </Card>
    </main>
  );
}

/** What both connected fields need from the form: the daemon, and the draft slot. */
interface ConnectedFieldProps {
  readonly connection: DaemonConnection;
  readonly value: string;
  readonly onValueChange: (next: string) => void;
}

interface RuntimeFieldProps extends ConnectedFieldProps {
  readonly store: DaemonAccountPickerStore;
  readonly usage: readonly AccountUsageRow[];
  readonly usageError: string | null;
  /** The runtime the draft names now, so the model box can suggest. It never writes a model. */
  readonly onChosen: (chosen: ChosenRuntime | null) => void;
  /** What the form says instead of the buttons. */
  readonly noAccounts: ReactNode;
  /** A Launch button's runtime, filled in only when offered and usable. */
  readonly preferred?: string;
}

/**
 * The Runtime field: one button per runtime that can run a session, under Claude and Codex.
 *
 * It offers ONLY the agent runtimes. A fleet's terminal runtime — the one a person runs by hand — is
 * published too, often first, and the daemon refuses to start a session on it in either mode; offering
 * it would make the most likely first choice a refusal. The first usable runtime is picked so a
 * first-time reader starts on something that works.
 *
 * The value is the wrapper id, because that is what the daemon is sent; the buttons show the runtime's
 * display name — as `fy runtimes` lists it.
 *
 * NO "CHECK NOW" HERE. Every button already carries the host's stored health verdict, so a re-check
 * added nothing a person needs to START a session and pushed the form a screen down on a phone. The
 * control stays on the migrate sheet, where re-proving the target is the job. Mounting this field
 * starts no check of either kind beyond the free stored-snapshot read the roster store makes itself.
 */
function RuntimeField({ store, usage, usageError, ...field }: RuntimeFieldProps) {
  return (
    <RuntimeButtons
      connection={field.connection}
      fallbackId={fieldId('agent')}
      fallbackPlaceholder={`e.g. ${FIRST_RUN_RUNTIME}`}
      labelId={RUNTIME_LABEL_ID}
      noAccounts={field.noAccounts}
      onChosen={field.onChosen}
      onValueChange={field.onValueChange}
      {...(field.preferred === undefined ? {} : { preferred: field.preferred })}
      store={store}
      usage={usage}
      usageError={usageError}
      value={field.value}
    />
  );
}

interface QuotaRuntimeFieldProps extends Omit<RuntimeFieldProps, 'usage' | 'usageError'> {
  readonly usage: DaemonUsageStore;
}

/**
 * The same field, joined onto the daemon's own cached quota feed.
 *
 * `useUsage` subscribes to the store that already polls it — there is one feed per daemon and this
 * field joins it rather than arming a second reader. It is a separate component only because a store
 * this surface was not handed cannot be subscribed to conditionally, and quota is a decoration: an
 * unread feed must never decide whether the roster is offered.
 */
function QuotaRuntimeField({ usage, ...field }: QuotaRuntimeFieldProps) {
  const slice = useUsage(usage, field.connection);
  return <RuntimeField {...field} usage={slice.feed?.accounts ?? NO_USAGE_ROWS} usageError={quotaAdvisory(slice)} />;
}

/**
 * The Runtime field's place when the daemon has NO runtime that can run a session.
 *
 * One sentence and one way forward, rather than an empty list: a new host whose
 * only account is the terminal one would otherwise offer nothing and say nothing
 * about why. Runtimes are added in Settings › Machines, on the machine's Runtimes tab.
 */
function NoSessionAccounts({
  onOpenSettings,
  onShown,
}: {
  readonly onOpenSettings: () => void;
  /** Told while this notice is on screen, so Create can say why it is unavailable. */
  readonly onShown: (shown: boolean) => void;
}) {
  useEffect(() => {
    onShown(true);
    return () => onShown(false);
  }, [onShown]);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-sm rounded-control border border-border-strong bg-surface-2 px-control-x py-row-y"
      data-new-session-no-accounts=""
    >
      <p className="m-0 min-w-[14rem] flex-1 text-ui leading-base text-fg-soft">
        No runtime on this machine can run sessions yet. Add an agent runtime in Settings › Machines.
      </p>
      <Button onClick={onOpenSettings} type="button" variant="primary">
        Create a runtime
      </Button>
    </div>
  );
}

/**
 * Continue with both sources: the machine's ferrets come from the session list the app already keeps
 * (hydrated here, like the Project box, because this form can be a first screen).
 */
function ContinueFromMachine({
  connection,
  createClient,
  fleet,
  onNavigate,
  resumeSession,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly fleet: DaemonFleetStore;
  readonly onNavigate: (path: string) => void;
  readonly resumeSession: (connection: DaemonConnection, sessionId: string) => Promise<unknown>;
}) {
  const slice = useSyncExternalStore(
    listener => fleet.subscribe(listener),
    () => fleet.fleet(connection.daemonId),
    () => fleet.fleet(connection.daemonId),
  );
  useEffect(() => {
    void fleet.hydrate(connection).catch(() => {});
  }, [fleet, connection]);
  return (
    <ContinueConversation
      connection={connection}
      createClient={createClient}
      onNavigate={onNavigate}
      sessions={slice.sessions}
      resume={async sessionId => {
        await resumeSession(connection, sessionId);
      }}
    />
  );
}

interface ProjectCatalogFieldProps extends ConnectedFieldProps {
  readonly projects: DaemonProjectsStore;
  readonly fleet: DaemonFleetStore;
}

/**
 * The Project box: folders this daemon registered, then folders its sessions
 * merely used.
 *
 * It hydrates the session list itself rather than assuming a dashboard did,
 * because this form is reachable as a first screen — and a failed read is a slice
 * status here, never a rethrow that would take down the form around it. Choosing
 * a row types a path. It does NOT register one: registration is a deliberate
 * write with its own confirmation, and this screen has no such control.
 */
function ProjectCatalogField({ projects, fleet, connection, value, onValueChange }: ProjectCatalogFieldProps) {
  const registry = useProjectsSlice(projects, connection);
  const sessions = useSyncExternalStore(
    listener => fleet.subscribe(listener),
    () => fleet.fleet(connection.daemonId),
    () => fleet.fleet(connection.daemonId),
  );
  useEffect(() => {
    void fleet.hydrate(connection).catch(() => {});
  }, [fleet, connection]);
  const catalog = useMemo(
    () => projectPickerOptions(registry.projects, sessions.sessions),
    [registry.projects, sessions.sessions],
  );
  return (
    <DaemonProjectPicker
      catalog={catalog}
      fleet={sessions}
      id={fieldId('cwd')}
      label="Project"
      onValueChange={onValueChange}
      placeholder={PICKED_PATH_PLACEHOLDER}
      projects={registry}
      value={value}
    />
  );
}

interface SessionFieldProps {
  readonly label: string;
  readonly hint: string;
  readonly inputId: string;
  /** Set when something other than the input names itself by this label (a radio group). */
  readonly labelId?: string;
  readonly children: ReactNode;
}

function SessionField({ label, hint, inputId, labelId, children }: SessionFieldProps) {
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
