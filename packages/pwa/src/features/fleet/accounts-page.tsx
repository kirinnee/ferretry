/**
 * THE ACCOUNTS PANEL, wired. A daemon settings panel, and the child of Fleet.
 *
 * ## WHY IT IS NOT A DESTINATION ANY MORE
 *
 * It shipped as a top-level route — `/d/:daemonId/accounts`, breadcrumb `Sessions › Accounts` — while
 * everything it reads is scoped to ONE machine, which is what the sentence below this one has always
 * said: a fleet belongs to a machine, so nothing here is cached at module scope. The navigation did
 * not agree with the data. With more than one daemon paired, nothing on the screen said which machine
 * the accounts belonged to, and the breadcrumb — which named no daemon — was the only thing that could
 * have, if somebody had read it.
 *
 * So the scope now comes from the PATH somebody took to get here: Settings › Daemons › this machine ›
 * Fleet › Accounts. The frame's header names the machine above every panel, which is a fact you cannot
 * fail to notice rather than a label you have to.
 *
 * IT IS A CHILD OF FLEET RATHER THAN AN ELEVENTH SIBLING, because Fleet and Accounts are the two
 * halves of one subject and are not the same thing: Fleet writes the wrappers, Accounts is where a
 * login is signed in. The rail draws that relation — see `orderedDaemonPanels` and `ChoiceRail`'s
 * `parentId` — so the two read as one subject at two levels instead of as two unrelated rows.
 *
 * The route it replaces is DELETED, not deprecated. There is no second way in.
 *
 * ## WHAT IT REPLACES
 *
 * `fleet-sign-in-section.tsx` — a tab inside Settings, grouped by provider login, with one control per
 * group. It is deleted rather than deprecated, and this page keeps every guarantee it had: the shared
 * operator prompt, the poll of a live sign-in, the credential-source sentence where a sign-in cannot
 * help, the usage line that says "unknown" and never "0%", and a refusal in the daemon's own words.
 *
 * Two things are new, and both come from the owner's own words — an accounts page they can add to, and
 * "on the account page, we should be able to see when it was last check":
 *
 * 1. **A verdict and its instant, per account.** From `GET /v1/fleet/health`, which is a STORED
 *    snapshot: the daemon reads its own file and checks nothing, so opening this page cannot cost a
 *    provider call, let alone start an agent.
 * 2. **The account you click is the account that gets signed in.** One row, one `accountId`, one
 *    `POST /v1/fleet/login`.
 *
 * ## WHAT IT WILL NEVER DO
 *
 * No timer, no poll of health, no check on mount, and nothing launched to find anything out. The only
 * collecting call is `POST /v1/fleet/health/check`, from the button and nowhere else — and that call
 * is free by construction: one read-only provider status GET per credential, no model asked anything.
 * `boot-lifecycle.test.ts`'s "what an unattended fleet pass may spend" journey is the guard, and this
 * page adds nothing it has to forgive.
 *
 * The sign-in poll IS a timer, and it is a different thing: it exists only while a flow this reader
 * started is still live, it reads that flow's own state, and it stops the moment the flow settles.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetLoginReadiness, FleetPermissions, HarnessLoginFlow, UsageAccountView } from '@ferretry/protocol';

import type { PickerAccountHealth } from '../../lib/account-picker-catalog.ts';
import { checkAccountPickerHealth } from '../../lib/account-picker-catalog.ts';
import type { AccountPickerLoadStatus } from '../../lib/account-picker-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type HeldUnlock, type OperatorUnlockFailure, operatorUnlockFailure, usableUnlock } from '../../lib/grants.ts';
import { unlockGrants } from '../settings/grants-api.ts';
import { OperatorUnlockDialog } from '../settings/operator-unlock-dialog.tsx';
import { type AccountRowView, accountsRoster } from './accounts-model.ts';
import { type AccountsReadState, AccountsSurface } from './accounts-surface.tsx';
import { type FleetClient, fleetRefusal, readFleetAccountHealth, readFleetPermissions } from './fleet-api.ts';
import { fleetApplyAuthority, fleetApplyNeedsPassword } from './fleet-change-model.ts';
import type { FleetClientFactory } from './fleet-configuration-surface.tsx';
import {
  cancelHarnessLogin,
  readDaemonUsageFeed,
  readFleetLoginReadiness,
  readHarnessLoginFlow,
  renewFleetCredential,
  startHarnessLogin,
  submitHarnessLoginCode,
  usageByWrapper,
} from './harness-login-api.ts';

/** How often a live sign-in is re-read. The person is acting somewhere this browser cannot see. */
const POLL_MS = 2_000;

