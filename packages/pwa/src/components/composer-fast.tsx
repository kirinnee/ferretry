/**
 * The FAST MODE toggle on the chat bar, beside the model and reasoning chips.
 *
 * A small ⚡ "fast" button (`aria-pressed`) that switches the harness's own fast mode on a RUNNING
 * session. It follows the rules the other two chips already keep:
 *
 *   - The daemon types the CLI's command at an idle prompt and the readout stays on the last value
 *     the harness REPORTED, marked "switching…", until the harness reports a change — and after a
 *     bounded wait says "unconfirmed" instead of promising forever (the same bookkeeping as the
 *     model chip, from `composer-runtime.tsx`).
 *   - Before the harness has said anything the toggle shows what the session was LAUNCHED with.
 *   - It is disabled — with the reason carried non-visually — on a read-only origin, a finished or a
 *     busy session, and a model the daemon's catalog says has no fast mode. Only an explicit "no"
 *     disables it for the model: a catalog that is slow, failed or silent never takes the control away.
 *   - The cost note ("Fast mode can cost more.") is said once per browser, the first time the mode is
 *     turned on from here. No dialog, no confirmation.
 */

import type { SessionView } from '@ferretry/protocol';
import { useCallback, useEffect, useId, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionScope } from '../lib/daemon-scope.ts';
import {
  FAST_COST_NOTE,
  fastCostNoteSeen,
  fastModeInForce,
  fastModeUnsupportedReason,
  markFastCostNoteSeen,
} from '../lib/fast-mode.ts';
import type { RuntimeModelCatalog } from '../lib/runtime-models.ts';
import { isTerminalSessionStatus } from '../lib/session-screens.ts';
import { RUNTIME_SWITCH_CONFIRM_MS, runtimeSwitchDisabledReason, useSwitchConfirmation } from './composer-runtime.tsx';
import { FastSwitch, type FastSwitchMark } from './fast-switch.tsx';
import {
  isEffortActionUnsupported,
  isPromptKnownBusy,
  isRuntimeEndpointUnavailable,
  type RuntimeControlApi,
  type RuntimeModelCatalogSource,
  runtimeModelInForce,
} from './runtime-controls.tsx';

/** How long the cost note stays beside the toggle after the first time it is turned on. */
export const FAST_COST_NOTE_MS = 6_000;

export interface FastObservation {
  readonly fast?: boolean;
  readonly observedAt?: string;
}

/** A switch is confirmed by ANY change to the observed fact, including a re-report with a new timestamp. */
export const fastObservationChanged = (before: FastObservation, current: FastObservation): boolean =>
  before.fast !== current.fast || before.observedAt !== current.observedAt;

export interface FastToggleProps {
  readonly view: SessionView;
  /** A token-less origin is read-only and cannot send a runtime command. */
  readonly canControl: boolean;
  /** The session is mid-turn: a switch needs an idle prompt. */
  readonly busy: boolean;
  readonly api: RuntimeControlApi;
  readonly catalogs: RuntimeModelCatalogSource;
  readonly daemon: DaemonConnection;
  readonly switchConfirmMs?: number;
  readonly newRequestId?: () => string;
}

const defaultRequestId = (): string => crypto.randomUUID();

/** The model catalog for one session, or nothing while it loads or when it cannot be read. */
function useSessionCatalog(
  catalogs: RuntimeModelCatalogSource,
  daemon: DaemonConnection,
  sessionId: string,
  enabled: boolean,
): RuntimeModelCatalog | null {
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly catalog: RuntimeModelCatalog } | null>(null);
  const key = `${daemon.daemonId}\0${sessionId}`;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    catalogs
      .load(daemon, daemonSessionScope(daemon, sessionId))
      .then(catalog => {
        if (!cancelled) setLoaded({ key, catalog });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalogs, daemon, enabled, key, sessionId]);
  return loaded?.key === key ? loaded.catalog : null;
}

export function FastToggle({
  view,
  canControl,
  busy,
  api,
  catalogs,
  daemon,
  switchConfirmMs = RUNTIME_SWITCH_CONFIRM_MS,
  newRequestId = defaultRequestId,
}: FastToggleProps) {
  const { config, state } = view;
  const reasonId = useId();
  const terminal = isTerminalSessionStatus(state.status);
  const catalog = useSessionCatalog(catalogs, daemon, config.id, canControl && !terminal);
  const confirmation = useSwitchConfirmation<FastObservation>(
    { fast: state.observedFast, observedAt: state.observedModelAt },
    fastObservationChanged,
    config.id,
    busy,
    terminal,
    switchConfirmMs,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState(false);

  // A different session is a different runtime: nothing here carries across one.
  const [sessionAtReset, setSessionAtReset] = useState(config.id);
  if (sessionAtReset !== config.id) {
    setSessionAtReset(config.id);
    setFailed(null);
    setNote(false);
  }

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(false), FAST_COST_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  const unsupported = fastModeUnsupportedReason(catalog, runtimeModelInForce(view));
  const disabledReason =
    runtimeSwitchDisabledReason(canControl, terminal, busy || isPromptKnownBusy(state)) ?? unsupported;
  const pressed = fastModeInForce(view, catalog);

  const press = useCallback(async () => {
    const next = !pressed;
    setFailed(null);
    confirmation.mark();
    try {
      await api.runtime(daemon, config.id, { action: 'fast', fast: next }, newRequestId());
      if (next && !fastCostNoteSeen()) {
        markFastCostNoteSeen();
        setNote(true);
      }
    } catch (cause) {
      confirmation.clear();
      setFailed(
        isRuntimeEndpointUnavailable(cause) || isEffortActionUnsupported(cause)
          ? 'The running daemon is older than this web UI and cannot switch fast mode.'
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  }, [api, confirmation, config.id, daemon, newRequestId, pressed]);

  const mark: FastSwitchMark | undefined =
    failed !== null
      ? 'failed'
      : confirmation.state === 'settled'
        ? undefined
        : confirmation.state === 'pending'
          ? 'switching'
          : 'unconfirmed';

  return (
    <span className="relative inline-flex shrink-0">
      <FastSwitch
        ariaLabel={`Fast mode — currently ${pressed ? 'on' : 'off'}`}
        disabled={disabledReason !== undefined}
        {...(disabledReason === undefined ? {} : { disabledReason })}
        {...(mark === undefined ? {} : { mark })}
        onPress={() => void press()}
        pressed={pressed}
        reasonId={reasonId}
        {...(failed === null ? {} : { detail: failed })}
      />
      {disabledReason ? (
        <span className="sr-only" id={reasonId}>
          {disabledReason}
        </span>
      ) : null}
      {/* A callout above the chip rather than text in the row: on a phone the row has no room, and a note
          in it squeezed the model and reasoning chips down to a few letters. */}
      <span
        aria-live="polite"
        className={
          note
            ? 'fy-composer__fast-note pointer-events-none absolute right-0 bottom-full z-40 mb-1 whitespace-nowrap rounded-control border border-border-soft bg-surface px-2 py-1 text-meta text-fg-soft shadow-popover'
            : 'sr-only'
        }
        role="status"
      >
        {note ? FAST_COST_NOTE : (failed ?? '')}
      </span>
    </span>
  );
}
