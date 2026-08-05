import type { IFyApiClient, SessionView } from '@ferretry/protocol';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CircleHelp,
  LoaderCircle,
  RefreshCw,
  ServerCog,
  ShieldAlert,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import { daemonApiClient } from '../lib/api-client.ts';
import { type DaemonConnection, sameDaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import type { DaemonUsageSlice, DaemonUsageStore } from '../lib/usage-store.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';
import { pickerIdBase } from '../shell/picker-model.ts';
import { Button } from '../shell/primitives.tsx';
import { statusMark, TERMINAL_STATUSES } from '../shell/status-mark.tsx';
import type { AccountPickerOption, AccountUsageRow } from './daemon-picker-model.ts';
import { DaemonAccountPicker } from './daemon-pickers.tsx';
import {
  type MigrationFailure,
  type MigrationTarget,
  migrationContextDecision,
  migrationFailure,
  migrationHasRuntimeChange,
  migrationModelSuggestions,
  migrationRoutingCaution,
  migrationTarget,
  oneMillionVariant,
} from './migrate-model.ts';

export type MigrateSession = (
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  input: MigrationTarget,
  requestId: string,
) => Promise<SessionView>;

type MigrateClient = Pick<IFyApiClient, 'migrate'>;
export type MigrateClientFactory = (connection: DaemonConnection) => Promise<MigrateClient>;

/** The production adapter: one typed client, bound to one runtime-paired daemon. */
export const migrateSessionWithDaemon = async (
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  input: MigrationTarget,
  requestId: string,
  createClient: MigrateClientFactory = daemonApiClient,
): Promise<SessionView> => {
  if (connection.daemonId !== scope.daemonId) throw new Error('migration scope must belong to the requested daemon');
  const client = await createClient(connection);
  return await client.migrate(scope.sessionId, input.agent, input.model, input.allowContextDowngrade, requestId);
};

/**
 * The stable identity of ONE logical migration.
 *
 * A migration is destructive and the typed client retries its POST on transport failure, so the id
 * has to outlive a single call: every attempt at the same target must be the same operation to the
 * daemon. It must equally NOT outlive the target — once the reader picks a different account, model
 * or downgrade answer, that is a new decision, and reusing the previous id would have the daemon
 * answer with the migration the reader just changed their mind about.
 */
export const migrationRequestKey = (scope: DaemonSessionScope, input: MigrationTarget): string =>
  JSON.stringify([daemonSessionKey(scope), input.agent, input.model ?? null, input.allowContextDowngrade]);

export interface MigrateSheetProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly view: SessionView;
  readonly canMutate: boolean;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onMigrated: (connection: DaemonConnection, scope: DaemonSessionScope, view: SessionView) => void;
  readonly migrateSession?: MigrateSession;
  /**
   * This daemon's published account roster.
   *
   * Optional because the field it feeds is an OFFER, not a requirement: without
   * it the sheet keeps the plain wrapper text box, which is also what a reader
   * gets when the roster read fails. Nothing downstream of this prop can make a
   * wrapper unsubmittable.
   */
  readonly accountPicker?: DaemonAccountPickerStore;
  /**
   * The daemon's CACHED `/v1/usage` feed, joined onto the offered rows.
   *
   * A decoration on the roster and never a gate on it: an unread or unreadable
   * feed leaves every row saying `quota —`, which is the honest reading, and
   * never a confident 0 %.
   */
  readonly usage?: DaemonUsageStore;
}

type MigrationPhase = 'form' | 'confirm' | 'submitting' | 'downgrade' | 'refused';

const readableNumber = (value: number): string => new Intl.NumberFormat().format(value);

/** Shared identities, so a "nothing here" state cannot re-render by itself. */
const NO_MODELS: readonly string[] = Object.freeze([]);
const NO_USAGE_ROWS: readonly AccountUsageRow[] = Object.freeze([]);
const UNREAD_USAGE: DaemonUsageSlice = Object.freeze({ feed: null, status: 'idle' as const, error: null });

