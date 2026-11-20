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
 * ## A BROWSER ON THE MACHINE IS GOVERNED LIKE ANY OTHER
 *
 * Only the host's admin token over loopback — the CLI — is the owner at the machine, so a browser on
 * `127.0.0.1` reads the same limits, asks for the same passkey, and can switch things off but never back
 * on. The screen says so once, and widening is only ever offered as the command to run at the machine.
 *
 * ## THE PASSKEY IS OFFERED ONLY WHERE IT WOULD HELP
 *
 * A governed browser's dangerous acts need a passkey step-up. The carrier asks for it by itself when
 * the daemon refuses, so no press is ever blocked here; what this screen adds is the way to do it
 * BEFORE the press — one button, which is the app's single step-up prompt (`store.stepUp.require`),
 * never a second prompt of its own — and one plain sentence saying why a row reads "needs your passkey".
 * Nothing about a step-up is held here: the daemon remembers it, and the view says whether it does.
 */

import { CAPABILITY_AXES, CAPABILITY_NAMES, type CapabilityName } from '@ferretry/core-gate/contract';
import type { CapabilityAxis } from '@ferretry/kernel/contract';
import { SettingGroup, SettingRow } from '@ferretry/app';
import { CircleAlert, Fingerprint } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import type { CapabilityGrantView, GrantsView } from '../../../contract/index.ts';
import { type DaemonConnection, useDaemonClient, useStepUpRequest } from '../../shell-grants.ts';
import {
  axisGuidance,
  axisLabel,
  axisQuestion,
  capabilityLabel,
  capabilityReach,
  capabilityWeight,
  connectionPosture,
  deviceGrantNote,
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
import { CapabilityList, WeightMark } from './capability-list.tsx';
import { changeGrants, type GrantClient, readGrants } from './grants-api.ts';
import { Loading } from '@ferretry/app/ui';
import { AccessTab, LabelledSwitch, Notice, type NoticeTone, StateBlock } from './access-kit.tsx';

/** The tone each guidance level paints with, kept in one place so five rows cannot disagree. */
const TONE: Readonly<Record<GrantGuidance['tone'], NoticeTone>> = {
  ok: 'ok',
  disclosure: 'info',
  limit: 'warn',
  fault: 'err',
};

/**
 * One axis: what it is, whether it is on, and — when it is not changeable — why.
 *
 * THE REASON IS NEVER HOVER-ONLY. A person meeting a control they cannot move needs the reason at the same
 * moment, in the flow of the page: a refusal that is a fault is shown whole, and one that repeats on every row (a
 * passkey; fixed on the host) is a short visible badge, with its full sentence kept in the page for a screen reader (and
 * said once, in full, in the panels above the cards).
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
  readonly changeable: boolean;
  readonly oneWay: boolean;
  readonly busy: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  const recorded = entry.granted[axis];
  const deadWideningSwitch = oneWay && !recorded;
  const disabled = busy || !changeable || deadWideningSwitch;
  const reason = deadWideningSwitch
    ? {
        tone: 'limit' as const,
        badge: 'Only at the machine',
        explanation: grantOnlyAtMachine(entry.capability),
        offersStepUp: false,
      }
    : axisGuidance(entry, axis, changeable);
  const whole = !reason.offersStepUp && reason.tone === 'fault';
  // The sentence the short badge stands for is what the switch is described by (a screen reader hears it with the switch).
  const reasonId = useId();

  return (
    <div className="fy-acc-grant__axis">
      <span>
        <span className="text-ui font-semibold text-fg">{axisLabel(axis)}</span>
        <span className="fy-acc-grant__question">{axisQuestion(axis)}</span>
      </span>
      <LabelledSwitch
        label={axisLabel(axis)}
        showLabel={false}
        accessibleName={`${capabilityLabel(entry.capability)} — ${axisLabel(axis)}`}
        describedBy={reasonId}
        checked={recorded}
        disabled={disabled}
        onChange={onChange}
        marks={{
          'data-grant-axis': `${entry.capability}.${axis}`,
          'data-grant-axis-changeable': changeable ? 'yes' : 'no',
        }}
      />
      {/* The same few sentences repeat on every row (a passkey; fixed on the host; only at the machine), and the panels
          above already say them once: a row shows the short badge. A refusal that is a fault is the one row-specific thing,
          so it is shown whole. */}
      <Notice
        tone={TONE[reason.tone]}
        id={reasonId}
        className="fy-acc-grant__badge"
        marks={{ 'data-grant-axis-reason': `${entry.capability}.${axis}` }}
      >
        {whole ? (
          reason.explanation
        ) : (
          <>
            <span aria-hidden="true">{reason.badge}</span>
            <span className="sr-only">{reason.explanation}</span>
          </>
        )}
      </Notice>
    </div>
  );
}

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
  const changeable = grantChangeable(view, entry);
  const oneWay = !entry.mayGrant;
  const deviceNote = deviceGrantNote(entry);

  return (
    <li className="min-w-0" data-grant-capability={entry.capability} aria-labelledby={headingId}>
      <div className="fy-acc-grant">
        <div className="fy-acc-grant__head">
          <h4 id={headingId} className="fy-acc-grant__name m-0">
            {capabilityLabel(entry.capability)}
          </h4>
          <WeightMark weight={capabilityWeight(entry.capability)} />
          <span className="fy-acc-chip" data-tone="plain" data-grant-origin={entry.origin}>
            {entry.origin === 'config file' ? 'set by the operator' : 'product default'}
          </span>
        </div>
        <p className="fy-acc-fine">
          {capabilityReach(entry.capability)} {originNote(entry)}
        </p>
        {deviceNote === null ? null : (
          <Notice tone="warn" marks={{ 'data-grant-device-note': entry.capability }}>
            {deviceNote}
          </Notice>
        )}
        <div className="fy-acc-grant__axes">
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
        {/* THE ONE-WAY DOOR, said before anybody walks through it. A browser may switch this off
            and can never switch it back on, so the consequence belongs beside the switch rather than in
            a document read afterwards. It is shown while the capability is still ON, because that is the
            only moment the warning can change what somebody does. */}
        {oneWay && entry.granted.use ? (
          <details className="text-meta leading-base text-warn" data-grant-one-way={entry.capability}>
            <summary className="min-h-[44px] cursor-pointer py-3 leading-snug">
              Switching this off cannot be undone from here
            </summary>
            <Notice tone="warn">{remoteRevokeWarning(entry.capability)}</Notice>
          </details>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The passkey row: says whether this device has confirmed, and offers to.
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
    <SettingRow
      name={steppedUp ? 'Confirmed with your passkey' : 'Passkey confirmation'}
      hint={steppedUp ? 'Changes here go through.' : 'Needed before a change here.'}
      dataAttributes={{ 'data-grant-step-up': steppedUp ? 'held' : 'needed' }}
      control={() =>
        steppedUp || onStepUp === undefined ? (
          <Fingerprint size={16} className="text-accent" aria-hidden="true" />
        ) : (
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
        )
      }
    >
      <div className="fy-acc-body">
        <p className="fy-acc-fine">{STEP_UP_NOTE}</p>
      </div>
    </SettingRow>
  );
}

export interface GrantsCardProps {
  readonly connection: DaemonConnection;
  readonly view: GrantsView;
  readonly busy?: boolean;
  /** A refusal the daemon answered a change with, rendered whole. */
  readonly changeFailure?: string | null;
  readonly onChange: (capability: CapabilityName, axis: CapabilityAxis, next: boolean) => void;
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
  const entries = CAPABILITY_NAMES.map(capability =>
    view.capabilities.find(candidate => candidate.capability === capability),
  ).filter((entry): entry is CapabilityGrantView => entry !== undefined);
  const posture = connectionPosture(view.governed);

  return (
    <AccessTab name="grants">
      <div data-grant-surface={String(connection.daemonId)}>
        {/* READING BEFORE CHANGING. The list answers "what may this browser do here, why, and how much
            does each one hand over"; the switches below answer "change it". `governed` is PASSED rather than
            inferred: it is the DAEMON's account of the connection, and it is never inferred from this page's
            address, which would invert the answer over a relay. */}
        <CapabilityList
          connection={connection}
          capabilities={view.capabilities}
          governed={view.governed}
          rows={false}
        />
        <SettingGroup label="What a paired device may do">
          {/* The line that stops the commonest wrong reading of this whole screen, BRANCHED because one sentence
              cannot be true for every connection. */}
          <SettingRow
            name="Who these switches cover"
            dataAttributes={{ 'data-grant-scope': grantScopeKey(posture) }}
            control={() =>
              view.governed ? (
                <span
                  className="fy-acc-chip"
                  data-tone={view.steppedUp ? 'ok' : 'plain'}
                  data-grant-stepped-up={view.steppedUp ? 'yes' : 'no'}
                >
                  {view.steppedUp ? 'passkey confirmed' : 'passkey not confirmed yet'}
                </span>
              ) : null
            }
          >
            <div className="fy-acc-body">
              <p className="fy-acc-fine">{grantScopeNote(posture)}</p>
            </div>
          </SettingRow>
          {/* The passkey, for a caller the limits govern. */}
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
        </SettingGroup>
        {changeFailure === null ? null : (
          // The daemon's own sentence, whole. It already names the command a human runs, composed by the layer that
          // knows what this product's client is called.
          <Notice tone="err" role="alert" icon={<CircleAlert size={14} />} marks={{ 'data-grant-change-failure': '' }}>
            {changeFailure}
          </Notice>
        )}
      </div>
    </AccessTab>
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
    async (capability: CapabilityName, axis: CapabilityAxis, next: boolean) => {
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
      <StateBlock title="Capability limits unavailable" label="Capability grants unavailable">
        <p className="fy-acc-fine">
          This daemon did not say what a paired device may do on it, so Ferretry will not show a limit or claim there is
          none. Nothing here is evidence that this machine is unrestricted.
        </p>
        {/* The daemon's own words, on their own line rather than run into the sentence above: they are
            a message from somewhere else, and appending one mid-paragraph reads as a typo. */}
        <p className="fy-acc-fine fy-acc-faint" data-grant-load-failure="">
          {loadFailure.reason}
        </p>
      </StateBlock>
    );
  return <Loading kind="page" label="Reading what this machine allows a paired device to do…" />;
}
