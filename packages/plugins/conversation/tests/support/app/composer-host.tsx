/**
 * A composer suite's host: the half's client context around the element, with a client that answers only what the
 * suite fakes. Today's suites rendered `<Composer api={…} daemon={…} />` bare, because the composer took its calls as
 * props; in 5.0 the composer reads the half's client, so a suite hands it one here.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactElement } from 'react';
import { ConversationClientProvider } from '../../../app/client.ts';

export type FakeCall = (route: string, init?: Parameters<PluginClient['call']>[1]) => Promise<unknown>;

/** A client whose `call` is the suite's, and which refuses everything else. */
export function fakeClient(call?: FakeCall, more: Partial<PluginClient> = {}): PluginClient {
  return {
    call: (async (route: string, init?: Parameters<PluginClient['call']>[1]) => {
      if (call === undefined) throw new Error(`the suite did not fake ${route}`);
      return await call(route, init);
    }) as PluginClient['call'],
    subscribe: () => () => undefined,
    ...more,
  };
}

/** One client for every bare render, so a re-render keeps the same client (and the composer its state). */
const BARE_CLIENT = fakeClient();

/** The element inside the half's client context. */
export function withClient(element: ReactElement, client: PluginClient = BARE_CLIENT): ReactElement {
  return <ConversationClientProvider client={client}>{element}</ConversationClientProvider>;
}

/** Today's suites opened a draft stream through a `DaemonStreamOpener`; this is that opener as the client's socket. */
export interface SuiteStreamRequest {
  readonly ferretId: string;
  readonly onData: (
    data: { readonly kind: 'text'; readonly text: string } | { readonly kind: 'bytes'; readonly bytes: Uint8Array },
  ) => void;
}
export interface SuiteStreamSession {
  sendStream(frame: { readonly kind: string; readonly text?: string }): void;
  closeStream(code: number): void;
  onStreamClosed(listener: (closed: { code: number; reason: string }) => void): void;
}
export type SuiteStreamOpener = (request: SuiteStreamRequest) => SuiteStreamSession;

/** A suite's stream opener as the client's `socket`: frames in as text, the close as `"<code> <reason>"`. */
export function socketOf(open: SuiteStreamOpener, keys: string[] = []): Pick<PluginClient, 'socket'> {
  return {
    socket: (key, params, listeners) => {
      keys.push(key);
      const session = open({
        ferretId: params.ferretId ?? '',
        onData: data => listeners.onFrame(data.kind === 'text' ? data.text : data.bytes),
      });
      session.onStreamClosed(closed => listeners.onClose(`${closed.code} ${closed.reason}`));
      return {
        send: frame => session.sendStream({ kind: 'text', text: String(frame) }),
        close: () => session.closeStream(1000),
      };
    },
  };
}