/** A chosen row, and the pairing it was chosen on. Never one without the other. */
interface ChosenAccount {
  readonly connection: DaemonConnection;
  readonly account: AccountPickerOption;
}

/**
 * THE ONE THING A CHOSEN ACCOUNT MAY DO TO THE MODEL BOX: SUGGEST.
 *
 * It may not write. Blank means "this account's own default", the daemon
 * resolves that itself, and typing the default in would turn it into a pin the
 * reader never asked for.
 *
 * Two facts have to agree before a single model is offered, and the wrapper name
 * is NOT one of them on its own:
 *
 *   1. THE SAME PAIRING. A `DaemonId` survives an unpair/re-pair, which makes it
 *      the right cache key and the wrong liveness token. The roster this choice
 *      came from is already fenced off by `sameDaemonConnection` the moment the
 *      pairing changes, so suggestions that outlived it would be the previous
 *      host's evidence presented as this one's — while the wrapper text, the
 *      daemon id and the session id all still look identical.
 *   2. THE SAME TEXT. In a control whose typed value is its output, a reader who
 *      typed over the wrapper has changed the answer, and the account they chose
 *      before no longer describes the session about to be relaunched.
 *
 * Unavailable models are left out for a third reason: the manifest has already
 * said they cannot serve. `new-session-page.tsx` states the same rule for the
 * same reasons; a third surface needing it is the moment it earns its own module.
 */
const chosenAccountModels = (
  chosen: ChosenAccount | null,
  connection: DaemonConnection,
  agent: string,
): readonly string[] =>
  chosen === null || !sameDaemonConnection(chosen.connection, connection) || chosen.account.wrapper !== agent.trim()
    ? NO_MODELS
    : chosen.account.models.filter(model => model.available).map(model => model.id);

interface CachedAccountUsage {
  readonly rows: readonly AccountUsageRow[];
  /** Why the quota beside the rows is missing or stale. Never fails the roster. */
  readonly error: string | null;
}

/**
 * The daemon's cached quota feed, read only while this sheet is really offering
 * a choice.
 *
 * The store is OPTIONAL and the hook still runs unconditionally, because the
 * alternative — reading it inside the branch that renders the picker — would
 * make a hook call depend on a prop. `watch` is refcounted in the store, so a
 * sheet that joins while the dashboard is already polling costs no second
 * timer; `active` is what keeps a closed sheet from starting a first one.
 *
 * It reads the CACHED feed and nothing else. The live per-account probe is a
 * button, and it is the store below that owns it.
 */
const useCachedAccountUsage = (
  store: DaemonUsageStore | undefined,
  connection: DaemonConnection,
  active: boolean,
): CachedAccountUsage => {
  useEffect(() => {
    if (store === undefined || !active) return undefined;
    return store.watch(connection);
  }, [store, connection, active]);
  const subscribe = useCallback(
    (listener: () => void) => (store === undefined ? () => undefined : store.subscribe(listener)),
    [store],
  );
  const read = useCallback(() => store?.usage(connection.daemonId) ?? UNREAD_USAGE, [store, connection.daemonId]);
  const slice = useSyncExternalStore(subscribe, read, read);
  return {
    rows: slice.feed?.accounts ?? NO_USAGE_ROWS,
    // Only a failed read is worth a sentence. A feed that simply has no row for
    // an account is already said, per row, by the row itself.
    error: slice.status === 'error' ? slice.error : null,
  };
};

/**
 * Destructive account/model migration, guarded by the daemon's in-operation
 * preflight. There is deliberately no browser-side classifier or force path:
 * the mounted RPC inspects immediately before it writes and refuses every
 * destructive or unknown in-flight item without mutating the session.
 */
