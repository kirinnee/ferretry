/**
 * "RECONNECTING…" — ONE SMALL, DISMISSIBLE LINE FOR EVERY MACHINE THAT IS NOT ANSWERING.
 *
 * A dropped relay socket used to paint the carrier walk's whole sentence on every panel that noticed it.
 * The fact is one per machine (`connection-health.ts`), so it is said once, here, as an overlay over the
 * top chrome on every page:
 *
 * - nothing for the first {@link RECONNECTING_GRACE_MS}: a blip the loop recovers from is not news;
 * - while one machine's reconnect loop works, a small pill — a spinner and "Reconnecting…", the attempt
 *   count once there has been a retry;
 * - once that machine has stalled, the same pill says "Liftoff MBP offline"; with more than one machine
 *   down, "2 machines offline";
 * - nothing at all while every machine is connected, or before anything was measured.
 *
 * The pill opens the details sheet — per machine: why, what to do, Retry now, and what each carrier said
 * — and its × hides it until another machine goes down. The technical text lives in the sheet only.
 *
 * NEVER A BANNER OVER THE PAGE. After 30 seconds this used to become a card pinned over the top of the
 * window, and on a phone with two machines paired and one asleep it covered the page's header and its
 * "+ New" while the healthy machine sat underneath. A machine's outage is said IN PLACE — its heading in
 * the Sessions list, its own page's status row (`components/machine-status.tsx`) — and this stays the
 * one compact pill, the same size whatever the outage's age.
 *
 * IT NEVER MOVES THE PAGE. Connection status is an OVERLAY: the live region is `position: fixed` at the
 * top of the window, below the status-bar inset, and takes no pointer events except on the pill itself.
 * It once was a block in the column, so an outage pushed the app bar, the header and the whole
 * transcript down and the recovery pulled them back up — a reflow under the reader's thumb (#725).
 */

import { CloudOff, RefreshCw, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import { useLiveClock } from '../../hooks/use-live-clock.ts';
import { useHealthStates } from '../../hooks/use-machine-sources.ts';
import {
  type ConnectionHealth,
  type ConnectionHealthState,
  RECONNECTING_GRACE_MS,
} from '../../lib/connection-health.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import {
  carrierLines,
  DETAILS_COPY,
  offlineLabel,
  outageDuration,
  pillDetail,
  RECONNECTING_LABEL,
  stallCopy,
} from './connection-copy.ts';

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

/** One paired machine, its name and its health fact. */
export interface NoticeMachine {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly state: ConnectionHealthState;
}

type Down = NoticeMachine & { readonly state: Reconnecting };

const isDown = (machine: NoticeMachine): machine is Down => machine.state.kind === 'reconnecting';

/** Down long enough to say: past the grace, or already stalled. */
const isSaid = (machine: Down, now: number): boolean =>
  machine.state.stalled || now - machine.state.since >= RECONNECTING_GRACE_MS;

interface ConnectionPillProps {
  readonly down: readonly Down[];
  readonly now: number;
  readonly sheetId: string;
  readonly sheetOpen: boolean;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
}

/**
 * The one compact pill — a real `kt-btn`, so its corners and stroke are the theme's control shape — and
 * its ×. While one machine is still being retried it spins; once a machine is offline it says so.
 */
