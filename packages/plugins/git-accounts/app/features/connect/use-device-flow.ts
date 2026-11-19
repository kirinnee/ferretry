/**
 * The connect flow as one small state machine: idle → consent → starting → waiting → done | expired | denied | error.
 *
 * The page polls the daemon's flow route; the daemon answers a poll that comes too early with `pending` without asking
 * GitHub, so this never hammers the provider. A hidden tab stops polling and takes one poll when it is back. When the
 * code's own clock runs out the page stops waiting, since GitHub would refuse that code anyway.
 */
import { useDocumentVisible } from '@ferretry/app/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitDeviceFlow } from '../../../contract/index.ts';
import { pollFlow, startFlow } from '../../lib/accounts-api.ts';
import { explainFailure, remainingMs } from '../../lib/connect-state.ts';
import type { GitAccountsClient } from '../../shell.tsx';

export type ConnectState =
  | { readonly step: 'idle' }
  | { readonly step: 'consent' }
  | { readonly step: 'starting' }
  | { readonly step: 'waiting'; readonly flow: GitDeviceFlow; readonly interval: number; readonly slow: boolean }
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

  const waiting = state.step === 'waiting' ? state : null;
  useEffect(() => {
    if (waiting === null || !visible) return undefined;
    const { flow, interval } = waiting;
    let live = true;
    const timer = setTimeout(() => {
      if (remainingMs(flow.expiresAt, clock.current()) === 0) {
        setState({ step: 'expired' });
        return;
      }
      void pollFlow(client, flow.flowId).then(
        status => {
          if (!live) return;
          if (status.status === 'done') {
            setState({ step: 'done', login: status.login });
            connected.current();
          } else if (status.status === 'expired') setState({ step: 'expired' });
          else if (status.status === 'denied') setState({ step: 'denied' });
          else setState({ step: 'waiting', flow, interval: status.interval, slow: status.status === 'slow_down' });
        },
        cause => {
          if (live) setState({ step: 'error', message: explainFailure(cause) });
        },
      );
    }, pollDelay(interval));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waiting, visible, client, pollDelay]);

  const ask = useCallback(() => setState({ step: 'consent' }), []);
  const cancel = useCallback(() => setState({ step: 'idle' }), []);
  const proceed = useCallback(async () => {
    setState({ step: 'starting' });
    try {
      const flow = await startFlow(client);
      setState({ step: 'waiting', flow, interval: flow.interval, slow: false });
    } catch (cause) {
      setState({ step: 'error', message: explainFailure(cause) });
    }
  }, [client]);

  return { state, ask, cancel, proceed };
}
