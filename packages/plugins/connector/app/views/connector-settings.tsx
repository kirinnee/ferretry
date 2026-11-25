/**
 * SETTINGS › CLAUDE CONNECTOR (docs/mcp-connector.md, "Why the approval happens in the app").
 *
 * Four things, top to bottom, each in the settings kit's own group so the tab looks like its neighbours at every
 * rounding and every width:
 *
 * - THE SWITCH ("Let Claude connect") and, while it is reachable, the ADDRESS Claude is given with a copy button. The
 *   switch only turns the connector on or off; the address, port and redirects stay the operator's (or the built-in
 *   tunnel's).
 * - WAITING FOR YOU: each Claude sign-in with its match code, Approve (a passkey proved fresh for `approve-connector`;
 *   the shell's client opens the prompt and resends) and Deny.
 * - CONNECTED APPS: what each may do, when it last called, and Revoke behind a confirm.
 *
 * A passkey belongs to THIS app's origin, not to the hostname serving /mcp, so the daemon's waiting page shows a short
 * match code and sends the owner here. Nothing secret is on this screen to leak: public ids, a code, names and times.
 */
import { controlState, SettingGroup, SettingRow, SettingSwitch, useViewPlace } from '@ferretry/app';
import { Loading, SetupNote, useNow } from '@ferretry/app/ui';
import { useEffect, useState } from 'react';
import type { ConnectorGrantView, ConnectorStatus } from '../../contract/index.ts';
import type { ConnectorClient } from '../lib/client.ts';
import { type Connector, useConnector } from '../lib/use-connector.ts';
import {
  addressSourceWords,
  LOAD_FAILURE,
  NEEDS_UPDATE,
  NO_GRANTS,
  NO_PENDING,
  orderedGrants,
  requestFromSearch,
  SWITCH_HINT_OFF,
  SWITCH_HINT_ON,
  SWITCH_NAME,
} from '../lib/words.ts';
import { AddressRow } from './address-row.tsx';
import { GrantRow } from './grant-row.tsx';
import { PendingCard } from './pending-card.tsx';
import { RevokeDialog } from './revoke-dialog.tsx';

const SWITCH_ROUTE = 'PUT /v1/connector';
const APPROVE_ROUTE = 'POST /v1/connector/requests/:id/approve';

const hintOf = (status: ConnectorStatus): string => {
  if (!status.switchedOn) return [SWITCH_HINT_OFF, status.disabledReason].filter(Boolean).join(' ');
  // On, but nothing answers yet (waiting for the built-in tunnel's hostname): the daemon's own reason comes first.
  return status.enabled ? SWITCH_HINT_ON : (status.disabledReason ?? 'On, but Claude cannot reach it yet.');
};

/** What this device may do with a route: shown and enabled unless the machine said otherwise; outside a machine's view, the daemon's own refusal is the answer. */
function useMayDo(route: string): { readonly shown: boolean; readonly enabled: boolean; readonly note?: string } {
  const place = useViewPlace();
  return place === null ? { shown: true, enabled: true } : controlState(place.authorityOf(route));
}

function Empty({ children, name }: { readonly children: string; readonly name: string }) {
  return (
    <li className="px-panel py-3 text-cell leading-base text-muted" data-connector-empty={name}>
      {children}
    </li>
  );
}

