/**
 * Signing in to a remote MCP server, in a sheet (docs/mcp-oauth.md).
 *
 * The person opens the provider's page, signs in there, and the provider sends the browser back to this
 * PWA's callback page. That page posts its address on a same-origin channel; this sheet — the tab that
 * started the sign-in — checks it is for THIS sign-in, answers so the page can wipe the code from its own
 * address bar, and hands it to the daemon over the session it already has.
 *
 * When nobody can answer on the channel (an installed iPhone app opens links in Safari, a private window)
 * or the provider only allows a loopback address, the person brings the address back by hand. Both ways
 * end in the same daemon check, so the paste box is always one tap away.
 *
 * NOTHING HERE KEEPS THE ADDRESS. It carries an authorization code, so the box is emptied the moment it is
 * sent — on success and on a refusal alike — and no answer this sheet posts on the channel repeats it.
 */

import type { McpOAuthConnection, McpOAuthFlow } from '@ferretry/protocol';
import { CheckCircle2, Clock3, ExternalLink, KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { BottomSheet } from '../../../shell/bottom-sheet.tsx';
import { Button } from '../../../shell/primitives.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { cancelMcpSignIn, finishMcpSignIn, startMcpSignIn } from '../mcp-auth-api.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import {
  callbackMatchesFlow,
  callbackMessage,
  finishedMessage,
  issuerHost,
  MCP_OAUTH_CHANNEL,
  receivedMessage,
  signedInSentence,
} from './mcp-sign-in-model.ts';

/** The part of a `BroadcastChannel` this sheet uses, so a test can hand in its own. */
export interface McpSignInChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export type McpSignInChannelFactory = (name: string) => McpSignInChannel | undefined;

/** The browser's own channel, or none where the browser has no `BroadcastChannel` (the paste way still works). */
export const browserChannel: McpSignInChannelFactory = name =>
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : undefined;

export interface McpSignInSheetProps {
  /** The MCP component's name. */
  readonly component: string;
  readonly machineName: string;
  /** The sign-in the caller started. */
  readonly flow: McpOAuthFlow;
  /** This PWA's callback page, for a sign-in started again the way the browser comes back by itself. */
  readonly redirectUri: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The daemon accepted the sign-in. The caller re-reads where every server stands. */
  readonly onSignedIn: (connection: McpOAuthConnection) => void;
  /** The sheet is done with: signed in, cancelled or dismissed. */
  readonly onClose: () => void;
  /** Supplied in tests. */
  readonly channel?: McpSignInChannelFactory;
  readonly now?: () => number;
}

type Phase = 'waiting' | 'sending' | 'done' | 'expired';

export function McpSignInSheet({
  component,
  machineName,
  flow: startedFlow,
  redirectUri,
  connection,
  createClient,
  onSignedIn,
  onClose,
  channel: openChannel = browserChannel,
  now = Date.now,
}: McpSignInSheetProps) {
  const headingId = useId();
  const [flow, setFlow] = useState(startedFlow);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  /** Start any new sign-in without a return address, once the person asked for the paste way. */
  const [preferPaste, setPreferPaste] = useState(false);
  const live = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const channelRef = useRef<McpSignInChannel | undefined>(undefined);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const submit = useCallback(
    async (callback: string, handOver?: string): Promise<void> => {
      setPhase('sending');
      setRefusal(null);
      let ok = false;
      try {
        const client = await createClient(connection);
        const answer = await finishMcpSignIn(client, flow.flowId, callback);
        ok = true;
        if (!live.current) return;
        setSignedIn(signedInSentence(answer.connection, now()));
        setPhase('done');
        onSignedIn(answer.connection);
      } catch (error) {
        if (!live.current) return;
        setRefusal(changeRefusalSentence(error));
        setPhase('waiting');
      } finally {
        if (handOver !== undefined) channelRef.current?.postMessage(finishedMessage(handOver, ok));
      }
    },
    [connection, createClient, flow.flowId, now, onSignedIn],
  );
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // The callback page's hand-over. Only a sign-in that comes back by itself listens, and only to its own
  // state: another tab's sign-in on the same channel is not this one's to forward.
  useEffect(() => {
    if (flow.mode !== 'pwa') return;
    const channel = openChannel(MCP_OAUTH_CHANNEL);
    if (channel === undefined) return;
    channelRef.current = channel;
    channel.onmessage = event => {
      const message = callbackMessage(event.data);
      if (message === undefined || phaseRef.current !== 'waiting' || !callbackMatchesFlow(message.href, flow)) return;
      channel.postMessage(receivedMessage(message.id));
      void submitRef.current(message.href, message.id);
    };
    return () => {
      channel.onmessage = null;
      channel.close();
      if (channelRef.current === channel) channelRef.current = undefined;
    };
  }, [flow, openChannel]);

  // A sign-in the daemon will refuse anyway says so as it runs out, rather than after a paste.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const timer = setTimeout(() => setPhase('expired'), Math.max(0, Date.parse(flow.expiresAt) - now()));
    return () => clearTimeout(timer);
  }, [flow.expiresAt, now, phase]);

  const pasted = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = address.trim();
    if (value === '' || phase !== 'waiting') return;
    // Emptied BEFORE the request settles, whatever the daemon answers: an authorization code must not sit
    // in the rendered tree, in a retry, or in a screenshot.
    setAddress('');
    void submit(value);
  };

  const cancel = async (): Promise<void> => {
    if (phaseRef.current !== 'done')
      try {
        await cancelMcpSignIn(await createClient(connection), flow.flowId);
      } catch {
        // A sign-in ends by itself ten minutes after it started; closing never waits on the machine.
      }
    onClose();
  };

  const startAgain = async (paste: boolean): Promise<void> => {
    setPhase('sending');
    setRefusal(null);
    try {
      const client = await createClient(connection);
      await cancelMcpSignIn(client, flow.flowId).catch(() => undefined);
      const next = await startMcpSignIn(client, component, paste ? {} : { redirectUri });
      if (!live.current) return;
      setPreferPaste(paste);
      setPasteOpen(false);
      setFlow(next);
      setPhase('waiting');
    } catch (error) {
      if (!live.current) return;
      setRefusal(changeRefusalSentence(error));
      setPhase('waiting');
    }
  };

  const issuer = issuerHost(flow.issuer);
  const sending = phase === 'sending';
  const pasteForm = (
    <form className="flex flex-col gap-2" onSubmit={pasted} data-mcp-sign-in-paste="">
      <label htmlFor={`${headingId}-address`} className="text-ui font-semibold text-fg">
        The address the sign-in ended on
      </label>
      <textarea
        id={`${headingId}-address`}
        name="mcp-sign-in-address"
        className="kt-input min-h-24 w-full resize-y font-mono text-meta"
        value={address}
        onChange={event => setAddress(event.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={sending}
      />
      <div>
        <Button type="submit" variant="primary" disabled={sending || address.trim() === ''}>
          <ShieldCheck size={16} aria-hidden="true" />
          {sending ? 'Finishing…' : 'Finish sign-in'}
        </Button>
      </div>
      <p className="m-0 text-meta leading-base text-muted">
        It goes straight to {machineName}, which finishes the sign-in and keeps nothing of the address. It is never
        shown back to you.
      </p>
    </form>
  );

  return (
    <BottomSheet
      id={`mcp-sign-in-${flow.flowId}`}
      open
      onClose={() => void cancel()}
      labelledBy={headingId}
      closeLabel="Close sign-in"
      panelClassName="kt-details bg-surface"
      maxHeight="min(86dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border px-panel pb-row-y">
        <div className="mx-auto flex w-full max-w-2xl min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent">
            <KeyRound size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="m-0 break-words font-display text-title font-semibold text-fg">
              Sign in to <span className="font-mono">{component}</span>
            </h2>
            <p className="m-0 mt-0.5 break-words text-ui text-muted">
              With <span className="font-mono text-fg">{issuer}</span>
            </p>
          </div>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4"
        data-mcp-sign-in={phase}
        data-mcp-sign-in-mode={flow.mode}
      >
        <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-4 py-3">
          {phase === 'done' ? (
            <>
              <div
                role="status"
                className="flex items-start gap-3 rounded-control border border-ok/40 bg-ok-soft p-3 text-ui leading-base text-fg"
              >
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="m-0 font-semibold">{signedIn}</p>
                  <p className="m-0 mt-1 text-muted">
                    Runtimes that use {component} can reach it from their next launch.
                  </p>
                </div>
              </div>
              <div>
                <Button type="button" variant="primary" onClick={onClose} data-mcp-sign-in-done="">
                  Done
                </Button>
              </div>
            </>
          ) : phase === 'expired' ? (
            <>
              <p
                role="alert"
                className="m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
              >
                <Clock3 size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                This sign-in expired. Start again.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void startAgain(preferPaste)}
                  data-mcp-sign-in-restart=""
                >
                  Start again
                </Button>
                <Button type="button" onClick={() => void cancel()} data-mcp-sign-in-cancel="">
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              {flow.note === undefined ? null : (
                <p
                  className="m-0 rounded-control border border-border bg-surface-2 px-3 py-2 text-ui leading-base text-muted"
                  data-mcp-sign-in-note=""
                >
                  {flow.note}
                </p>
              )}
              {refusal === null ? null : (
                <p
                  role="alert"
                  data-mcp-sign-in-refusal=""
                  className="m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
                >
                  <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {refusal}
                </p>
              )}

              <div className="flex flex-col gap-2">
                <p className="m-0 text-ui font-semibold text-fg">1 · Sign in at {issuer}</p>
                <div>
                  <a
                    href={flow.authorizeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="kt-btn no-underline"
                    data-variant="primary"
                    data-mcp-sign-in-open=""
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                    Open sign-in page
                  </a>
                </div>
              </div>

              {flow.mode === 'pwa' ? (
                <>
                  <p className="m-0 text-ui leading-base text-muted" role="status" data-mcp-sign-in-waiting="">
                    {sending ? 'Finishing sign-in…' : 'After you sign in you’ll come back here automatically.'}
                  </p>
                  <details
                    open={pasteOpen}
                    onToggle={event => setPasteOpen(event.currentTarget.open)}
                    className="rounded-control border border-border"
                    data-mcp-sign-in-paste-disclosure=""
                  >
                    <summary className="flex cursor-pointer items-center px-3 py-2 text-ui font-semibold text-fg">
                      Didn’t come back? Paste the address
                    </summary>
                    <div className="flex flex-col gap-2 border-t border-border p-3">
                      <p className="m-0 text-ui leading-base text-muted">
                        Copy the address of the page the sign-in ended on — Ferretry’s page offers a Copy address button
                        — and paste it here.
                      </p>
                      {pasteForm}
                    </div>
                  </details>
                  <div className="flex flex-col gap-1">
                    <p className="m-0 text-meta leading-base text-muted">
                      Did {issuer} say the return address isn’t allowed?
                    </p>
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={sending}
                        onClick={() => void startAgain(true)}
                        data-mcp-sign-in-use-paste=""
                      >
                        Use the paste method instead
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="m-0 text-ui font-semibold text-fg">2 · Bring the address back</p>
                  <p className="m-0 text-ui leading-base text-muted">
                    After you sign in, the page will fail to load. Copy its address from the address bar and paste it
                    here.
                  </p>
                  {pasteForm}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {/* A refused address may have used the sign-in up — the daemon single-uses it — so the way
                    on is a fresh one, the same way round as this one. */}
                {refusal === null ? null : (
                  <Button
                    type="button"
                    disabled={sending}
                    onClick={() => void startAgain(preferPaste)}
                    data-mcp-sign-in-restart=""
                  >
                    Start again
                  </Button>
                )}
                <Button type="button" disabled={sending} onClick={() => void cancel()} data-mcp-sign-in-cancel="">
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}
