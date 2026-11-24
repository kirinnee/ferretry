/**
 * THE CONNECTORS PANEL: where the owner approves a Claude sign-in with a passkey, and where a connected app is
 * revoked (docs/mcp-connector.md).
 *
 * ## WHY THE APPROVAL IS HERE
 *
 * A passkey belongs to the origin of THIS app, not to the tunnel hostname that serves `/mcp`. The daemon's waiting
 * page therefore shows a short MATCH CODE and sends the owner here; the code is the phishing defence, so it is
 * drawn large and the warning that goes with it is in the same breath, never behind a disclosure.
 *
 * ## NO SWITCH
 *
 * Turning the connector on is an edit to `config/daemon.json` on the host. A phone cannot do it, so when it is
 * off this panel says why and offers no toggle.
 *
 * ## NOTHING SECRET IS HERE TO LEAK
 *
 * The view carries public ids, a match code, names and times — never a handle, an authorization code or a token.
 * The passkey prompt is the carrier's: a refused approve answers `403 grant_step_up_required`, the app's single
 * prompt appears, and the request is resent once.
 *
 * ## POLLING
 *
 * While the panel is on screen and the page is visible it re-reads every 2 s, because a sign-in lives ten minutes
 * and the person is waiting on a page that refreshes itself. A hidden page stops; coming back reads at once.
 */

