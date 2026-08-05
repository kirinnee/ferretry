/**
 * THE OPERATOR'S LIMITS, SHOWN AND EXPLAINED.
 *
 * ## THE POINT OF THIS SCREEN IS THE EXPLANATION, NOT THE SWITCHES
 *
 * A greyed control with no explanation is the dead end this feature exists to remove. So every
 * disabled control here carries the reason it is disabled and the next step, taken from the
 * `GrantRefusal` the daemon put on the view — never from a guess this component makes, and never as a
 * bare "forbidden". The wording lives in `src/lib/grants.ts` so the Fleet tab, the Files pane and this
 * screen cannot word the same refusal three ways.
 *
 * ## LOOPBACK HAS NOTHING TO DECIDE, AND THE SCREEN SAYS SO
 *
 * A browser on `127.0.0.1` is ungoverned: every capability reads allowed and every reason reads
 * `granted`, because somebody at the machine already has the machine. The rows are still shown — this
 * is where an operator inspects the decision, and hiding it on the one machine that can change it
 * would be perverse — but the screen states, once, that they apply to callers that are not on this
 * host. Without that line a person reads `configure off` and goes hunting for a permission problem
 * their own command line does not have.
 *
 * ## AN UNLOCK IS OFFERED ONLY WHERE IT WOULD WORK
 *
 * Narrowing is never gated, so a revoke never raises a prompt: a password between a person and
 * shutting a door is a liability during the incident when it matters. Widening on a machine with a
 * password needs an unlock, and this screen asks for it inline. Widening on a machine with NO password
 * is a host act — there is nothing for a remote caller to prove — so the daemon's refusal naming
 * `fy daemon config` is rendered rather than pre-empted by a prompt that could not have helped.
 *
 * ## THE UNLOCK DIES WITH THIS SCREEN
 *
 * It is held in a `useState`, stamped with the daemon that minted it, and written to no storage of any
 * kind. Nothing here can persist it: there is no store, no `localStorage`, no URL, and the value is
 * refused for another daemon or past its expiry by `usableUnlock`. A token that outlived the tab it
 * was minted in would be a standing configure grant nobody re-consented to.
 */

import {
  CAPABILITY_AXES,
  type CapabilityAxis,
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  type GrantsView,
} from '@ferretry/protocol';
import { CircleAlert, KeyRound, Lock, LockOpen, ShieldCheck, TriangleAlert } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';

import { daemonApiClient } from '../../lib/api-client.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  axisGuidance,
  axisLabel,
  axisQuestion,
  capabilityLabel,
  capabilityReach,
  type GrantGuidance,
  grantAlreadyReads,
  grantChangeNeedsUnlock,
  grantPatch,
  type HeldUnlock,
  NO_PASSWORD_DISCLOSURE,
  type OperatorUnlockFailure,
  operatorUnlockFailure,
  originNote,
  PASSWORD_SET_DISCLOSURE,
  UNLOCK_LIMIT_NOTE,
  unlockSecondsRemaining,
  usableUnlock,
} from '../../lib/grants.ts';
import { changeGrants, type GrantClient, readGrants, unlockGrants } from './grants-api.ts';

/** The tone each guidance level paints with, kept in one place so five rows cannot disagree. */
const TONE_CLASS: Readonly<Record<GrantGuidance['tone'], string>> = {
  ok: 'border-ok-border bg-ok-bg text-ok',
  disclosure: 'border-border-soft bg-surface-2 text-muted',
  limit: 'border-warn-border bg-warn-bg text-warn',
  fault: 'border-err-border bg-err-bg text-err',
};

/**
 * One axis: what it is, whether it is on, and — when it is not changeable — why.
 *
 * THE EXPLANATION IS NOT CONDITIONAL ON HOVER, a title attribute or a disclosure. A person meeting a
 * control they cannot move needs the reason at the same moment they meet it, which means in the flow
 * of the page.
 */
