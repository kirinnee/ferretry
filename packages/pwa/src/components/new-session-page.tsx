import type { StartSessionRequest } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { AccountPickerOption, AccountUsageRow } from './daemon-picker-model.ts';
import { projectPickerOptions } from './daemon-picker-model.ts';
import { DaemonAccountPicker, DaemonProjectPicker } from './daemon-pickers.tsx';
import { useProjectsSlice } from '../hooks/use-projects.ts';
import { useUsage } from '../hooks/use-usage.ts';
import type { DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import { type DaemonConnection, sameDaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';
import {
  canSubmitNewSession,
  emptyNewSessionDraft,
  submitNewSession,
  type NewSessionDraft,
} from '../lib/pages/new-session.ts';
import { daemonSessionPath, daemonSessionsPath } from '../lib/pages/routes.ts';
import type { DaemonProjectsStore } from '../lib/projects-store.ts';
import type { DaemonUsageSlice, DaemonUsageStore } from '../lib/usage-store.ts';
import { cn } from '../lib/class-names.ts';
import { Button, Card, PanelBody, Textarea } from '../shell/primitives.tsx';

export interface NewSessionPageProps {
  /** The concrete daemon selected by pairing and matched by the current route. */
  readonly connection: DaemonConnection;
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
   * THE FOUR DAEMON-SCOPED READS THIS FORM OFFERS, AND WHY EVERY ONE IS OPTIONAL.
   *
   * A store handed in turns the matching free-text box into the picker beside it;
   * a store left out keeps the plain box. That is not indecision — the boxes are
   * the real fallback surface. A host answering none of these routes, a suite
   * exercising the mutation alone, and a future shell that has not built its
   * stores yet must all still be able to start a session by typing, so the
   * absence of a catalogue never takes the field away.
   *
   * The roster. Present means the Account box offers this daemon's published
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
}

type TextDraftField = Exclude<keyof NewSessionDraft, 'mode'>;

const fieldId = (field: TextDraftField): string => `fy-new-session-${field}`;

/** The model box's suggestion list, referenced by the input's own `list`. */
const MODEL_LIST_ID = 'fy-new-session-model-options';

/** No cached feed at all: every row says `quota —`, which is the honest reading. */
const NO_USAGE_ROWS: readonly AccountUsageRow[] = Object.freeze([]);

/** A chosen row, and the pairing it was chosen on. Never one without the other. */
interface ChosenAccount {
  readonly connection: DaemonConnection;
  readonly account: AccountPickerOption;
}

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
 *   1. THE SAME PAIRING. `claude-auto-studio` on a laptop and on a workstation
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
const modelSuggestions = (
  chosen: ChosenAccount | null,
  connection: DaemonConnection,
  agent: string,
): readonly string[] =>
  chosen === null || !sameDaemonConnection(chosen.connection, connection) || chosen.account.wrapper !== agent.trim()
    ? []
    : chosen.account.models.filter(model => model.available).map(model => model.id);

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
  startSession,
  onNavigate,
  accounts,
  usage,
  projects,
  fleet,
}: NewSessionPageProps) {
  const [draft, setDraft] = useState<NewSessionDraft>(emptyNewSessionDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosenAccount, setChosenAccount] = useState<ChosenAccount | null>(null);

  const update = (field: TextDraftField, value: string): void => setDraft(current => ({ ...current, [field]: value }));
  const canSubmit = canSubmitNewSession(draft, connection, submitting);
  const sessionsPath = daemonSessionsPath(connection.daemonId);
  const models = modelSuggestions(chosenAccount, connection, draft.agent);

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const scope = await submitNewSession(draft, {
        connection,
        start: request => startSession(connection, request),
      });
      onNavigate(daemonSessionPath(scope.daemonId, scope.sessionId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  };

  return (
    <main
      aria-labelledby="new-session-heading"
      className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-y-auto pb-3"
    >
      <div className="mb-3 mt-3 flex items-center gap-2.5">
        <button className="text-meta text-muted hover:text-fg" onClick={() => onNavigate(sessionsPath)} type="button">
          ← Sessions
        </button>
        <h1 className="m-0 text-title font-semibold tracking-tight" id="new-session-heading">
          New session
        </h1>
      </div>

      <Card>
        <PanelBody className="space-y-5">
          <SessionField
            hint="the wrapper or account that will run this session"
            inputId={fieldId('agent')}
            label="Account"
          >
            {accounts === undefined ? (
              <input
                className="kt-input w-full font-mono"
                id={fieldId('agent')}
                onChange={event => update('agent', event.target.value)}
                placeholder="claude-auto-loge"
                value={draft.agent}
              />
            ) : usage === undefined ? (
              <AccountRosterField
                connection={connection}
                onAccountChosen={account => setChosenAccount({ account, connection })}
                onValueChange={value => update('agent', value)}
                store={accounts}
                usage={NO_USAGE_ROWS}
                usageError={null}
                value={draft.agent}
              />
            ) : (
              <QuotaAccountField
                connection={connection}
                onAccountChosen={account => setChosenAccount({ account, connection })}
                onValueChange={value => update('agent', value)}
                store={accounts}
                usage={usage}
                value={draft.agent}
              />
            )}
          </SessionField>

          <SessionField hint="working directory for the session" inputId={fieldId('cwd')} label="Project">
            {projects === undefined || fleet === undefined ? (
              <input
                className="kt-input w-full font-mono"
                id={fieldId('cwd')}
                onChange={event => update('cwd', event.target.value)}
                placeholder="/absolute/path/to/project"
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
                placeholder="e.g. gpt-5.6-sol"
                value={draft.model}
              />
            </SessionField>

            <fieldset>
              <legend className="mb-1.5 flex items-baseline gap-2">
                <span className="text-ui font-semibold text-fg">Mode</span>
                <span className="text-meta text-faint">kteam turn handling</span>
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
            </fieldset>
          </div>

          <SessionField hint="optional — groups related sessions" inputId={fieldId('label')} label="Label">
            <input
              className="kt-input w-full"
              id={fieldId('label')}
              onChange={event => update('label', event.target.value)}
              placeholder="e.g. kteam-ui"
              value={draft.label}
            />
          </SessionField>

          <SessionField
            hint={
              draft.mode === 'interactive' ? 'leave empty to open the TUI at its prompt' : 'the task for this teammate'
            }
            inputId={fieldId('prompt')}
            label={draft.mode === 'interactive' ? 'Opening message (optional)' : 'Opening prompt'}
          >
            <Textarea
              id={fieldId('prompt')}
              onChange={event => update('prompt', event.target.value)}
              placeholder={draft.mode === 'interactive' ? '(optional) first message…' : 'Describe the task…'}
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

          <div className="flex items-center justify-end gap-sm">
            <Button onClick={() => onNavigate(sessionsPath)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => void submit()} type="button" variant="primary">
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

interface AccountRosterFieldProps extends ConnectedFieldProps {
  readonly store: DaemonAccountPickerStore;
  readonly usage: readonly AccountUsageRow[];
  readonly usageError: string | null;
  /** A CHOSEN row, so the model box can suggest. It never writes a model. */
  readonly onAccountChosen: (account: AccountPickerOption) => void;
}

/**
 * The Account box, with the health check offered and never taken.
 *
 * `offerHealthCheck` puts a button on this surface because choosing an account is
 * exactly when evidence about it is worth paying for — and it stays a button:
 * mounting this field starts no probe, and neither does opening or filtering the
 * list. The roster's own manifest read is the only thing hydration causes.
 */
function AccountRosterField({ store, usage, usageError, ...field }: AccountRosterFieldProps) {
  return (
    <DaemonAccountPicker
      connection={field.connection}
      id={fieldId('agent')}
      label="Account"
      offerHealthCheck={true}
      onAccountChosen={field.onAccountChosen}
      onValueChange={field.onValueChange}
      placeholder="claude-auto-loge"
      store={store}
      usage={usage}
      usageError={usageError}
      value={field.value}
    />
  );
}

interface QuotaAccountFieldProps extends Omit<AccountRosterFieldProps, 'usage' | 'usageError'> {
  readonly usage: DaemonUsageStore;
}

/**
 * The same box, joined onto the daemon's own cached quota feed.
 *
 * `useUsage` subscribes to the store that already polls it — there is one feed
 * per daemon and this field joins it rather than arming a second reader. It is a
 * separate component only because a store this surface was not handed cannot be
 * subscribed to conditionally, and quota is a decoration: an unread feed must
 * never decide whether the roster is offered.
 */
function QuotaAccountField({ usage, ...field }: QuotaAccountFieldProps) {
  const slice = useUsage(usage, field.connection);
  return (
    <AccountRosterField {...field} usage={slice.feed?.accounts ?? NO_USAGE_ROWS} usageError={quotaAdvisory(slice)} />
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
      placeholder="/absolute/path/to/project"
      projects={registry}
      value={value}
    />
  );
}

interface SessionFieldProps {
  readonly label: string;
  readonly hint: string;
  readonly inputId: string;
  readonly children: ReactNode;
}

function SessionField({ label, hint, inputId, children }: SessionFieldProps) {
  return (
    <div className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <label className="text-ui font-semibold text-fg" htmlFor={inputId}>
          {label}
        </label>
        <span className="text-meta text-faint">{hint}</span>
      </span>
      {children}
    </div>
  );
}