import { CircleAlert, Copy, Fingerprint, Link2, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { absoluteWords, relativeWords } from '../../lib/security-log.ts';
import { Button } from '../../shell/primitives.tsx';
import {
  approveConnectorRequest,
  type ConnectorClient,
  type ConnectorGrant,
  type ConnectorPending,
  type ConnectorView,
  denyConnectorRequest,
  readConnector,
  revokeConnectorGrant,
} from './connector-api.ts';
import {
  actFailureSentence,
  approvedByWords,
  CONNECTOR_POLL_MS,
  MATCH_CODE_WARNING,
  NOT_ENABLED_NOTE,
  orderedGrants,
  pendingHeadline,
  revokeConsequence,
  scopeSentence,
} from './connector-model.ts';

export type ConnectorClientFactory = (connection: DaemonConnection) => Promise<ConnectorClient>;

const LOAD_FAILURE = 'This machine did not answer the list of connected apps. It will be tried again in a moment.';

function PendingCard({
  pending,
  busy,
  now,
  onApprove,
  onDeny,
}: {
  readonly pending: ConnectorPending;
  readonly busy: boolean;
  readonly now: number;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}) {
  const warningId = useId();
  return (
    <li
      data-connector-pending={pending.id}
      className="flex min-w-0 flex-col gap-2 border-t border-border-soft py-3 first:border-t-0"
    >
      <p className="m-0 break-words text-ui font-semibold text-fg" data-connector-headline="">
        {pendingHeadline(pending)}
      </p>
      <p className="m-0 text-meta leading-base text-faint">
        From {pending.redirectHost} · asked {relativeWords(pending.createdAt, now)}
      </p>
      <p
        data-connector-match-code=""
        className="m-0 w-fit select-all rounded-control border border-border-strong bg-surface-2 px-4 py-2 font-mono text-[2rem] font-bold leading-none tracking-[0.18em] text-fg"
      >
        {pending.matchCode}
      </p>
      <p
        id={warningId}
        data-connector-warning=""
        className="m-0 rounded-control border border-warn-border bg-warn-bg px-2 py-1 text-cell leading-base text-warn"
      >
        {MATCH_CODE_WARNING}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          aria-describedby={warningId}
          data-connector-approve={pending.id}
          onClick={onApprove}
          className="min-h-[44px]"
        >
          <Fingerprint size={15} aria-hidden="true" />
          Approve with passkey
        </Button>
        <Button
          type="button"
          disabled={busy}
          data-connector-deny={pending.id}
          onClick={onDeny}
          className="min-h-[44px]"
        >
          <X size={15} aria-hidden="true" />
          Deny
        </Button>
      </div>
    </li>
  );
}

function GrantRow({
  grant,
  now,
  busy,
  onRevoke,
}: {
  readonly grant: ConnectorGrant;
  readonly now: number;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}) {
  const revoked = grant.revokedAt !== undefined;
  return (
    <li
      data-connector-grant={grant.id}
      data-connector-revoked={revoked ? '' : undefined}
      className="flex min-w-0 flex-col gap-1 border-t border-border-soft py-2 first:border-t-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ShieldCheck size={15} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-[9rem] flex-1 break-words text-ui font-semibold text-fg">{grant.clientName}</span>
        {revoked ? (
          <span className="text-meta text-faint" data-connector-revoked-label="">
            Revoked {relativeWords(grant.revokedAt as string, now)}
          </span>
        ) : (
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            data-connector-revoke={grant.id}
            onClick={onRevoke}
            className="min-h-[44px] shrink-0"
          >
            <Trash2 size={14} aria-hidden="true" />
            Revoke
          </Button>
        )}
      </div>
      <p className="m-0 text-cell leading-base text-muted">Can {scopeSentence(grant.scopes)}.</p>
      <p className="m-0 text-meta leading-base text-faint">
        Approved by {approvedByWords(grant.approvedBy)} · connected{' '}
        <span title={absoluteWords(grant.createdAt)}>{relativeWords(grant.createdAt, now)}</span> ·{' '}
        {grant.lastUsedAt === undefined ? (
          'never used'
        ) : (
          <span title={absoluteWords(grant.lastUsedAt)}>last used {relativeWords(grant.lastUsedAt, now)}</span>
        )}
      </p>
    </li>
  );
}

/** The confirm step for a revoke: what stops, in the same breath as the button that does it. */
function RevokeDialog({
  grant,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly grant: ConnectorGrant;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { onKeyDown } = useDialogFocus(true, ref, onCancel);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-scrim p-2 sm:items-center"
      role="presentation"
    >
      <button type="button" aria-label="Cancel" tabIndex={-1} className="absolute inset-0" onClick={onCancel} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-connector-revoke-dialog={grant.id}
        className="kt-panel relative flex w-full max-w-md flex-col gap-2 px-cell-x py-3 shadow-popover focus:outline-none"
      >
        <h2 id={titleId} className="m-0 text-title font-semibold text-fg">
          Revoke {grant.clientName}?
        </h2>
        <p id={descriptionId} className="m-0 text-ui leading-base text-muted">
          {revokeConsequence(grant)}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onCancel} className="min-h-[44px]">
            Keep it
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            data-connector-revoke-confirm=""
            onClick={onConfirm}
            className="min-h-[44px]"
          >
            <Trash2 size={14} aria-hidden="true" />
            Revoke
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddressRow({ mcpUrl }: { readonly mcpUrl: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-connector-url-row="">
      <p className="m-0 text-cell leading-base text-muted">
        Add this address in Claude as a custom connector (Settings › Connectors).
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code
          data-connector-url=""
          className="min-w-0 flex-1 select-all break-all rounded-control border border-border-soft bg-surface-2 px-2 py-1 text-cell text-fg"
        >
          {mcpUrl}
        </code>
        <Button type="button" data-connector-copy="" onClick={() => void copy()} className="min-h-[44px] shrink-0">
          <Copy size={14} aria-hidden="true" />
          Copy
        </Button>
      </div>
      <p role="status" className="m-0 text-meta text-faint" data-connector-copied={copied}>
        {copied === 'copied'
          ? 'Copied.'
          : copied === 'failed'
            ? 'Copying was not allowed here. Select it and copy by hand.'
            : ''}
      </p>
    </div>
  );
}

/** The panel's content for a loaded view. Pure over its props so every state is one render. */
export function ConnectorCard({
  view,
  now,
  busyId,
  failure,
  onApprove,
  onDeny,
  onRevoke,
}: {
  readonly view: ConnectorView;
  readonly now: number;
  readonly busyId: string | null;
  readonly failure: string | null;
  readonly onApprove: (id: string) => void;
  readonly onDeny: (id: string) => void;
  readonly onRevoke: (grant: ConnectorGrant) => void;
}) {
  const headingId = useId();
  const grants = orderedGrants(view.grants);
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-labelledby={headingId}
      data-connector-card=""
    >
      <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
        <Link2 size={16} className="text-accent" aria-hidden="true" />
        Claude connector
      </h3>
      {view.enabled && view.mcpUrl !== undefined ? (
        <AddressRow mcpUrl={view.mcpUrl} />
      ) : (
        <p className="m-0 text-cell leading-base text-muted" data-connector-off="">
          {view.disabledReason === undefined ? NOT_ENABLED_NOTE : `${view.disabledReason} ${NOT_ENABLED_NOTE}`}
        </p>
      )}
      {failure === null ? null : (
        <p
          role="alert"
          data-connector-failure=""
          className="m-0 flex items-start gap-1.5 rounded-control border border-err-border bg-err-bg px-2 py-1 text-meta leading-base text-err"
        >
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {failure}
        </p>
      )}
      <h4 className="m-0 mt-1 text-ui font-semibold text-fg">Waiting for you</h4>
      {view.pending.length === 0 ? (
        <p className="m-0 text-cell leading-base text-muted" data-connector-no-pending="">
          No sign-in is waiting. When Claude asks to connect, it shows up here with a match code.
        </p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col p-0" aria-label="Sign-ins waiting for approval">
          {view.pending.map(pending => (
            <PendingCard
              key={pending.id}
              pending={pending}
              now={now}
              busy={busyId !== null}
              onApprove={() => onApprove(pending.id)}
              onDeny={() => onDeny(pending.id)}
            />
          ))}
        </ul>
      )}
      <h4 className="m-0 mt-1 text-ui font-semibold text-fg">Connected apps</h4>
      {grants.length === 0 ? (
        <p className="m-0 text-cell leading-base text-muted" data-connector-no-grants="">
          Nothing is connected.
        </p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col p-0" aria-label="Connected apps">
          {grants.map(grant => (
            <GrantRow key={grant.id} grant={grant} now={now} busy={busyId !== null} onRevoke={() => onRevoke(grant)} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: ConnectorView }
  | { readonly kind: 'failed' };

export interface ConnectorSurfaceProps {
  readonly connection: DaemonConnection;
  readonly createClient: ConnectorClientFactory;
  /** Test seam: the clock, so "5 minutes ago" is stable. */
  readonly now?: () => number;
  /** Test seam: the poll interval. */
  readonly pollMs?: number;
}

/** The live panel for one machine, keyed by the caller on its daemon id. */
export function ConnectorSurface({
  connection,
  createClient,
  now = Date.now,
  pollMs = CONNECTOR_POLL_MS,
}: ConnectorSurfaceProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ConnectorGrant | null>(null);
  const clientRef = useRef<ConnectorClient | null>(null);

  // One loop per mounted panel: read, wait, read. A hidden page waits for `visibilitychange` instead of reading.
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    clientRef.current = null;
    setLoaded({ kind: 'loading' });
    setFailure(null);
    const tick = async (): Promise<void> => {
      timer = undefined;
      if (!current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const client = clientRef.current ?? (await createClient(connection));
        clientRef.current = client;
        const view = await readConnector(client);
        if (current) setLoaded({ kind: 'ready', view });
      } catch {
        // A failed poll keeps what is on screen; only a panel with nothing yet says it failed.
        if (current) setLoaded(held => (held.kind === 'ready' ? held : { kind: 'failed' }));
      }
      if (current) timer = setTimeout(() => void tick(), pollMs);
    };
    const wake = (): void => {
      if (document.visibilityState === 'visible' && timer === undefined) void tick();
    };
    document.addEventListener('visibilitychange', wake);
    void tick();
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [connection, createClient, pollMs]);

  const act = useCallback(async (id: string, run: (client: ConnectorClient) => Promise<void>): Promise<boolean> => {
    const client = clientRef.current;
    if (client === null) return false;
    setBusyId(id);
    setFailure(null);
    let ok = true;
    try {
      await run(client);
    } catch (reason) {
      setFailure(actFailureSentence(reason));
      ok = false;
    }
    try {
      const view = await readConnector(client);
      setLoaded({ kind: 'ready', view });
    } catch {
      // the next poll catches up
    }
    setBusyId(null);
    return ok;
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {loaded.kind === 'ready' ? (
        <ConnectorCard
          view={loaded.view}
          now={now()}
          busyId={busyId}
          failure={failure}
          onApprove={id => void act(id, client => approveConnectorRequest(client, id))}
          onDeny={id => void act(id, client => denyConnectorRequest(client, id))}
          onRevoke={setRevoking}
        />
      ) : (
        <section
          className="kt-panel p-panel"
          role="status"
          aria-label="Claude connector"
          data-connector-state={loaded.kind}
        >
          <p className="m-0 text-cell leading-base text-muted">
            {loaded.kind === 'loading' ? 'Reading the connector…' : LOAD_FAILURE}
          </p>
        </section>
      )}
      {revoking === null ? null : (
        <RevokeDialog
          grant={revoking}
          busy={busyId !== null}
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const grant = revoking;
            void act(grant.id, client => revokeConnectorGrant(client, grant.id)).then(() => setRevoking(null));
          }}
        />
      )}
    </div>
  );
}

/** The Settings panel, for the composition root's `daemonSettingsTabs`, bound to the app's client pool. */
export const connectorSettingsTab = (createClient: ConnectorClientFactory) =>
  ({
    id: 'connector',
    label: 'Claude connector',
    description: 'Let Claude read and control your fleet: approve a sign-in with your passkey, and revoke an app.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <ConnectorSurface connection={connection} createClient={createClient} />
    ),
  }) as const;
