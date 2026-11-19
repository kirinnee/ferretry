/**
 * The connect flow as one small state machine: idle → consent → starting → waiting → done | expired | denied | error.
 *
 * The page polls the daemon's flow route; the daemon answers a poll that comes too early with `pending` without asking
 * GitHub, so this never hammers the provider. A hidden tab stops polling and takes one poll when it is back. When the
 * code's own clock runs out the page stops waiting at that instant (its own timer, not the next poll), since GitHub
 * would refuse that code anyway.
 *
 * A POLL THE DAEMON REFUSES FOR WANT OF THE PASSKEY STEP-UP DOES NOT END THE FLOW. With a per-action confirmation the
 * start spends the proof and the next unattended poll is refused; the code on screen is still good, so it stays, the
 * automatic polling stops, and the page offers one button. Pressing it is the person's act: the step-up runs then, and
 * polling resumes on the SAME flow. Nothing opens a passkey dialog without a press.
 */
import { isStepUpRefusal, useDocumentVisible } from '@ferretry/app/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitDeviceFlow, GitDeviceFlowStatus } from '../../../contract/index.ts';
import { pollFlow, startFlow } from '../../lib/accounts-api.ts';
import { explainFailure, remainingMs } from '../../lib/connect-state.ts';
import type { GitAccountsClient } from '../../shell.tsx';

export interface WaitingState {
  readonly step: 'waiting';
  readonly flow: GitDeviceFlow;
  readonly interval: number;
  readonly slow: boolean;
  /** The daemon wants the passkey before it will answer a poll: polling is paused until the person presses. */
  readonly needsStepUp: boolean;
}

export type ConnectState =
  | { readonly step: 'idle' }
  | { readonly step: 'consent' }
  | { readonly step: 'starting' }
  | WaitingState
  | { readonly step: 'done'; readonly login: string }
  | { readonly step: 'expired' }
  | { readonly step: 'denied' }
  | { readonly step: 'error'; readonly message: string };

export interface DeviceFlowOptions {
  readonly client: GitAccountsClient;
  /** Called once when GitHub has approved the code and the daemon holds the account. */
  readonly onConnected: () => void;
  /** Milliseconds to wait before the next poll, from the seconds the daemon asked for. Tests shorten it. */
  readonly pollDelay?: (seconds: number) => number;
  /** The clock. Tests and screenshots pin it. */
  readonly now?: () => number;
}

const SECOND = 1000;

export function useDeviceFlow({ client, onConnected, pollDelay = s => s * SECOND, now = Date.now }: DeviceFlowOptions) {
  const [state, setState] = useState<ConnectState>({ step: 'idle' });
  const visible = useDocumentVisible();
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const clock = useRef(now);
  clock.current = now;
  const latest = useRef(state);
  latest.current = state;

  /** What an answer to a poll does to the page, shared by the timer's poll and the person's press. */
  const settle = useCallback((flow: GitDeviceFlow, status: GitDeviceFlowStatus) => {
    if (status.status === 'done') {
      setState({ step: 'done', login: status.login });
      connected.current();
    } else if (status.status === 'expired') setState({ step: 'expired' });
    else if (status.status === 'denied') setState({ step: 'denied' });
    else
      setState({
        step: 'waiting',
        flow,
        interval: status.interval,
        slow: status.status === 'slow_down',
        needsStepUp: false,
      });
  }, []);

  const waiting = state.step === 'waiting' ? state : null;
  const flowId = waiting?.flow.flowId;
  const expiresAt = waiting?.flow.expiresAt;

  // The code's own clock: when it runs out the code goes, even if the next poll is minutes away (or paused for a press).
  useEffect(() => {
    if (flowId === undefined || expiresAt === undefined) return undefined;
    const timer = setTimeout(() => setState({ step: 'expired' }), remainingMs(expiresAt, clock.current()));
    return () => clearTimeout(timer);
  }, [flowId, expiresAt]);

  useEffect(() => {
    if (waiting === null || waiting.needsStepUp || !visible) return undefined;
    const { flow, interval } = waiting;
    let live = true;
    const timer = setTimeout(() => {
      if (remainingMs(flow.expiresAt, clock.current()) === 0) {
        setState({ step: 'expired' });
        return;
      }
      void pollFlow(client, flow.flowId).then(
        status => {
          if (live) settle(flow, status);
        },
        cause => {
          if (!live) return;
          if (isStepUpRefusal(cause))
            setState({ step: 'waiting', flow, interval, slow: waiting.slow, needsStepUp: true });
          else setState({ step: 'error', message: explainFailure(cause) });
        },
      );
    }, pollDelay(interval));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waiting, visible, client, pollDelay, settle]);

  const ask = useCallback(() => setState({ step: 'consent' }), []);
  const cancel = useCallback(() => setState({ step: 'idle' }), []);
  const proceed = useCallback(async () => {
    setState({ step: 'starting' });
    try {
      const flow = await startFlow(client);
      setState({ step: 'waiting', flow, interval: flow.interval, slow: false, needsStepUp: false });
    } catch (cause) {
      setState({ step: 'error', message: explainFailure(cause) });
    }
  }, [client]);

  /** The person's press: runs the step-up with one pressed poll of the SAME flow, then carries on from its answer. */
  const confirmStepUp = useCallback(
    async ({ flow, interval, slow }: WaitingState) => {
      const stillThis = () => {
        const now = latest.current;
        return now.step === 'waiting' && now.flow === flow;
      };
      try {
        const status = await pollFlow(client, flow.flowId, true);
        if (stillThis()) settle(flow, status);
      } catch (cause) {
        if (!stillThis()) return;
        // A cancelled prompt leaves the code and the button exactly where they were.
        if (isStepUpRefusal(cause)) setState({ step: 'waiting', flow, interval, slow, needsStepUp: true });
        else setState({ step: 'error', message: explainFailure(cause) });
      }
    },
    [client, settle],
  );

  return { state, ask, cancel, proceed, confirmStepUp };
}
