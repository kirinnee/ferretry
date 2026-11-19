/**
 * CONNECTING A GITHUB ACCOUNT: start the device flow, show the code, poll until GitHub answers.
 *
 * The poll waits the interval the daemon gave (and the longer one a `slow_down` asks for); a read that fails is a state
 * shown, and polling stops: a flow nobody can read is not retried behind the person's back. Closing the card stops it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ProjectsClient, reasonOf } from '../../lib/client.ts';
import { type DeviceFlow, pollDeviceFlow, startDeviceFlow } from './accounts-api.ts';

type DeviceFlowState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'waiting'; readonly flow: DeviceFlow }
  | { readonly phase: 'connected'; readonly login: string; readonly accountId: string }
  | { readonly phase: 'expired' }
  | { readonly phase: 'denied' }
  | { readonly phase: 'failed'; readonly message: string };

export interface DeviceFlowControls {
  readonly state: DeviceFlowState;
  readonly start: () => void;
  readonly cancel: () => void;
}

export function useDeviceFlow(
  client: ProjectsClient,
  onConnected: (accountId: string, login: string) => void,
): DeviceFlowControls {
  const [state, setState] = useState<DeviceFlowState>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    stop();
    const controller = new AbortController();
    abort.current = controller;
    setState({ phase: 'starting' });

    const poll = (flow: DeviceFlow, seconds: number): void => {
      timer.current = setTimeout(() => {
        void pollDeviceFlow(client, flow.flowId, controller.signal)
          .then(answer => {
            if (controller.signal.aborted) return;
            if (answer.status === 'done') {
              setState({ phase: 'connected', login: answer.login, accountId: answer.accountId });
              connected.current(answer.accountId, answer.login);
            } else if (answer.status === 'expired' || answer.status === 'denied') {
              setState({ phase: answer.status });
            } else {
              poll(flow, answer.interval ?? seconds);
            }
          })
          .catch((cause: unknown) => {
            if (!controller.signal.aborted) setState({ phase: 'failed', message: reasonOf(cause) });
          });
      }, seconds * 1000);
    };

    void startDeviceFlow(client)
      .then(flow => {
        if (controller.signal.aborted) return;
        setState({ phase: 'waiting', flow });
        poll(flow, flow.interval);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setState({ phase: 'failed', message: reasonOf(cause) });
      });
  }, [client, stop]);

  const cancel = useCallback(() => {
    stop();
    setState({ phase: 'idle' });
  }, [stop]);

  return { state, start, cancel };
}
