import type { SessionView } from '@ferretry/protocol';
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
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { daemonApiClient } from '../lib/api-client.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionKey, type DaemonSessionScope } from '../lib/daemon-scope.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';
import { Button } from '../shell/primitives.tsx';
import { statusMark, TERMINAL_STATUSES } from '../shell/status-mark.tsx';
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
) => Promise<SessionView>;

/** The production adapter: one typed client, bound to one runtime-paired daemon. */
export const migrateSessionWithDaemon: MigrateSession = async (connection, scope, input) => {
  if (connection.daemonId !== scope.daemonId) throw new Error('migration scope must belong to the requested daemon');
  const client = await daemonApiClient(connection);
  return await client.migrate(scope.sessionId, input.agent, input.model, input.allowContextDowngrade);
};

export interface MigrateSheetProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly view: SessionView;
  readonly canMutate: boolean;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onMigrated: (connection: DaemonConnection, scope: DaemonSessionScope, view: SessionView) => void;
  readonly migrateSession?: MigrateSession;
}

type MigrationPhase = 'form' | 'confirm' | 'submitting' | 'downgrade' | 'refused';

const readableNumber = (value: number): string => new Intl.NumberFormat().format(value);

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
}: MigrateSheetProps) {
  const { config, state } = view;
  const headingId = useId();
  const agentHelpId = useId();
  const modelId = useId();
  const modelListId = useId();
  const currentModel = (config.model || config.modelHint || '').trim();
  const [agent, setAgent] = useState(config.agent);
  const [model, setModel] = useState(currentModel);
  const [phase, setPhase] = useState<MigrationPhase>('form');
  const [failure, setFailure] = useState<MigrationFailure | null>(null);
  const [downgradeAcknowledged, setDowngradeAcknowledged] = useState(false);
  const submitLock = useRef(false);
  const scopedIdentity = JSON.stringify([connection.daemonId, daemonSessionKey(scope), config.id]);
  const liveIdentity = useRef(scopedIdentity);
  liveIdentity.current = scopedIdentity;

  // All local draft/error/acknowledgement state belongs to this exact daemon
  // and session. Same-shaped ids on another paired daemon start clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger, see above
  useEffect(() => {
    if (!open) return;
    setAgent(config.agent);
    setModel(currentModel);
    setPhase('form');
    setFailure(null);
    setDowngradeAcknowledged(false);
    submitLock.current = false;
  }, [open, connection.daemonId, scope.daemonId, scope.sessionId, config.id]);

  const target = useMemo(() => migrationTarget(agent, model), [agent, model]);
  const context = migrationContextDecision({
    currentModel,
    ...(state.contextWindow === undefined ? {} : { currentWindow: state.contextWindow }),
    ...(state.contextTokens === undefined ? {} : { contextTokens: state.contextTokens }),
    targetModel: model,
  });
  const scopeMismatch = connection.daemonId !== scope.daemonId || scope.sessionId !== config.id;
  const hasRuntimeChange = migrationHasRuntimeChange(config.agent, currentModel, target);
  const canReview = canMutate && !scopeMismatch && target !== null && hasRuntimeChange && !context.conversationTooLarge;
  const suggestions = migrationModelSuggestions(currentModel);
  const caution = migrationRoutingCaution(agent);
  const terminal = TERMINAL_STATUSES.has(state.status);
  const busy = statusMark(view).klass === 'active';

  const editAgent = (next: string): void => {
    setAgent(next);
    setFailure(null);
    setDowngradeAcknowledged(false);
    setPhase('form');
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
    submitLock.current = true;
    setFailure(null);
    setPhase('submitting');
    try {
      const migrated = await migrateSession(connection, scope, input);
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
              <p className="mt-1 text-meta leading-base text-muted">
                This daemon does not publish an account picker yet. Enter a configured {config.harness} account.
              </p>
              <label className="mt-2 grid gap-1.5 text-ui text-fg" htmlFor={`${headingId}-agent`}>
                <span className="font-semibold">Agent wrapper</span>
                <input
                  id={`${headingId}-agent`}
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
                <span id={agentHelpId} className="text-meta leading-base text-muted">
                  Current account: <span className="mono">{config.agent}</span>. Cross-CLI migration is not offered:
                  Claude and Codex cannot resume each other’s conversation format.
                </span>
              </label>
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
              <ul className="mt-2 grid gap-2 pl-5 text-ui leading-base text-muted">
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