function AxisControl({
  entry,
  axis,
  changeable,
  busy,
  onChange,
}: {
  readonly entry: CapabilityGrantView;
  readonly axis: CapabilityAxis;
  /** Whether the daemon would accept this browser changing this axis at all. */
  readonly changeable: boolean;
  readonly busy: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  const recorded = entry.granted[axis];
  const disabled = busy || !changeable;
  const describedBy = useId();
  /**
   * The one sentence that keeps this from being a greyed switch.
   *
   * Composed in `src/lib/grants.ts` rather than here, because the ALLOWED-but-immovable case needs its
   * own wording and getting it wrong is silent: reusing the `configure` refusal on an allowed `use`
   * row tells a person their access is switched off when it is on.
   */
  const reason = axisGuidance(entry, axis, changeable);

  return (
    <div className="min-w-0">
      <button
        type="button"
        role="switch"
        aria-checked={recorded}
        aria-describedby={describedBy}
        disabled={disabled}
        data-grant-axis={`${entry.capability}.${axis}`}
        data-grant-axis-changeable={changeable ? 'yes' : 'no'}
        onClick={() => onChange(!recorded)}
        className={cn(
          'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
          recorded ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2',
          disabled ? 'cursor-not-allowed opacity-70' : 'hover:border-accent',
        )}
      >
        <span className="min-w-0">
          <span className={cn('block text-ui font-semibold', recorded ? 'text-accent' : 'text-fg')}>
            {axisLabel(axis)}
          </span>
          <span className="block text-meta leading-base text-muted">{axisQuestion(axis)}</span>
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
            recorded ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
          )}
        >
          <span
            className={cn(
              'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
              recorded ? 'translate-x-[18px]' : 'translate-x-[2px]',
            )}
          />
        </span>
      </button>
      <p
        id={describedBy}
        className={cn('m-0 mt-1 rounded-control border px-2 py-1 text-meta leading-base', TONE_CLASS[reason.tone])}
        data-grant-axis-reason={`${entry.capability}.${axis}`}
      >
        {reason.explanation}
      </p>
    </div>
  );
}

