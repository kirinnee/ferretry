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
 * ## THE PASSKEY IS OFFERED ONLY WHERE IT WOULD HELP
 *
 * A governed browser's dangerous acts need a passkey step-up. The carrier asks for it by itself when
 * the daemon refuses, so no press is ever blocked here; what this screen adds is the way to do it
 * BEFORE the press — one button, which is the app's single step-up prompt (`store.stepUp.require`),
 * never a second prompt of its own — and one plain sentence saying why a row reads "needs your passkey".
 * Nothing about a step-up is held here: the daemon remembers it, and the view says whether it does.
 */

import {
  CAPABILITY_AXES,
  type CapabilityAxis,
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  type GrantsView,
} from '@ferretry/protocol';
import { CircleAlert, Fingerprint, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  axisGuidance,
  axisLabel,
  axisQuestion,
  capabilityLabel,
  capabilityReach,
  connectionPosture,
  type GrantGuidance,
  grantAlreadyReads,
  grantChangeable,
  grantOnlyAtMachine,
  grantPatch,
  grantScopeKey,
  grantScopeNote,
  originNote,
  remoteRevokeWarning,
  STEP_UP_NOTE,
} from '../../lib/grants.ts';
import { useDaemonClient, useStepUpRequest } from '../../lib/store.tsx';
import { CapabilityList } from './capability-list.tsx';
import { changeGrants, type GrantClient, readGrants } from './grants-api.ts';