function Body({
  status,
  connector,
  now,
  focus,
}: {
  readonly status: ConnectorStatus;
  readonly connector: Connector;
  readonly now: number;
  readonly focus: string | null;
}) {
  const [revoking, setRevoking] = useState<ConnectorGrantView | null>(null);
  const mayAct = useMayDo(SWITCH_ROUTE);
  const mayApprove = useMayDo(APPROVE_ROUTE);
  const pending = status.pending.toSorted((a, b) => Number(b.id === focus) - Number(a.id === focus));
  const working = connector.busy !== null;
  const source = addressSourceWords(status.publicUrlSource);
  return (
    <>
      <SettingGroup label="Claude connector" settingId="connector" saves="now">
        <SettingRow
          name={SWITCH_NAME}
          hint={hintOf(status)}
          control={labelId =>
            mayAct.shown ? (
              <SettingSwitch
                checked={status.switchedOn}
                labelledBy={labelId}
                disabled={connector.switching || !mayAct.enabled}
                onChange={next => void connector.switchTo(next)}
              />
            ) : null
          }
        />
        {mayAct.note === undefined ? null : (
          <li className="px-panel py-2 text-meta leading-base text-muted">{mayAct.note}</li>
        )}
        {status.enabled && status.mcpUrl !== undefined ? <AddressRow mcpUrl={status.mcpUrl} /> : null}
        {status.enabled && source !== null ? (
          <li
            className="px-panel py-2 text-meta leading-base text-faint"
            data-connector-source={status.publicUrlSource}
          >
            {source}
          </li>
        ) : null}
      </SettingGroup>
      {connector.failure === null ? null : (
        <SetupNote live tone="err" name="connector-failure">
          <span data-connector-failure="">{connector.failure}</span>
        </SetupNote>
      )}
      <SettingGroup label="Waiting for you">
        {pending.length === 0 ? (
          <Empty name="pending">{NO_PENDING}</Empty>
        ) : (
          pending.map(each => (
            <PendingCard
              key={each.id}
              pending={each}
              now={now}
              busy={working}
              focused={each.id === focus}
              canApprove={mayApprove.shown}
              onApprove={() => void connector.approve(each.id)}
              onDeny={() => void connector.deny(each.id)}
            />
          ))
        )}
      </SettingGroup>
      <SettingGroup label="Connected apps">
        {status.grants.length === 0 ? (
          <Empty name="grants">{NO_GRANTS}</Empty>
        ) : (
          orderedGrants(status.grants).map(grant => (
            <GrantRow key={grant.id} grant={grant} now={now} busy={working} onRevoke={() => setRevoking(grant)} />
          ))
        )}
      </SettingGroup>
      {revoking === null ? null : (
        <RevokeDialog
          grant={revoking}
          busy={working}
          onCancel={() => setRevoking(null)}
          onConfirm={() => void connector.revoke(revoking).then(() => setRevoking(null))}
        />
      )}
    </>
  );
}

export function ConnectorSettings({
  client,
  now,
  focus = requestFromSearch(window.location.search),
  pollMs,
}: {
  readonly client: ConnectorClient;
  /** A fixed clock, so "5 minutes ago" is stable in a test or a picture. */
  readonly now?: number;
  /** The sign-in the waiting page's link named, put first and scrolled to. */
  readonly focus?: string | null;
  /** How often to read again (a test shortens it). */
  readonly pollMs?: number;
}) {
  const connector = useConnector(client, pollMs);
  const clock = useNow(now);
  const ready = connector.read.kind === 'ready';
  useEffect(() => {
    if (ready && focus !== null) document.querySelector('[data-focused]')?.scrollIntoView({ block: 'center' });
  }, [ready, focus]);
  return (
    <div className="flex min-w-0 flex-col" data-settings="connector">
      {connector.read.kind === 'loading' ? <Loading kind="page" label="Reading the connector…" /> : null}
      {connector.read.kind === 'outdated' ? (
        <SetupNote tone="warn" name="connector-outdated" title={NEEDS_UPDATE}>
          Update it with `fy update`, then reload this page.
        </SetupNote>
      ) : null}
      {connector.read.kind === 'failed' ? (
        <SetupNote tone="warn" name="connector-failed">
          {LOAD_FAILURE}
        </SetupNote>
      ) : null}
      {connector.read.kind === 'ready' ? (
        <Body status={connector.read.status} connector={connector} now={clock} focus={focus} />
      ) : null}
    </div>
  );
}
