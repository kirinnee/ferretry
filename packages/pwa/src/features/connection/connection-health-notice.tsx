/**
 * "RECONNECTING…" — ONE CALM LINE FOR A LOST CARRIER, AND A PLAIN BANNER IF IT LASTS.
 *
 * A dropped relay socket used to paint the carrier walk's whole sentence on every panel that noticed it:
 * the transcript, the session, then the composer, in yellow and red. The fact is one per machine
 * (`connection-health.ts`), so it is said once, here, as an overlay over the top chrome on every page:
 *
 * - nothing for the first {@link RECONNECTING_GRACE_MS}: a blip the loop recovers from is not news;
 * - while the reconnect loop works, a small pill — a spinner and "Reconnecting…", the attempt count once
 *   there has been a retry — that opens the details sheet;
 * - after {@link CONNECTION_STALL_MS} it becomes a banner: one heading naming the likely cause, one
 *   sentence saying what to do, and Retry now / Details;
 * - nothing at all while connected, or before anything was measured.
 *
 * The technical text lives in the sheet only, one line per carrier. What the page already shows stays on
 * screen — stale, not blank — because nothing here replaces it.
 *
 * WHY HERE AND NOT IN THE APP BAR: the app bar is drawn on a phone's non-session pages only. A desktop
 * has none, and a phone's session page carries the session's own header, which is exactly where the
 * outage that prompted this was seen. The shell mounts this once in its content column instead.
 *
 * IT NEVER MOVES THE PAGE. Connection status is an OVERLAY: the live region is `position: fixed` at the
 * top of the window, below the status-bar inset, and takes no pointer events except on the pill or banner
 * itself. It once was a block in the column, so an outage pushed the app bar, the header and the whole
 * transcript down and the recovery pulled them back up — a reflow under the reader's thumb.
 */

import { CircleAlert, CloudOff, PowerOff, RefreshCw, WifiOff } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import { useConnectionHealth } from '../../hooks/use-connection-health.ts';
import { useLiveClock } from '../../hooks/use-live-clock.ts';
import {
  type ConnectionHealth,
  type ConnectionHealthState,
  type LikelyCause,
  RECONNECTING_GRACE_MS,
} from '../../lib/connection-health.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import {
  carrierLines,
  DETAILS_COPY,
  outageDuration,
  pillDetail,
  RECONNECTING_LABEL,
  STALL_ACTIONS,
  stallCopy,
} from './connection-copy.ts';

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

const CAUSE_ICON: Readonly<Record<LikelyCause, ReactNode>> = {
  'device-offline': <WifiOff size={16} aria-hidden="true" className="mt-0.5 shrink-0" />,
  'daemon-unreachable': <PowerOff size={16} aria-hidden="true" className="mt-0.5 shrink-0" />,
  'relay-unreachable': <CloudOff size={16} aria-hidden="true" className="mt-0.5 shrink-0" />,
  unknown: <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />,
};

interface ConnectionPillProps {
  readonly state: Reconnecting;
  readonly now: number;
  readonly sheetId: string;
  readonly sheetOpen: boolean;
  readonly onOpen: () => void;
}

/**
 * The small one-line pill — a real `kt-btn`, so its corners and stroke are the theme's control shape;
 * under reduced motion the spinner pulses instead of turning.
 */
function ConnectionPill({ state, now, sheetId, sheetOpen, onOpen }: ConnectionPillProps) {
  const detail = pillDetail(state, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={sheetOpen}
      aria-controls={sheetId}
      title="Show connection details"
      data-connection-pill=""
      className="kt-btn kt-btn--sm pointer-events-auto min-h-control max-w-full items-center gap-xs bg-surface text-muted shadow-panel"
    >
      <Spinner size={13} />
      <span className="truncate text-fg">{RECONNECTING_LABEL}</span>
      {detail === null ? null : (
        <span className="hidden truncate text-meta min-[480px]:inline" data-connection-pill-detail="">
          · {detail}
        </span>
      )}
    </button>
  );
}

interface ConnectionStallBannerProps {
  readonly state: Reconnecting;
  readonly machineName: string;
  readonly sheetId: string;
  readonly sheetOpen: boolean;
  readonly onRetryNow: () => void;
  readonly onDetails: () => void;
}

/** The 30-second banner: a heading, one sentence, two actions. Never the walk's text. */
function ConnectionStallBanner({
  state,
  machineName,
  sheetId,
  sheetOpen,
  onRetryNow,
  onDetails,
}: ConnectionStallBannerProps) {
  const copy = stallCopy(state.cause, machineName);
  return (
    <div
      data-connection-stall={state.cause}
      className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-warn-border bg-surface px-3 py-2 text-ui leading-base text-warn shadow-popover"
    >
      <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-2">
        {CAUSE_ICON[state.cause]}
        <div className="min-w-0">
          <p className="m-0 font-semibold">{copy.heading}</p>
          <p className="m-0 text-fg">{copy.advice}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className="kt-btn min-h-control" onClick={onRetryNow} data-connection-retry="">
          <RefreshCw size={14} aria-hidden="true" />
          {STALL_ACTIONS.retryNow}
        </button>
        <button
          type="button"
          className="kt-btn min-h-control"
          data-variant="ghost"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-controls={sheetId}
          onClick={onDetails}
          data-connection-details=""
        >
          {STALL_ACTIONS.details}
        </button>
      </div>
    </div>
  );
}