function ConnectionPill({ down, now, sheetId, sheetOpen, onOpen, onDismiss }: ConnectionPillProps) {
  const only = down.length === 1 ? (down[0] as Down) : null;
  const retrying = only !== null && !only.state.stalled;
  const detail = retrying ? pillDetail(only.state, now) : null;
  const label = retrying ? RECONNECTING_LABEL : offlineLabel(down.map(machine => machine.name));
  return (
    <div className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-control bg-surface shadow-panel">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-controls={sheetId}
        title="Show connection details"
        data-connection-pill={retrying ? 'reconnecting' : 'offline'}
        className="kt-btn kt-btn--sm min-h-control max-w-full items-center gap-xs bg-surface text-muted"
      >
        {retrying ? <Spinner size={13} /> : <CloudOff size={13} aria-hidden="true" className="shrink-0 text-warn" />}
        <span className="truncate text-fg">{label}</span>
        {detail === null ? null : (
          <span className="hidden truncate text-meta min-[480px]:inline" data-connection-pill-detail="">
            · {detail}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss connection notice"
        title="Hide until another machine goes offline"
        data-connection-dismiss=""
        className="kt-btn kt-btn--sm min-h-control items-center justify-center bg-surface px-xs text-muted"
        data-variant="ghost"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

export interface ConnectionDetailsSheetProps {
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly machines: readonly NoticeMachine[];
  readonly now: number;
  readonly onRetryNow: (daemonId: DaemonId) => void;
}

/** One machine that is down, in the sheet: why, what to do, how long, Retry now, what each carrier said. */
function DownMachineDetails({
  id,
  machine,
  now,
  onRetryNow,
}: {
  readonly id: string;
  readonly machine: Down;
  readonly now: number;
  readonly onRetryNow: () => void;
}) {
  const { state } = machine;
  const copy = stallCopy(state.cause, machine.name);
  return (
    <section
      aria-labelledby={`${id}-name`}
      className="flex min-w-0 flex-col gap-2"
      data-connection-machine={String(machine.daemonId)}
    >
      <h3 id={`${id}-name`} className="m-0 text-ui font-semibold">
        {machine.name}
      </h3>
      <p className="m-0" data-connection-cause={state.cause}>
        <span className="font-semibold">{copy.heading}.</span> {copy.advice}
      </p>
      <p className="m-0 text-meta text-muted">{DETAILS_COPY.reconnecting(machine.name)}</p>
      <p className="m-0 text-meta text-muted" data-connection-meta="">
        {DETAILS_COPY.lostFor(outageDuration(state.since, now))} · {DETAILS_COPY.attempts(state.attempt)}
      </p>
      <div>
        <button type="button" className="kt-btn min-h-control" onClick={onRetryNow} data-connection-retry="">
          <RefreshCw size={14} aria-hidden="true" />
          {DETAILS_COPY.retryNow}
        </button>
      </div>
      {state.failures.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <h4 className="m-0 text-meta font-semibold text-muted">{DETAILS_COPY.technical}</h4>
          <dl className="m-0 flex min-w-0 flex-col gap-2">
            {carrierLines(state.failures).map(failure => (
              <div key={failure.label} className="min-w-0" data-connection-carrier={failure.label}>
                <dt className="font-semibold">{failure.label}</dt>
                <dd className="m-0 break-words font-mono text-meta text-muted">{failure.detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

/**
 * What is going on, for the reader who asked: each machine that is down, in its own section, once per
 * carrier and never once per panel. A machine that recovered while the sheet is open drops out, and once
 * none is left the sheet says everything is connected rather than vanishing under the reader's thumb.
 * The daemon's fingerprint never appears; the carrier sentences already leave it out and nothing adds it.
 */
export function ConnectionDetailsSheet({ id, open, onClose, machines, now, onRetryNow }: ConnectionDetailsSheetProps) {
  const titleId = `${id}-title`;
  const down = machines.filter(isDown);
  return (
    <BottomSheet
      id={id}
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel={DETAILS_COPY.close}
      panelClassName="px-panel pb-panel"
    >
      <div className="flex min-w-0 flex-col gap-4 pb-md text-ui leading-base text-fg" data-connection-sheet="">
        <h2 id={titleId} className="m-0 text-title font-semibold">
          {DETAILS_COPY.title}
        </h2>
        {down.length === 0 ? (
          <p className="m-0">{DETAILS_COPY.connected(machines.map(machine => machine.name))}</p>
        ) : (
          down.map((machine, index) => (
            <DownMachineDetails
              key={String(machine.daemonId)}
              id={`${id}-${index}`}
              machine={machine}
              now={now}
              onRetryNow={() => onRetryNow(machine.daemonId)}
            />
          ))
        )}
      </div>
    </BottomSheet>
  );
}

export interface ConnectionHealthNoticeViewProps {
  /** Every paired machine, in display order, with its health fact. */
  readonly machines: readonly NoticeMachine[];
  readonly now: number;
  readonly onRetryNow: (daemonId: DaemonId) => void;
}

/**
 * The pill and the sheet, from the machines' states alone — no store, so a test mounts it with literals.
 * The sheet stays mounted after recovery so an open sheet can say "Connected" rather than vanishing.
 */
export function ConnectionHealthNoticeView({ machines, now, onRetryNow }: ConnectionHealthNoticeViewProps) {
  const sheetId = useId();
  const [open, setOpen] = useState(false);
  // The machines whose outage the reader hid. A machine leaves the set when it recovers, so its NEXT
  // outage is said again; a machine that was not in it when it went down shows the pill again.
  const [dismissed, setDismissed] = useState<ReadonlySet<DaemonId>>(() => new Set());
  const down = machines.filter(isDown);
  const said = down.filter(machine => isSaid(machine, now));
  const downKey = down.map(machine => String(machine.daemonId)).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined ids are the deliberate key
  useEffect(() => {
    setDismissed(previous => {
      const kept = [...previous].filter(id => down.some(machine => machine.daemonId === id));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  }, [downKey]);
  const visible = said.some(machine => !dismissed.has(machine.daemonId));
  return (
    <>
      {/* ONE live region that outlives the pill: it is polite, and it is there before the words are. */}
      <div
        role="status"
        aria-live="polite"
        data-connection-health={said.length === 0 ? (down.length === 0 ? 'connected' : 'reconnecting') : 'offline'}
        className="pointer-events-none fixed inset-x-0 top-[calc(var(--inset-top,0px)+0.5rem)] z-[56] flex justify-center px-4"
      >
        {visible ? (
          <div className="flex min-w-0 max-w-full justify-center" data-kb-hide="">
            <ConnectionPill
              down={said}
              now={now}
              sheetId={sheetId}
              sheetOpen={open}
              onOpen={() => setOpen(true)}
              onDismiss={() => setDismissed(new Set(said.map(machine => machine.daemonId)))}
            />
          </div>
        ) : null}
      </div>
      <ConnectionDetailsSheet
        id={sheetId}
        open={open}
        onClose={() => setOpen(false)}
        machines={machines}
        now={now}
        onRetryNow={onRetryNow}
      />
    </>
  );
}

export interface ConnectionHealthNoticeProps {
  readonly health: ConnectionHealth;
  /** Every paired machine and the name the reader knows it by, in display order. */
  readonly machines: readonly { readonly daemonId: DaemonId; readonly name: string }[];
  /** Injectable so a test drives the countdown instead of waiting on the wall. */
  readonly now?: () => number;
}

/**
 * The shell's one mount: reads every machine's health, and keeps its clock running ONLY while there is a
 * countdown or a duration to show — an app with every machine connected holds the clock and sets no timer.
 */
export function ConnectionHealthNotice({ health, machines, now = Date.now }: ConnectionHealthNoticeProps) {
  const states = useHealthStates(
    health,
    machines.map(machine => machine.daemonId),
  );
  const clock = useLiveClock({ now, hold: !states.some(state => state.kind === 'reconnecting') });
  const listed = machines.map((machine, index) => ({ ...machine, state: states[index] ?? UNMEASURED }));
  return <ConnectionHealthNoticeView machines={listed} now={clock} onRetryNow={id => health.retryNow(id)} />;
}

const UNMEASURED: ConnectionHealthState = { kind: 'unknown' };