export function MigrateSheet({
  connection,
  scope,
  view,
  canMutate,
  open,
  onClose,
  onMigrated,
  migrateSession = migrateSessionWithDaemon,
  accountPicker,
  usage,
}: MigrateSheetProps) {
  const { config, state } = view;
  const headingId = useId();
  const agentHelpId = useId();
  // `headingId` is `useId()`'s raw colon-bearing form, and this id is passed
  // straight through as `DaemonAccountPicker`'s explicit `id` prop — which
  // `PickerCombobox` then uses verbatim as its element-id base, skipping the
  // sanitizing fallback it only applies to its own generated id. Sanitizing
  // here is what keeps the picker's derived ids (listbox, options, panel)
  // selector-safe.
  const agentFieldId = `${pickerIdBase(headingId)}-agent`;
  const modelId = useId();
  const modelListId = useId();
  const currentModel = (config.model || config.modelHint || '').trim();
  const [agent, setAgent] = useState(config.agent);
  const [model, setModel] = useState(currentModel);
  /**
   * The row a reader chose, WITH the pairing it was chosen on, because that pair
   * is the only thing that can prove the choice still describes this daemon.
   * What it is allowed to affect is `chosenAccountModels` and nothing else.
   */
  const [chosenAccount, setChosenAccount] = useState<ChosenAccount | null>(null);
  const [phase, setPhase] = useState<MigrationPhase>('form');
  const [failure, setFailure] = useState<MigrationFailure | null>(null);
  const [downgradeAcknowledged, setDowngradeAcknowledged] = useState(false);
  const submitLock = useRef(false);
  const scopedIdentity = JSON.stringify([connection.daemonId, daemonSessionKey(scope), config.id]);
  const liveIdentity = useRef(scopedIdentity);
  liveIdentity.current = scopedIdentity;
  // The request identity of the migration currently on offer. Held in a ref, not
  // state, because minting it must not re-render, and because a repeated submit
  // has to observe the SAME id the first submit used.
  const requestIdentity = useRef<{ key: string; id: string } | null>(null);

  // All local draft/error/acknowledgement state belongs to this exact daemon
  // and session. Same-shaped ids on another paired daemon start clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger, see above
  useLayoutEffect(() => {
    if (!open) return;
    setAgent(config.agent);
    setModel(currentModel);
    setPhase('form');
    setFailure(null);
    setDowngradeAcknowledged(false);
    setChosenAccount(null);
    submitLock.current = false;
    requestIdentity.current = null;
  }, [open, connection.daemonId, scope.daemonId, scope.sessionId, config.id]);

  const target = useMemo(() => migrationTarget(agent, model), [agent, model]);
  const context = migrationContextDecision({
    currentModel,
    ...(state.contextWindow === undefined ? {} : { currentWindow: state.contextWindow }),
    ...(state.contextTokens === undefined ? {} : { contextTokens: state.contextTokens }),
    targetModel: model,
  });
  const scopeMismatch = connection.daemonId !== scope.daemonId || scope.sessionId !== config.id;
  const hasRuntimeChange = migrationHasRuntimeChange(config.agent, currentModel, config.modelHint, target);
  const canReview = canMutate && !scopeMismatch && target !== null && hasRuntimeChange && !context.conversationTooLarge;
  // The chosen account's models lead, because they are the ones the reader has
  // just given this daemon's word for; the current model's own variants stay,
  // because moving account and keeping the window is the common migration.
  const suggestions = useMemo(
    () => [
      ...new Set([
        ...chosenAccountModels(chosenAccount, connection, agent),
        ...migrationModelSuggestions(currentModel),
      ]),
    ],
    [chosenAccount, connection, agent, currentModel],
  );
  const caution = migrationRoutingCaution(agent);
  const terminal = TERMINAL_STATUSES.has(state.status);
  const busy = statusMark(view).klass === 'active';
  const quota = useCachedAccountUsage(usage, connection, open && canMutate && accountPicker !== undefined);

  const editAgent = (next: string): void => {
    setAgent(next);
    // The chosen row is deliberately NOT cleared here: `chosenAccountModels`
    // already refuses to offer it once the text disagrees, and clearing it would
    // additionally lose the choice when a reader types the same wrapper back.
    setFailure(null);
    setDowngradeAcknowledged(false);
    setPhase('form');
  };

  /**
   * A chosen row, AFTER `editAgent` has already committed its wrapper — the
   * control writes the value and then reports the option, so this only ever
   * records what the value alone cannot carry: which option it was, and which
   * pairing said so.
   */
  const chooseAccount = (account: AccountPickerOption): void => {
    setChosenAccount({ account, connection });
  };

  const editModel = (next: string): void => {
    setModel(next);
    setFailure(null);
    setDowngradeAcknowledged(false);
    setPhase('form');
  };

  const review = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canReview) return;
    setFailure(null);
    setPhase('confirm');
  };

  const performMigration = async (allowContextDowngrade: boolean): Promise<void> => {
    if (
      submitLock.current ||
      scopeMismatch ||
      target === null ||
      !hasRuntimeChange ||
      context.conversationTooLarge ||
      (allowContextDowngrade && !downgradeAcknowledged)
    )
      return;

    const submittedIdentity = scopedIdentity;
    const input: MigrationTarget = { ...target, allowContextDowngrade };
    // One id per logical target. A repeated confirmation of the SAME target reuses
    // it, so the daemon recognises the second ask as the first one rather than
    // relaunching twice; changing the target mints a new one.
    const key = migrationRequestKey(scope, input);
    const identity = requestIdentity.current?.key === key ? requestIdentity.current : { key, id: crypto.randomUUID() };
    requestIdentity.current = identity;
    submitLock.current = true;
    setFailure(null);
    setPhase('submitting');
    try {
      const migrated = await migrateSession(connection, scope, input, identity.id);
      if (liveIdentity.current !== submittedIdentity) return;
      onMigrated(connection, scope, migrated);
      onClose();
    } catch (error) {
      if (liveIdentity.current !== submittedIdentity) return;
      const nextFailure = migrationFailure(error);
      setFailure(nextFailure);
      if (nextFailure.kind === 'context-downgrade' && !allowContextDowngrade) setPhase('downgrade');
      else if (nextFailure.kind === 'preflight-refused') setPhase('refused');
      else setPhase('confirm');
    } finally {
      if (liveIdentity.current === submittedIdentity) submitLock.current = false;
    }
  };

  // A read-only connection never draws a destructive control. The hooks above
  // still run consistently if authority changes while this host stays mounted.
  if (!canMutate) return null;

  // One sentence, two fields. It is the target of `aria-describedby` either
  // way, so a reader hears the same account it names whichever control they are
  // standing in.
  const agentHelp = (
    <span id={agentHelpId} className="text-meta leading-base text-muted">
      Current account: <span className="mono">{config.agent}</span>. Cross-CLI migration is not offered: Claude and
      Codex cannot resume each other’s conversation format.
    </span>
  );

  return (
    <BottomSheet
      id={`migrate-${config.id}`}
      open={open}
      onClose={phase === 'submitting' ? () => undefined : onClose}
      labelledBy={headingId}
      closeLabel="Close change model or account"
      panelClassName="kt-details bg-surface"
      maxHeight="min(94dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y" data-daemon-id={connection.daemonId}>
        <div className="flex items-center gap-sm">
          <ServerCog aria-hidden="true" className="text-accent" size={16} />
          <h1 id={headingId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Change model or account
          </h1>
        </div>
        <p className="mt-1 text-ui leading-base text-muted">
          Relaunch this conversation on another same-CLI account or model.
        </p>
      </div>

      {phase === 'submitting' ? (
        <div
          className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-3 px-panel pb-6 text-center"
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="animate-spin text-accent" size={28} />
          <p className="m-0 text-title font-semibold text-fg">
            Migrating — running the safety gate, stopping the old pane and relaunching…
          </p>
          <p className="m-0 max-w-xl text-ui leading-base text-muted">
            Keep this sheet open. A large conversation can take tens of seconds to resume.
          </p>
        </div>
      ) : phase === 'form' ? (
        <form className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5" noValidate onSubmit={review}>
          <div className="mx-auto grid w-full max-w-2xl gap-5 py-4">
            <section aria-labelledby={`${headingId}-account-heading`}>
              <h2 id={`${headingId}-account-heading`} className="m-0 text-ui font-semibold text-fg">
                Target account
              </h2>
              {accountPicker === undefined ? (
                <>
                  {/* Says nothing about whether this daemon publishes a roster:
                      the field is mounted without one here, which is a fact
                      about this surface and not evidence about the host. */}
                  <p className="mt-1 text-meta leading-base text-muted">Enter a configured {config.harness} account.</p>
                  <label className="mt-2 grid gap-1.5 text-ui text-fg" htmlFor={agentFieldId}>
                    <span className="font-semibold">Agent wrapper</span>
                    <input
                      id={agentFieldId}
                      aria-describedby={agentHelpId}
                      autoCapitalize="none"
                      autoCorrect="off"
                      className="kt-input !min-h-[44px] w-full mono"
                      onChange={event => editAgent(event.target.value)}
                      placeholder="codex-auto-atomi"
                      required
                      spellCheck={false}
                      value={agent}
                    />
                    {agentHelp}
                  </label>
                </>
              ) : (
                <>
                  <p className="mt-1 text-meta leading-base text-muted">
                    Only this daemon’s {config.harness} accounts are offered. A wrapper it has never published is still
                    submitted exactly as typed — the daemon is the thing that accepts or refuses one.
                  </p>
                  {/* Not a wrapping `<label>`: the rows are inside this control,
                      and a click on one inside a label would be re-dispatched at
                      the input and close the panel under the finger. */}
                  <div className="mt-2 grid gap-1.5 text-ui text-fg">
                    <label className="font-semibold" htmlFor={agentFieldId}>
                      Agent wrapper
                    </label>
                    <DaemonAccountPicker
                      connection={connection}
                      describedBy={agentHelpId}
                      harness={config.harness}
                      id={agentFieldId}
                      label="Agent wrapper"
                      offerHealthCheck={true}
                      onAccountChosen={chooseAccount}
                      onValueChange={editAgent}
                      placeholder="codex-auto-atomi"
                      store={accountPicker}
                      usage={quota.rows}
                      usageError={quota.error}
                      value={agent}
                    />
                    {agentHelp}
                  </div>
                </>
              )}
              {caution ? (
                <p className="mt-2 flex items-start gap-xs text-ui leading-base text-warn">
                  <CircleHelp aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
                  {caution}
                </p>
              ) : null}
            </section>

            <section aria-labelledby={`${headingId}-model-heading`}>
              <label id={`${headingId}-model-heading`} className="text-ui font-semibold text-fg" htmlFor={modelId}>
                Model
              </label>
              <input
                id={modelId}
                autoCapitalize="none"
                autoCorrect="off"
                className="kt-input mt-2 !min-h-[44px] w-full mono"
                list={modelListId}
                onChange={event => editModel(event.target.value)}
                placeholder={agent.trim() === config.agent ? 'Enter a different model' : 'Use the account default'}
                spellCheck={false}
                value={model}
              />
              <datalist id={modelListId}>
                {suggestions.map(suggestion => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
              <p className="mt-1 text-meta leading-base text-muted">
                Leave empty to use the account’s default model. Add <span className="mono">[1m]</span> for the
                million-token context variant.
              </p>

              {context.conversationTooLarge &&
              context.targetWindow !== undefined &&
              state.contextTokens !== undefined ? (
                <div
                  className="mt-3 rounded-control border border-err bg-surface-2 p-3 text-ui leading-base text-err"
                  role="alert"
                >
                  <div className="flex items-start gap-sm">
                    <AlertOctagon aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
                    <span>
                      This conversation ({readableNumber(state.contextTokens)} tokens) no longer fits that model’s
                      window ({readableNumber(context.targetWindow)}). Pick a <span className="mono">[1m]</span>
                      variant. The daemon refuses this even with a downgrade acknowledgement.
                    </span>
                  </div>
                </div>
              ) : context.isDowngrade && context.currentWindow !== undefined && context.targetWindow !== undefined ? (
                <div className="mt-3 rounded-control border border-warn-border bg-surface-2 p-3">
                  <div className="flex items-start gap-sm text-warn">
                    <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
                    <p className="m-0 text-ui leading-base">
                      This appears to reduce the context window from {readableNumber(context.currentWindow)} to{' '}
                      {readableNumber(context.targetWindow)} tokens. The daemon will verify that and require a separate
                      acknowledgement before it proceeds.
                    </p>
                  </div>
                </div>
              ) : null}
            </section>

            <section aria-labelledby={`${headingId}-safety-heading`}>
              <h2 id={`${headingId}-safety-heading`} className="m-0 text-ui font-semibold text-fg">
                Migration safety
              </h2>
              <p className="mt-1 text-meta leading-base text-muted">
                The daemon inspects the pane and process tree inside the migration request, immediately before any
                write. A preview here would already be stale by the time the pane is replaced.
              </p>
              {/* `list-disc` is explicit: the preflight resets `list-style` on every
                  `ul`, and these three statements are the sheet's whole account of
                  the safety model — unmarked they read as one run-on paragraph. */}
              <ul className="mt-2 grid list-disc gap-2 pl-5 text-ui leading-base text-muted">
                <li>Destructive or unknown in-flight work refuses the migration without changing the session.</li>
                <li>This public route has no force switch, and this sheet does not invent one.</li>
                <li>On success, the daemon writes the forensic report and hands it to the replacement agent.</li>
              </ul>
            </section>

            {scopeMismatch ? (
              <p className="m-0 text-ui leading-base text-err" role="alert">
                This session does not belong to the selected daemon. Return to the fleet and reopen it before migrating.
              </p>
            ) : !hasRuntimeChange && target !== null ? (
              <p className="m-0 text-ui leading-base text-warn" role="status">
                Choose another account or enter a different model. Relaunching the same account and model would only
                destroy the current pane.
              </p>
            ) : null}

            <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
              <Button className="min-h-[44px]" onClick={onClose} type="button">
                Cancel
              </Button>
              <Button className="min-h-[44px]" disabled={!canReview} type="submit" variant="primary">
                Review migration <ArrowRight aria-hidden="true" size={15} />
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5">
          <div className="mx-auto grid w-full max-w-2xl gap-4 py-4">
            {phase === 'refused' && failure ? (
              <section
                aria-labelledby={`${headingId}-refused-heading`}
                className="rounded-control border border-err bg-surface-2 p-4"
              >
                <div className="flex items-start gap-sm text-err">
                  <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={19} />
                  <div>
                    <h2 id={`${headingId}-refused-heading`} className="m-0 text-title font-semibold text-fg">
                      {failure.title}
                    </h2>
                    <p className="mt-1 text-ui leading-base text-muted">{failure.guidance}</p>
                  </div>
                </div>
                <pre
                  className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-code-bg p-3 text-code leading-base text-code-fg"
                  role="alert"
                >
                  {failure.message}
                </pre>
                <p className="mt-3 text-ui font-semibold text-err">
                  There is no force control. A refused preflight cannot start a migration.
                </p>
              </section>
            ) : phase === 'downgrade' && failure ? (
              <section
                aria-labelledby={`${headingId}-downgrade-heading`}
                className="rounded-control border border-warn-border bg-surface-2 p-4"
              >
                <div className="flex items-start gap-sm text-warn">
                  <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={19} />
                  <div>
                    <h2 id={`${headingId}-downgrade-heading`} className="m-0 text-title font-semibold text-fg">
                      {failure.title}
                    </h2>
                    <p className="mt-1 text-ui leading-base text-muted">{failure.guidance}</p>
                  </div>
                </div>
                <p className="mt-3 break-words text-ui leading-base text-warn" role="alert">
                  {failure.message}
                </p>
                <Button
                  className="mt-3 min-h-[44px] w-full justify-center"
                  onClick={() => editModel(failure.suggestedModel ?? oneMillionVariant(model || currentModel))}
                  type="button"
                  variant="primary"
                >
                  Use {failure.suggestedModel ? <span className="mono">{failure.suggestedModel}</span> : 'a 1M model'}{' '}
                  instead
                </Button>
                <label className="mt-3 flex min-h-[52px] items-start gap-sm rounded-control border border-warn-border p-3 text-ui text-fg">
                  <input
                    checked={downgradeAcknowledged}
                    className="mt-1 h-4 w-4 shrink-0"
                    onChange={event => setDowngradeAcknowledged(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    I understand this session may permanently outgrow the smaller window and become unrecoverable.
                  </span>
                </label>
              </section>
            ) : (
              <section
                aria-labelledby={`${headingId}-confirm-heading`}
                className="rounded-control border border-warn-border bg-surface-2 p-4"
              >
                <div className="flex items-start gap-sm text-warn">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={19} />
                  <div>
                    <h2 id={`${headingId}-confirm-heading`} className="m-0 text-title font-semibold text-fg">
                      This is a destructive relaunch
                    </h2>
                    <p className="mt-1 text-ui leading-base text-muted">
                      {terminal
                        ? `This will relaunch the stopped session under ${target?.agent ?? agent}.`
                        : `Migrating relaunches this session under ${target?.agent ?? agent}. The daemon will refuse if the current turn cannot be interrupted safely.`}
                    </p>
                  </div>
                </div>
              </section>
            )}

            <section aria-labelledby={`${headingId}-target-heading`}>
              <h2 id={`${headingId}-target-heading`} className="m-0 text-ui font-semibold text-fg">
                Requested runtime
              </h2>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-sm rounded-control border border-border bg-surface-2 p-3 text-ui">
                <span className="mono break-all text-muted">{config.agent}</span>
                <ArrowRight aria-hidden="true" className="shrink-0 text-accent" size={15} />
                <span className="mono break-all font-semibold text-fg">{target?.agent ?? agent.trim()}</span>
                <span className="mono break-all text-muted">{target?.model ?? 'account default'}</span>
              </div>
            </section>

            {busy ? (
              <div
                className="flex items-center gap-sm rounded-control border-l-heavy border-warn bg-surface-2 p-3 text-ui font-semibold text-warn"
                role="alert"
              >
                <RefreshCw aria-hidden="true" className="shrink-0" size={17} />
                This session is working right now. The daemon’s preflight decides whether it can be interrupted.
              </div>
            ) : null}

            {phase === 'confirm' && failure ? (
              <div className="rounded-control border border-err bg-surface-2 p-4" role="alert">
                <h2 className="m-0 text-title font-semibold text-fg">{failure.title}</h2>
                <p className="mt-2 break-words text-ui leading-base text-err">{failure.message}</p>
                <p className="mt-2 text-ui leading-base text-muted">{failure.guidance}</p>
              </div>
            ) : null}

            <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
              <Button
                className="min-h-[44px]"
                onClick={() => {
                  setFailure(null);
                  setDowngradeAcknowledged(false);
                  setPhase('form');
                }}
                type="button"
              >
                Back
              </Button>
              <Button
                className="min-h-[44px]"
                disabled={phase === 'downgrade' && !downgradeAcknowledged}
                onClick={() => void performMigration(phase === 'downgrade')}
                type="button"
                variant="danger"
              >
                {phase === 'downgrade'
                  ? 'Migrate with smaller window'
                  : phase === 'refused'
                    ? 'Retry safety check'
                    : terminal
                      ? 'Relaunch on selected runtime'
                      : 'Migrate and relaunch'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