export interface AccountsPageProps {
  readonly connection: DaemonConnection;
  /** The connection-bound client. A fleet belongs to a machine, so nothing is cached at module scope. */
  readonly createClient: FleetClientFactory;
  readonly now?: () => number;
  /** Injected so a test asserts against a fixture rather than against whenever the suite ran. */
  readonly usage?: ReadonlyMap<string, UsageAccountView>;
  readonly pollMs?: number;
  /**
   * Show the Fleet panel, which is where an account is added.
   *
   * Required rather than optional: this is the one outward move the panel offers, and a default no-op
   * would render a primary button that does nothing on any caller that forgot to wire it.
   */
  readonly onAddAccount: () => void;
  className?: string;
}

/** Live sign-ins, keyed by the ACCOUNT whose wrapper is showing the browser. */
type FlowsByAccount = Readonly<Record<string, HarnessLoginFlow>>;

const terminal = (flow: HarnessLoginFlow): boolean => flow.state === 'complete' || flow.state === 'failed';

/**
 * The accounts read, or the reason there is none.
 *
 * `unavailable` is a state and never an empty roster: a daemon that could not answer still has
 * whatever accounts it has, and rendering zero of them is a claim nothing established.
 */
type ReadinessState =
  | { readonly kind: 'reading' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly readiness: FleetLoginReadiness };

/** What was read, held raw: the projection happens at render, against one instant. */
interface AccountsRead {
  readonly readiness: ReadinessState;
  readonly health: ReadonlyMap<string, PickerAccountHealth>;
  readonly feed: ReadonlyMap<string, UsageAccountView>;
}

const EMPTY_READ: AccountsRead = { readiness: { kind: 'reading' }, health: new Map(), feed: new Map() };