export interface ConnectionDetailsSheetProps {
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: ConnectionHealthState;
  readonly machineName: string;
  readonly now: number;
  readonly onRetryNow: () => void;
}

/**
 * What is going on, for the reader who asked: the plain state, how long, how many attempts, Retry now,
 * and what each carrier said — once per carrier, never once per panel. The daemon's fingerprint never
 * appears; the carrier sentences already leave it out and nothing here adds it.
 */
export function ConnectionDetailsSheet({
  id,
  open,
  onClose,
  state,
  machineName,
  now,
  onRetryNow,
}: ConnectionDetailsSheetProps) {
  const titleId = `${id}-title`;
  return (
    <BottomSheet
      id={id}
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel={DETAILS_COPY.close}
      panelClassName="px-panel pb-panel"
    >
      <div className="flex min-w-0 flex-col gap-3 pb-md text-ui leading-base text-fg" data-connection-sheet="">
        <h2 id={titleId} className="m-0 text-title font-semibold">
          {DETAILS_COPY.title}
        </h2>
        {state.kind === 'reconnecting' ? (
          <>
            <p className="m-0">{DETAILS_COPY.reconnecting(machineName)}</p>
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
              <section aria-labelledby={`${id}-technical`} className="flex min-w-0 flex-col gap-1">
                <h3 id={`${id}-technical`} className="m-0 text-meta font-semibold text-muted">
                  {DETAILS_COPY.technical}
                </h3>
                <dl className="m-0 flex min-w-0 flex-col gap-2">
                  {carrierLines(state.failures).map(failure => (
                    <div key={failure.label} className="min-w-0" data-connection-carrier={failure.label}>
                      <dt className="font-semibold">{failure.label}</dt>
                      <dd className="m-0 break-words font-mono text-meta text-muted">{failure.detail}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </>
        ) : (
          <p className="m-0">{DETAILS_COPY.connected(machineName)}</p>
        )}
      </div>
    </BottomSheet>
  );
}

export interface ConnectionHealthNoticeViewProps {
  readonly state: ConnectionHealthState;
  readonly machineName: string;
  readonly now: number;
  readonly onRetryNow: () => void;
}

/**
 * The pill, the banner and the sheet for one machine, from its state alone — no store, so a test mounts
 * it with a literal. The sheet stays mounted after recovery so an open sheet can say "Connected" rather
 * than vanishing under the reader's thumb.
 */
export function ConnectionHealthNoticeView({ state, machineName, now, onRetryNow }: ConnectionHealthNoticeViewProps) {
  const sheetId = useId();
  const [open, setOpen] = useState(false);
  const show = (): void => setOpen(true);
  return (
    <>
      {/* ONE live region that outlives the pill: it is polite, and it is there before the words are. */}
      <div
        role="status"
        aria-live="polite"
        data-connection-health={state.kind}
        className="pointer-events-none fixed inset-x-0 top-[calc(var(--inset-top,0px)+0.5rem)] z-[56] flex justify-center px-4"
      >
        {state.kind !== 'reconnecting' || (!state.stalled && now - state.since < RECONNECTING_GRACE_MS) ? null : (
          <div className="flex min-w-0 max-w-full justify-center" data-kb-hide="">
            {state.stalled ? (
              <div className="w-full max-w-[40rem]">
                <ConnectionStallBanner
                  state={state}
                  machineName={machineName}
                  sheetId={sheetId}
                  sheetOpen={open}
                  onRetryNow={onRetryNow}
                  onDetails={show}
                />
              </div>
            ) : (
              <ConnectionPill state={state} now={now} sheetId={sheetId} sheetOpen={open} onOpen={show} />
            )}
          </div>
        )}
      </div>
      <ConnectionDetailsSheet
        id={sheetId}
        open={open}
        onClose={() => setOpen(false)}
        state={state}
        machineName={machineName}
        now={now}
        onRetryNow={onRetryNow}
      />
    </>
  );
}

export interface ConnectionHealthNoticeProps {
  readonly health: ConnectionHealth;
  readonly daemonId: DaemonId;
  readonly machineName: string;
  /** Injectable so a test drives the countdown instead of waiting on the wall. */
  readonly now?: () => number;
}

/**
 * The shell's one mount: reads the machine's health, and keeps its clock running ONLY while there is a
 * countdown or a duration to show — a connected app holds the clock, so it sets no timer at all.
 */
export function ConnectionHealthNotice({ health, daemonId, machineName, now = Date.now }: ConnectionHealthNoticeProps) {
  const state = useConnectionHealth(health, daemonId);
  const clock = useLiveClock({ now, hold: state.kind !== 'reconnecting' });
  return (
    <ConnectionHealthNoticeView
      state={state}
      machineName={machineName}
      now={clock}
      onRetryNow={() => health.retryNow(daemonId)}
    />
  );
}