/** The tone each guidance level paints with, kept in one place so five rows cannot disagree. */
const TONE_CLASS: Readonly<Record<GrantGuidance['tone'], string>> = {
  ok: 'border-ok-border bg-ok-bg text-ok',
  disclosure: 'border-border-strong bg-surface-2 text-muted',
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
  oneWay,
  busy,
  onChange,
}: {
  readonly entry: CapabilityGrantView;
  readonly axis: CapabilityAxis;
  /** Whether the daemon would accept this browser changing this axis at all. */
  readonly changeable: boolean;
  /** True when this caller may switch the capability off but never back on. */
  readonly oneWay: boolean;
  readonly busy: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  const recorded = entry.granted[axis];
  /**
   * An off axis a one-way caller may never turn on is NOT A CONTROL.
   *
   * Rendering a switch that fails on press teaches somebody the product is broken; the truth is that
   * the machine decided, and a sentence naming the machine is the useful thing in its place. This is
   * the owner's rule made structural: "do not render a control that always fails."
   */
  const deadWideningSwitch = oneWay && !recorded;
  const disabled = busy || !changeable || deadWideningSwitch;
  const describedBy = useId();
  /**
   * The one sentence that keeps this from being a greyed switch.
   *
   * Composed in `src/lib/grants.ts` rather than here, because the ALLOWED-but-immovable case needs its
   * own wording and getting it wrong is silent: reusing the `configure` refusal on an allowed `use`
   * row tells a person their access is switched off when it is on.
   */
  const reason = deadWideningSwitch
    ? {
        tone: 'limit' as const,
        badge: 'Only at the machine',
        explanation: grantOnlyAtMachine(entry.capability),
        offersStepUp: false,
      }
    : axisGuidance(entry, axis, changeable);

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
   * Whether this browser may change this capability's grants at all — the DAEMON's rule, in
   * `grantChangeable`. A passkey step-up never decides it: that can be obtained on the spot.
   */
  const changeable = grantChangeable(view, entry);
  /**
   * Whether a switch here can travel back.
   *
   * `mayGrant` is false for every remote caller, unconditionally — no passkey step-up buys
   * widening. So for such a caller an OFF axis is not a control at all, and an ON axis is a door that
   * only closes. Both facts are stated rather than discovered by pressing something.
   */
  const oneWay = !entry.mayGrant;

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
          className="rounded-control border border-border-strong bg-surface-2 px-2 py-0.5 text-meta text-faint"
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
            oneWay={oneWay}
            busy={busy}
            onChange={next => onChange(axis, next)}
          />
        ))}
      </div>
      {/* THE ONE-WAY DOOR, said before anybody walks through it. A remote caller may switch this off
          and can never switch it back on, so the consequence belongs beside the switch rather than in
          a document read afterwards. It is shown while the capability is still ON, because that is the
          only moment the warning can change what somebody does. */}
      {oneWay && entry.granted.use ? (
        <p
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-2 py-1 text-meta leading-base text-warn"
          data-grant-one-way={entry.capability}
        >
          {remoteRevokeWarning(entry.capability)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The passkey panel: says whether this device has confirmed, and offers to.
 *
 * ONE SENTENCE AND ONE BUTTON. The button is the app's own step-up prompt, so a second prompt component
 * would be a second place for the ceremony to go wrong. It is rendered only for a governed caller who has
 * not stepped up and only when the screen was handed a way to ask; a caller on the machine is never
 * asked, and a confirmed device is told so rather than shown a button that would do nothing.
 */
export function GrantStepUpPanel({
  steppedUp,
  busy,
  onStepUp,
}: {
  readonly steppedUp: boolean;
  readonly busy: boolean;
  readonly onStepUp?: (() => void) | undefined;
}) {
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-label="Passkey confirmation"
      data-grant-step-up={steppedUp ? 'held' : 'needed'}
    >
      <p className="m-0 flex items-center gap-1.5 text-ui font-semibold text-fg">
        <Fingerprint size={15} className="text-accent" aria-hidden="true" />
        {steppedUp ? 'Confirmed with your passkey' : 'Passkey confirmation'}
      </p>
      <p className="m-0 text-meta leading-base text-muted">{STEP_UP_NOTE}</p>
      {steppedUp || onStepUp === undefined ? null : (
        <div>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-grant-step-up-open=""
            disabled={busy}
            onClick={onStepUp}
          >
            <Fingerprint size={15} aria-hidden="true" />
            Confirm with passkey…
          </button>
        </div>
      )}
    </section>
  );
}

export interface GrantsCardProps {
  readonly connection: DaemonConnection;
  readonly view: GrantsView;
  readonly busy?: boolean;
  /** A refusal the daemon answered a change with, rendered whole. */
  readonly changeFailure?: string | null;
  readonly onChange: (capability: DaemonCapability, axis: CapabilityAxis, next: boolean) => void;
  /** Asks for the passkey step-up now. Absent when this screen was given no way to ask. */
  readonly onStepUp?: () => void;
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
  busy = false,
  changeFailure = null,
  onChange,
  onStepUp,
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
  /** Which of the connections this is, from the DAEMON's own account of the request. */
  const posture = connectionPosture(view.governed);

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby={headingId}
      data-grant-surface={String(connection.daemonId)}
    >
      {/* READING BEFORE CHANGING. The list answers "what may this browser do here, why, and how much
          does each one hand over"; the switches below answer "change it". Somebody arriving from a
          refused control needs the first question answered before the second is even relevant.

          `governed` is PASSED rather than inferred. It is the DAEMON's account of the connection —
          `isGovernedCaller(request.loopback)` — and letting the list fall back to `mayGrant` unanimity here
          would be the second derivation of one fact, harmless while `mayGrant` is `!governed` and wrong the
          moment it is not. It is never inferred from this page's address, which would invert the answer
          over a relay. The fallback stays for a browser meeting an OLDER daemon that does not send the
          field. */}
      <CapabilityList connection={connection} capabilities={view.capabilities} governed={view.governed} />
      <section className="kt-panel flex min-w-0 flex-col gap-2 p-panel">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
            <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
            What a paired device may do
          </h3>
          {view.governed ? (
            <span
              className={cn(
                'rounded-control border px-2 py-0.5 text-meta font-medium',
                view.steppedUp ? TONE_CLASS.ok : TONE_CLASS.disclosure,
              )}
              data-grant-stepped-up={view.steppedUp ? 'yes' : 'no'}
            >
              {view.steppedUp ? 'passkey confirmed' : 'passkey not confirmed yet'}
            </span>
          ) : null}
        </div>
        {/* The line that stops the commonest wrong reading of this whole screen, BRANCHED because one
            sentence cannot be true for every connection. */}
        <p className="m-0 text-cell leading-base text-muted" data-grant-scope={grantScopeKey(posture)}>
          {grantScopeNote(posture)}
        </p>
      </section>

      {/* The passkey, for a caller the limits govern. A caller on the machine is never asked for one. */}
      {view.governed ? <GrantStepUpPanel steppedUp={view.steppedUp} busy={busy} onStepUp={onStepUp} /> : null}

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
export type StepUpRequest = (connection: DaemonConnection) => Promise<boolean>;

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
  createClient: injectedClient,
  requestStepUp: injectedStepUp,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: GrantClientFactory;
  /** Test and harness override for the app's step-up prompt. */
  readonly requestStepUp?: StepUpRequest;
}) {
  // The carrier-routed client unless a test or the harness hands one in: a plain-network client
  // reaches no daemon at all, because a paired browser is answered only inside its own session.
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const appStepUp = useStepUpRequest();
  const requestStepUp = injectedStepUp ?? appStepUp;
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
  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setLoadFailure(null);
    setChangeFailure(null);
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
      // report nothing changed, and on a governed machine a no-op would still ask for a passkey.
      if (grantAlreadyReads(view, capability, axis, next)) return;
      setBusy(true);
      setChangeFailure(null);
      try {
        const updated = await changeGrants(client, grantPatch(capability, axis, next));
        setLoaded({ daemonId: connection.daemonId, view: updated });
      } catch (cause) {
        setChangeFailure(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId, loaded],
  );

  /**
   * Asks for the passkey BEFORE a press, then re-reads the view.
   *
   * The re-read is the point: holding a step-up changes what the view says is possible — the refusals
   * move off `step-up-required` — and a screen still showing the old ones would keep explaining a limit
   * the reader has just cleared. A dismissed prompt changes nothing and says nothing.
   */
  const stepUp = useCallback(async () => {
    if (client === null || requestStepUp === undefined || loaded?.daemonId !== connection.daemonId) return;
    setBusy(true);
    setChangeFailure(null);
    try {
      if (await requestStepUp(connection)) setLoaded({ daemonId: connection.daemonId, view: await readGrants(client) });
    } catch (cause) {
      setChangeFailure(message(cause));
    } finally {
      setBusy(false);
    }
  }, [client, connection, loaded?.daemonId, requestStepUp]);

  if (loaded?.daemonId === connection.daemonId)
    return (
      <GrantsCard
        connection={connection}
        view={loaded.view}
        busy={busy}
        changeFailure={changeFailure}
        onChange={(capability, axis, next) => void change(capability, axis, next)}
        {...(requestStepUp === undefined ? {} : { onStepUp: () => void stepUp() })}
      />
    );
  if (loadFailure?.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Capability grants unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Capability limits unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
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
      <p className="m-0 text-cell leading-base text-muted">Reading what this machine allows a paired device to do…</p>
    </section>
  );
}