export function AccountsPage({
  connection,
  createClient,
  now = Date.now,
  usage,
  pollMs = POLL_MS,
  onAddAccount,
  className,
}: AccountsPageProps) {
  const [client, setClient] = useState<FleetClient | null>(null);
  const [read, setRead] = useState<AccountsRead>(EMPTY_READ);
  const [permissions, setPermissions] = useState<FleetPermissions | null>(null);
  const [flows, setFlows] = useState<FlowsByAccount>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<HeldUnlock | null>(null);
  const [pending, setPending] = useState<AccountRowView | null>(null);
  /** The row a renewal is waiting on a password for. Separate from `pending`, because the dialog says
   *  which act the password is being spent on and the two acts are not interchangeable. */
  const [pendingRenewal, setPendingRenewal] = useState<AccountRowView | null>(null);
  const [unlockFailure, setUnlockFailure] = useState<OperatorUnlockFailure | null>(null);
  const [healthStatus, setHealthStatus] = useState<AccountPickerLoadStatus>('idle');
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checked, setChecked] = useState(0);
  /** Read inside the poll so a tick never closes over a stale client. */
  const clientRef = useRef<FleetClient | null>(null);
  clientRef.current = client;

  const authority = fleetApplyAuthority(permissions);
  const unlock = usableUnlock(held, connection.daemonId, now());

  const load = useCallback(async (bound: FleetClient, token: string | undefined): Promise<void> => {
    try {
      const [readiness, allowed] = await Promise.all([
        readFleetLoginReadiness(bound, token),
        readFleetPermissions(bound, token),
      ]);
      setPermissions(allowed);
      setRefusal(null);
      // Two reads that must not take the roster down with them. A health snapshot this daemon could
      // not serve leaves every row UNREAD — which has its own sentence — and a usage scrape that
      // missed leaves the last feed alone, because a quota column that emptied reads as "nothing is
      // using anything", the exact opposite of what a failed probe means.
      const [health, feed] = await Promise.all([
        readFleetAccountHealth(bound).then(
          catalog => catalog,
          (error: unknown) => ({ health: new Map<string, PickerAccountHealth>(), error: fleetRefusal(error).detail }),
        ),
        readDaemonUsageFeed(bound).then(usageByWrapper, () => undefined),
      ]);
      // A snapshot that arrived ambiguous — or did not arrive — is reported through the check
      // control's own error slot rather than as a page refusal: the roster is fine, and what is
      // damaged is the evidence beside it. The status is `error` and never `ready`, so nothing on
      // screen claims a check just ran.
      setHealthStatus(health.error === null ? 'idle' : 'error');
      setHealthError(health.error);
      setRead(current => ({
        readiness: { kind: 'ready', readiness },
        health: health.health,
        feed: feed ?? current.feed,
      }));
    } catch (error) {
      setRead(current => ({ ...current, readiness: { kind: 'unavailable', reason: fleetRefusal(error).detail } }));
    }
  }, []);

  useEffect(() => {
    let live = true;
    setRead(EMPTY_READ);
    setPermissions(null);
    setFlows({});
    setHeld(null);
    setHealthStatus('idle');
    setPendingRenewal(null);
    void createClient(connection).then(
      async bound => {
        if (!live) return;
        setClient(bound);
        await load(bound, undefined);
      },
      (error: unknown) => {
        if (!live) return;
        setRead({ ...EMPTY_READ, readiness: { kind: 'unavailable', reason: fleetRefusal(error).detail } });
      },
    );
    return () => {
      live = false;
    };
  }, [connection, createClient, load]);

  /** Re-read every live sign-in until it settles. */
  useEffect(() => {
    const alive = Object.values(flows).filter(flow => !terminal(flow));
    if (alive.length === 0) return undefined;
    const handle = setInterval(() => {
      const bound = clientRef.current;
      if (bound === null) return;
      for (const flow of alive) {
        void readHarnessLoginFlow(bound, flow.flowId, unlock).then(
          next => setFlows(current => ({ ...current, [next.accountId]: next })),
          () => undefined,
        );
      }
    }, pollMs);
    return () => clearInterval(handle);
  }, [flows, pollMs, unlock]);

  /**
   * Start one account's sign-in, spending the typed password on every step that needs it.
   *
   * `locked` and `confirm` are not alternatives: a remote caller on a machine with an operator password
   * is locked AND owes a per-sign-in confirmation, so the value arrives once and is used twice.
   */
  const run = useCallback(
    async (row: AccountRowView, password: string | undefined): Promise<void> => {
      const bound = clientRef.current;
      if (bound === null) return;
      setBusy(true);
      setRefusal(null);
      setUnlockFailure(null);
      let token = usableUnlock(held, connection.daemonId, now());
      // Tracked rather than inferred afterwards: a throw from the MINT is a password problem and a
      // throw from the START is a sign-in problem, and the two are shown in two different places.
      let minting = authority.kind === 'locked' && token === undefined && password !== undefined;
      try {
        if (minting) {
          const minted = await unlockGrants(bound, String(password));
          setHeld({ daemonId: connection.daemonId, token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) });
          token = minted.token;
          minting = false;
        }
        const flow = await startHarnessLogin(
          bound,
          {
            // THE ROW'S OWN ACCOUNT. Not its login's first applicable member, which is what the
            // surface this replaced sent — see `chooseLoginDriver`.
            accountId: row.accountId,
            // Sent only where the daemon SAID it would be asked for. A password on a request that does
            // not need one is a secret spent for nothing.
            ...(password === undefined || !fleetApplyNeedsPassword(authority) ? {} : { operatorPassword: password }),
          },
          token,
        );
        setFlows(current => ({ ...current, [flow.accountId]: flow }));
        setPending(null);
      } catch (error) {
        const refused = fleetRefusal(error);
        // In the dialog when the password is what was rejected — the mint, or a start the daemon
        // refused as unauthorized — so it can be retyped where it was typed. On the page otherwise,
        // and the prompt closes: a dialog left open over a refusal a password cannot fix is theatre.
        if (password !== undefined && (minting || refused.code === 'fleet_login_unauthorized')) {
          setUnlockFailure(operatorUnlockFailure(error));
        } else {
          setRefusal(refused.detail);
          setPending(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [authority, connection.daemonId, held, now],
  );

  const begin = useCallback(
    (row: AccountRowView): void => {
      if (fleetApplyNeedsPassword(authority) && usableUnlock(held, connection.daemonId, now()) === undefined) {
        setPending(row);
        setUnlockFailure(null);
        return;
      }
      void run(row, undefined);
    },
    [authority, connection.daemonId, held, now, run],
  );

  const submit = useCallback(
    (flow: HarnessLoginFlow, code: string): void => {
      const bound = clientRef.current;
      if (bound === null) return;
      setBusy(true);
      void submitHarnessLoginCode(bound, flow.flowId, code, unlock)
        .then(
          outcome => {
            if (outcome.outcome === 'accepted')
              setFlows(current => ({ ...current, [outcome.flow.accountId]: outcome.flow }));
            else setRefusal(outcome.reason);
          },
          (error: unknown) => setRefusal(fleetRefusal(error).detail),
        )
        .finally(() => setBusy(false));
    },
    [unlock],
  );

  const cancel = useCallback(
    (flow: HarnessLoginFlow): void => {
      const bound = clientRef.current;
      if (bound === null) return;
      setBusy(true);
      void cancelHarnessLogin(bound, flow.flowId, unlock)
        .then(
          next => setFlows(current => ({ ...current, [next.accountId]: next })),
          (error: unknown) => setRefusal(fleetRefusal(error).detail),
        )
        .finally(() => setBusy(false));
    },
    [unlock],
  );

  /**
   * Ask one account's credential to renew itself.
   *
   * IT SPENDS THE SAME PASSWORD THE SAME WAY, through the same two uses `run` describes: this rewrites
   * a credential in a home on that machine, so a governed caller owes the same confirmation. What it
   * does NOT do is open a browser, publish a URL or start a flow — so nothing here touches `flows`,
   * and there is nothing to poll.
   *
   * IT RE-READS AFTERWARDS, ALWAYS, including when the renewal refused. The row's credential sentence
   * and its own offer are both derived from a reading this call may have moved in either direction —
   * a rotation the provider refuses leaves the home with NOTHING — so leaving the old roster on screen
   * would show a renewable account that is now signed out.
   */
  const renew = useCallback(
    async (row: AccountRowView, password: string | undefined): Promise<void> => {
      const bound = clientRef.current;
      if (bound === null) return;
      setBusy(true);
      setRefusal(null);
      setUnlockFailure(null);
      let token = usableUnlock(held, connection.daemonId, now());
      let minting = authority.kind === 'locked' && token === undefined && password !== undefined;
      try {
        if (minting) {
          const minted = await unlockGrants(bound, String(password));
          setHeld({ daemonId: connection.daemonId, token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) });
          token = minted.token;
          minting = false;
        }
        const outcome = await renewFleetCredential(
          bound,
          {
            accountId: row.accountId,
            ...(password === undefined || !fleetApplyNeedsPassword(authority) ? {} : { operatorPassword: password }),
          },
          token,
        );
        setPendingRenewal(null);
        // Re-read FIRST and say why SECOND, in that order. `load` clears the refusal on a good read —
        // correctly, since it is the roster's own error slot — so a sentence set before it would be
        // wiped by the very read that is supposed to accompany it.
        await load(bound, token);
        // EVERY ENDING IS A VALUE, so a refusal arrives as a `200` with a reason rather than as a throw.
        // A renewal that correctly declined to spend a rotating refresh token is not an error, and the
        // host's own sentence is the one worth showing — it names which of the four nothings happened.
        if (outcome.status !== 'renewed' && outcome.reason !== undefined) setRefusal(outcome.reason);
      } catch (error) {
        const refused = fleetRefusal(error);
        if (password !== undefined && (minting || refused.code === 'fleet_login_unauthorized')) {
          setUnlockFailure(operatorUnlockFailure(error));
        } else {
          setRefusal(refused.detail);
          setPendingRenewal(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [authority, connection.daemonId, held, load, now],
  );

  const beginRenewal = useCallback(
    (row: AccountRowView): void => {
      if (fleetApplyNeedsPassword(authority) && usableUnlock(held, connection.daemonId, now()) === undefined) {
        setPendingRenewal(row);
        setUnlockFailure(null);
        return;
      }
      void renew(row, undefined);
    },
    [authority, connection.daemonId, held, now, renew],
  );

  const reRead = useCallback((): void => {
    const bound = clientRef.current;
    if (bound === null) return;
    void load(bound, unlock);
  }, [load, unlock]);

  /**
   * Ask the host to collect the free evidence NOW.
   *
   * The only collecting call on this page, and it is behind this one control. It spends nothing: one
   * read-only provider status GET per credential on the host, which is the same request that host's
   * quota pass already makes every minute. No agent is started and no model is asked anything.
   */
  const check = useCallback((): void => {
    const bound = clientRef.current;
    if (bound === null) return;
    setHealthStatus('loading');
    setHealthError(null);
    void checkAccountPickerHealth(bound).then(
      catalog => {
        setRead(current => ({ ...current, health: catalog.health }));
        setChecked(catalog.health.size);
        setHealthStatus(catalog.error === null ? 'ready' : 'error');
        setHealthError(catalog.error);
      },
      (error: unknown) => {
        setHealthStatus('error');
        setHealthError(fleetRefusal(error).detail);
      },
    );
  }, []);

  const instant = now();
  const state: AccountsReadState =
    read.readiness.kind === 'ready'
      ? { kind: 'ready', roster: accountsRoster(read.readiness.readiness, read.health, usage ?? read.feed, instant) }
      : read.readiness;

  return (
    <div className={className}>
      <AccountsSurface
        daemonId={connection.daemonId}
        state={state}
        flows={flows}
        refusal={refusal}
        busy={busy}
        mayStart={authority.kind !== 'refused' && authority.kind !== 'unreadable'}
        healthCheck={{ status: healthStatus, error: healthError, checked, onCheck: check }}
        onAddAccount={onAddAccount}
        onReRead={reRead}
        onStart={begin}
        onRenew={beginRenewal}
        onSubmitCode={submit}
        onCancel={cancel}
      />
      <OperatorUnlockDialog
        open={pending !== null}
        holding={authority.kind === 'locked'}
        busy={busy}
        failure={unlockFailure}
        submitLabel="Start sign-in"
        purpose={
          pending === null
            ? ''
            : `Signing “${pending.label}” in re-points every agent that runs on this account, so this machine asks for its operator password once, against this one sign-in.`
        }
        onSubmit={password => {
          if (pending !== null) void run(pending, password);
        }}
        onClose={() => {
          setPending(null);
          setUnlockFailure(null);
        }}
      />
      {/* Its OWN prompt, saying what a renewal is rather than borrowing the sign-in's sentence. The two
          acts spend the same password against the same budget and mean different things to a person:
          one re-points every agent on this account at whichever provider account they approve, and the
          other rotates the credential already there. Somebody deciding whether to type a password is
          entitled to be told which. */}
      <OperatorUnlockDialog
        open={pendingRenewal !== null}
        holding={authority.kind === 'locked'}
        busy={busy}
        failure={unlockFailure}
        submitLabel="Renew now"
        purpose={
          pendingRenewal === null
            ? ''
            : `Renewing “${pendingRenewal.label}” rewrites this account’s credential on that machine — no browser, and nobody is signed in as anybody else — so it asks for the operator password once, against this one renewal.`
        }
        onSubmit={password => {
          if (pendingRenewal !== null) void renew(pendingRenewal, password);
        }}
        onClose={() => {
          setPendingRenewal(null);
          setUnlockFailure(null);
        }}
      />
    </div>
  );
}

/**
 * The mounted settings panel, ready for the composition root's `daemonSettingsTabs` seam.
 *
 * `parentId` is declared HERE and not in `App.tsx`, for the same reason the id and the label are: the
 * relation between this panel and Fleet is a fact about what these two panels are, and a composition
 * root that also owned it could put the child somewhere the relation does not hold.
 *
 * `openPanel` is what makes "Add an account" work now that there is no address to link to. It moves
 * to Fleet — the panel this one hangs off — inside the same frame, on the same daemon.
 */
export const accountsSettingsTab = (createClient: FleetClientFactory) =>
  ({
    id: 'accounts',
    parentId: 'fleet',
    label: 'Accounts',
    description: 'Each account’s login, what its provider last said, and when that was checked.',
    Surface: ({
      connection,
      openPanel,
    }: {
      readonly connection: DaemonConnection;
      readonly openPanel: (id: string) => void;
    }) => <AccountsPage connection={connection} createClient={createClient} onAddAccount={() => openPanel('fleet')} />,
  }) as const;