/** One capability: what it reaches, where the answer came from, and both axes. */
function CapabilityCard({
  entry,
  view,
  busy,
  onChange,
}: {
  readonly entry: CapabilityGrantView;
  readonly view: GrantsView;
  readonly busy: boolean;
  readonly onChange: (axis: CapabilityAxis, next: boolean) => void;
}) {
  const headingId = useId();
  /**
   * Whether this browser may change this capability's grants at all.
   *
   * The DAEMON's rule, restated exactly: a caller without a proved password must already hold
   * `configure` on a capability to touch either of its axes, because an operator who said the UI may
   * not configure `terminal` is also saying the UI may not re-grant itself `terminal`. A held unlock
   * makes the caller the operator, so the per-capability gate has nothing left to add.
   */
  const changeable = view.unlocked || (entry.granted.use && entry.granted.configure);

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-labelledby={headingId}
      data-grant-capability={entry.capability}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={headingId} className="m-0 text-ui font-semibold text-fg">
          {capabilityLabel(entry.capability)}
        </h4>
        <span
          className="rounded-control border border-border-soft bg-surface-2 px-2 py-0.5 text-meta text-faint"
          data-grant-origin={entry.origin}
        >
          {entry.origin === 'config file' ? 'set by the operator' : 'product default'}
        </span>
      </div>
      <p className="m-0 text-meta leading-base text-muted">{capabilityReach(entry.capability)}</p>
      <p className="m-0 text-meta leading-base text-faint">{originNote(entry)}</p>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {CAPABILITY_AXES.map(axis => (
          <AxisControl
            key={axis}
            entry={entry}
            axis={axis}
            changeable={changeable}
            busy={busy}
            onChange={next => onChange(axis, next)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The unlock prompt.
 *
 * IT SAYS WHAT THE LIMITER IS BEFORE ANYBODY SPENDS A TRY, and how many are left after a wrong one —
 * a limiter a person cannot see is a limiter that looks like a broken daemon. It discloses nothing
 * else about the password: not whether it was close, not its length, nothing. The field is
 * `type="password"` with `autoComplete="off"` because this is a local operator secret rather than a
 * site login, and a browser password manager offering to save it would put it somewhere this product
 * cannot reason about.
 */
export function GrantUnlockPrompt({
  held,
  daemonId,
  nowMs,
  failure,
  busy,
  onUnlock,
}: {
  readonly held: HeldUnlock | null;
  readonly daemonId: DaemonConnection['daemonId'];
  readonly nowMs: number;
  readonly failure: OperatorUnlockFailure | null;
  readonly busy: boolean;
  readonly onUnlock: (password: string) => void;
}) {
  const fieldId = useId();
  const [password, setPassword] = useState('');
  const secondsLeft = unlockSecondsRemaining(held, daemonId, nowMs);
  const unlocked = usableUnlock(held, daemonId, nowMs) !== undefined;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password === '' || busy) return;
    onUnlock(password);
    // Cleared on submit rather than on success: a wrong password is retyped, and holding the last
    // attempt in a field is one more place the value sits while somebody walks away from the screen.
    setPassword('');
  };

  if (unlocked)
    return (
      <section
        className="kt-panel flex min-w-0 flex-col gap-1 p-panel"
        aria-label="Operator unlock"
        data-grant-unlock="held"
      >
        <p className="m-0 flex items-center gap-1.5 text-ui font-semibold text-ok">
          <LockOpen size={15} aria-hidden="true" />
          Unlocked for {secondsLeft}s
        </p>
        <p className="m-0 text-meta leading-base text-muted">
          Held in this tab only, for this machine only. It is never saved, and closing this page ends it — so a change
          made later needs the password again.
        </p>
      </section>
    );

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-label="Operator unlock"
      data-grant-unlock="prompt"
    >
      <p className="m-0 flex items-center gap-1.5 text-ui font-semibold text-fg">
        <Lock size={15} className="text-accent" aria-hidden="true" />
        Operator password
      </p>
      <p className="m-0 text-meta leading-base text-muted">
        Turning a capability on from off this host needs it. Turning one off never does.
      </p>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
        <label className="sr-only" htmlFor={fieldId}>
          Operator password for this machine
        </label>
        <input
          id={fieldId}
          type="password"
          value={password}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          data-grant-unlock-field=""
          onChange={event => setPassword(event.target.value)}
          className="h-control min-w-0 flex-1 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button type="submit" className="kt-btn min-h-[44px] shrink-0" disabled={busy || password === ''}>
          <KeyRound size={15} aria-hidden="true" />
          Unlock
        </button>
      </form>
      {failure === null ? (
        <p className="m-0 text-meta leading-base text-faint">{UNLOCK_LIMIT_NOTE}</p>
      ) : (
        <p
          role="alert"
          className={cn(
            'm-0 rounded-control border px-2 py-1 text-meta leading-base',
            failure.retryable ? TONE_CLASS.limit : TONE_CLASS.fault,
          )}
          data-grant-unlock-failure={failure.retryable ? 'retryable' : 'final'}
        >
          {failure.message}
        </p>
      )}
    </section>
  );
}

export interface GrantsCardProps {
  readonly connection: DaemonConnection;
  readonly view: GrantsView;
  /** Now, supplied rather than read, so an unlock countdown is deterministic in a test. */
  readonly nowMs: number;
  readonly busy?: boolean;
  readonly held?: HeldUnlock | null;
  readonly unlockFailure?: OperatorUnlockFailure | null;
  /** A refusal the daemon answered a change with, rendered whole. */
  readonly changeFailure?: string | null;
  readonly onChange: (capability: DaemonCapability, axis: CapabilityAxis, next: boolean) => void;
  readonly onUnlock: (password: string) => void;
}

/**
 * The render-only grant surface.
 *
 * It takes the view and reports intent; it fetches nothing and holds no connection state, so the same
 * component is what the harness screenshots and what a test drives.
 */
export function GrantsCard({
  connection,
  view,
  nowMs,
  busy = false,
  held = null,
  unlockFailure: failure = null,
  changeFailure = null,
  onChange,
  onUnlock,
}: GrantsCardProps) {
  const headingId = useId();
  /**
   * The rows, in the protocol's declared order rather than the array's arrival order.
   *
   * A daemon is free to serve them in any order, and five permission rows that reshuffle between
   * reads are five rows a person cannot build a habit around. A capability the view omits is simply
   * absent — this screen never invents a row and therefore never shows an answer nobody gave.
   */
  const entries = DAEMON_CAPABILITIES.map(capability =>
    view.capabilities.find(candidate => candidate.capability === capability),
  ).filter((entry): entry is CapabilityGrantView => entry !== undefined);
  /** Whether anything here could need the password, so the prompt is not offered where it is inert. */
  const unlockUseful = view.passwordSet && view.lockedUntil === undefined;

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby={headingId}
      data-grant-surface={String(connection.daemonId)}
    >
      <section className="kt-panel flex min-w-0 flex-col gap-2 p-panel">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-title font-semibold text-fg">
            <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
            What a paired device may do
          </h3>
          <span
            className={cn(
              'rounded-control border px-2 py-0.5 text-meta font-medium',
              view.passwordSet ? TONE_CLASS.ok : TONE_CLASS.disclosure,
            )}
            data-grant-password-set={view.passwordSet ? 'yes' : 'no'}
          >
            {view.passwordSet ? 'operator password set' : 'no operator password'}
          </span>
        </div>
        {/* The line that stops the commonest wrong reading of this whole screen. */}
        <p className="m-0 text-ui leading-base text-muted">
          These apply to callers that are <strong className="text-fg">not on this machine</strong> — a paired phone, a
          browser across the network, a session carried over the relay. A browser running on the machine itself is
          governed by none of it, because somebody at the machine already has the machine.
        </p>
        {/* The disclosure, ONCE, next to the configure controls it is about. Not a modal, not a
            recurring warning, and not a question anybody has to answer. */}
        <p
          className={cn(
            'm-0 rounded-control border px-3 py-2 text-ui leading-base',
            view.passwordSet ? TONE_CLASS.disclosure : TONE_CLASS.limit,
          )}
          data-grant-disclosure={view.passwordSet ? 'password-set' : 'no-password'}
        >
          {view.passwordSet ? PASSWORD_SET_DISCLOSURE : NO_PASSWORD_DISCLOSURE}
        </p>
        {view.lockedUntil === undefined ? null : (
          <p
            role="alert"
            className={cn('m-0 rounded-control border px-3 py-2 text-ui leading-base', TONE_CLASS.fault)}
            data-grant-locked-until={view.lockedUntil}
          >
            <TriangleAlert size={14} className="mr-1 inline" aria-hidden="true" />
            Too many wrong operator passwords, so this daemon has stopped checking them. It starts again at{' '}
            {view.lockedUntil}. The limit counts per machine, so this can be a colleague’s wrong guesses rather than
            yours.
          </p>
        )}
      </section>

      {unlockUseful ? (
        <GrantUnlockPrompt
          held={held}
          daemonId={connection.daemonId}
          nowMs={nowMs}
          failure={failure}
          busy={busy}
          onUnlock={onUnlock}
        />
      ) : null}

      {entries.map(entry => (
        <CapabilityCard
          key={entry.capability}
          entry={entry}
          view={view}
          busy={busy}
          onChange={(axis, next) => onChange(entry.capability, axis, next)}
        />
      ))}

      {changeFailure === null ? null : (
        <p
          role="alert"
          className={cn('m-0 rounded-control border px-3 py-2 text-ui leading-base', TONE_CLASS.fault)}
          data-grant-change-failure=""
        >
          <CircleAlert size={14} className="mr-1 inline" aria-hidden="true" />
          {/* The daemon's own sentence, whole. It already names the command a human runs, composed by
              the layer that knows what this product's client is called; replacing it with wording
              invented here would either repeat it or contradict it. */}
          {changeFailure}
        </p>
      )}
    </section>
  );
}

export type GrantClientFactory = (connection: DaemonConnection) => Promise<GrantClient>;
/** Now, injected, so nothing in this surface reads a clock a test cannot move. */
export type GrantClock = () => number;

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The live, daemon-bound grant surface.
 *
 * A FAILED READ IS NOT AN UNGOVERNED DAEMON. A view this browser could not fetch renders as a stated
 * refusal, never as five allowed rows — a person shown "everything is permitted" over a daemon the
 * browser simply could not reach would draw exactly the wrong conclusion about their own machine.
 */
export function GrantsSurface({
  connection,
  createClient = daemonApiClient,
  now = Date.now,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: GrantClientFactory;
  readonly now?: GrantClock;
}) {
  const [client, setClient] = useState<GrantClient | null>(null);
  const [loaded, setLoaded] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly view: GrantsView;
  } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly reason: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeFailure, setChangeFailure] = useState<string | null>(null);
  /** The unlock, in component state. Never a store, never storage. It dies with this screen. */
  const [held, setHeld] = useState<HeldUnlock | null>(null);
  const [failure, setFailure] = useState<OperatorUnlockFailure | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setLoadFailure(null);
    setChangeFailure(null);
    // A held unlock belongs to the daemon that minted it, so switching machines drops it rather than
    // carrying a credential across a boundary everything else here is keyed by.
    setHeld(null);
    setFailure(null);
    void createClient(connection)
      .then(async next => {
        const view = await readGrants(next);
        if (!current) return;
        setClient(next);
        setLoaded({ daemonId: connection.daemonId, view });
      })
      .catch(cause => {
        if (current) setLoadFailure({ daemonId: connection.daemonId, reason: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const change = useCallback(
    async (capability: DaemonCapability, axis: CapabilityAxis, next: boolean) => {
      if (client === null || loaded?.daemonId !== connection.daemonId) return;
      const view = loaded.view;
      // Nothing is sent for a change the document already records: the patch would be accepted and
      // report nothing changed, and on a governed machine a no-op widen would spend an unlock demand.
      if (grantAlreadyReads(view, capability, axis, next)) return;
      setBusy(true);
      setChangeFailure(null);
      try {
        const unlock = grantChangeNeedsUnlock(view, capability, next)
          ? usableUnlock(held, connection.daemonId, now())
          : undefined;
        const updated = await changeGrants(client, grantPatch(capability, axis, next), unlock);
        setLoaded({ daemonId: connection.daemonId, view: updated });
      } catch (cause) {
        setChangeFailure(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId, held, loaded, now],
  );

  const unlock = useCallback(
    async (password: string) => {
      if (client === null || loaded?.daemonId !== connection.daemonId) return;
      setBusy(true);
      setFailure(null);
      try {
        const minted = await unlockGrants(client, password);
        setHeld({
          daemonId: connection.daemonId,
          token: minted.token,
          expiresAtMs: Date.parse(minted.expiresAt),
        });
        // Re-read, because holding an unlock changes what the view says is possible: `configure`
        // reasons move off `locked`, and a screen still showing the old ones would keep explaining a
        // limit the reader has just cleared.
        setLoaded({ daemonId: connection.daemonId, view: await readGrants(client) });
      } catch (cause) {
        setFailure(operatorUnlockFailure(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId, loaded?.daemonId],
  );

  if (loaded?.daemonId === connection.daemonId)
    return (
      <GrantsCard
        connection={connection}
        view={loaded.view}
        nowMs={now()}
        busy={busy}
        held={held}
        unlockFailure={failure}
        changeFailure={changeFailure}
        onChange={(capability, axis, next) => void change(capability, axis, next)}
        onUnlock={password => void unlock(password)}
      />
    );
  if (loadFailure?.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Capability grants unavailable">
        <h3 className="m-0 text-title font-semibold text-fg">Capability limits unavailable</h3>
        <p className="mb-0 mt-1 text-ui leading-base text-muted">
          This daemon did not say what a paired device may do on it, so Ferretry will not show a limit or claim there is
          none. Nothing here is evidence that this machine is unrestricted.
        </p>
        {/* The daemon's own words, on their own line rather than run into the sentence above: they are
            a message from somewhere else, and appending one mid-paragraph reads as a typo. */}
        <p className="mb-0 mt-2 text-meta leading-base text-faint" data-grant-load-failure="">
          {loadFailure.reason}
        </p>
      </section>
    );
  return (
    <section className="kt-panel p-panel" role="status" aria-label="Loading capability grants">
      <p className="m-0 text-ui leading-base text-muted">Reading what this machine allows a paired device to do…</p>
    </section>
  );
}
