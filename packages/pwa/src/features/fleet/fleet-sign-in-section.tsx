/**
 * THE CONTROL WHERE THE DEAD END WAS.
 *
 * Before this, a browser met the words `quota auth!` with nothing to press: detection existed — the fleet
 * feed carries `authOk`, and the daemon composes the remedy "run `fy fleet login` for this account" — but
 * the remedy was a command on a machine the reader was not sitting at. This section is the affordance,
 * and it is deliberately HERE rather than inside the quota readout: that readout is one component the chat
 * header, the fleet table, the session card and the folder sidebar all render, so a control inside it
 * would appear on four screens with four different amounts of context. `docs/design/harness-login.md` §7
 * says so in those words.
 *
 * ## ONE SECTION, TWO FLOWS, NO THIRD ONE
 *
 * It dispatches on the harness and renders that harness's own panel. There is no generic panel and no
 * shared step union: `claude-login-panel.tsx` has a paste field and `codex-login-panel.tsx` has a device
 * code, because those are two different ceremonies with two different shapes.
 *
 * ## WHAT IT SAYS WHEN THERE IS NOTHING TO PRESS
 *
 * An account whose credential comes from a token file, the environment or the configuration gets NO
 * sign-in control — offering one would be offering a control that cannot succeed — and instead gets the
 * sentence naming where its credential does come from. So "configured" and "broken" are distinguishable,
 * which they were not before.
 *
 * ## ONE PROMPT, THE SHARED ONE
 *
 * The operator password is asked for by `OperatorUnlockDialog` and nowhere else. `docs/grants.md:259-272`
 * records what happened the last time a fleet capability grew its own inline password field inside a card:
 * the shape on screen said *authorisation for this one action* while the code said *unlock this machine*.
 * The typed value is a parameter for the whole of its life — it is minted into an unlock and sent as the
 * per-sign-in confirmation, and it is never held in this component's state.
 *
 * ## USAGE IS SHOWN, AND NEVER INVENTED
 *
 * Each account carries its 5-hour and weekly figures from the daemon's own cached feed, with the word
 * "used" attached so the direction cannot be misread. An account nothing measured says "unknown" — not
 * `0%`, and not an empty bar, which reads as "none used" and is the opposite of the truth.
 */

import { CircleAlert, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FleetLoginAccount,
  FleetLoginIdentity,
  FleetLoginReadiness,
  FleetPermissions,
  HarnessLoginFlow,
  UsageAccountView,
} from '@ferretry/protocol';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type HeldUnlock, type OperatorUnlockFailure, operatorUnlockFailure, usableUnlock } from '../../lib/grants.ts';
import { EYEBROW } from '../../shell/panel-typography.tsx';
import { Button } from '../../shell/primitives.tsx';
import { OperatorUnlockDialog } from '../settings/operator-unlock-dialog.tsx';
import { unlockGrants } from '../settings/grants-api.ts';
import { ClaudeLoginPanel } from './claude-login-panel.tsx';
import { CodexLoginPanel } from './codex-login-panel.tsx';
import { type FleetClient, fleetRefusal, readFleetPermissions } from './fleet-api.ts';
import { fleetApplyAuthority, fleetApplyNeedsPassword } from './fleet-change-model.ts';
import type { FleetClientFactory } from './fleet-configuration-surface.tsx';
import {
  cancelHarnessLogin,
  readDaemonUsageFeed,
  readFleetLoginReadiness,
  readHarnessLoginFlow,
  startHarnessLogin,
  submitHarnessLoginCode,
  usageByWrapper,
} from './harness-login-api.ts';
import { accountUsageReadout, credentialSourceCopy, credentialStateCopy, usageSummary } from './harness-login-model.ts';

/** How often a live sign-in is re-read. The person is acting somewhere this browser cannot see. */
const POLL_MS = 2_000;

export interface FleetSignInSectionProps {
  readonly connection: DaemonConnection;
  /** The connection-bound client. A fleet belongs to a machine, so nothing is cached at module scope. */
  readonly createClient: (connection: DaemonConnection) => Promise<FleetClient>;
  readonly now?: () => number;
  /**
   * The daemon's cached per-wrapper usage feed, as an OVERRIDE.
   *
   * Read from `GET /v1/usage` by default. That is a second READER and never a second measurement: one
   * daemon-wide collection sits behind the path, a scrape costs no provider call, and `usage-store.ts`
   * polls the same snapshot for session badges. Supplying it is how a test drives every readout state
   * — including the ones a real host would take days to reach.
   */
  readonly usage?: ReadonlyMap<string, UsageAccountView>;
  readonly pollMs?: number;
  className?: string;
}

/** Which flow belongs to which identity, so two provider accounts never share one screen's state. */
type FlowsByIdentity = Readonly<Record<string, HarnessLoginFlow>>;

const terminal = (flow: HarnessLoginFlow): boolean => flow.state === 'complete' || flow.state === 'failed';

/** The sign-in this section is holding a password prompt open for. */
interface PendingStart {
  readonly identity: string;
  readonly accountId: string;
  readonly label: string;
}

export function FleetSignInSection({
  connection,
  createClient,
  now = Date.now,
  usage,
  pollMs = POLL_MS,
  className,
}: FleetSignInSectionProps) {
  const [client, setClient] = useState<FleetClient | null>(null);
  const [readiness, setReadiness] = useState<FleetLoginReadiness | null>(null);
  const [permissions, setPermissions] = useState<FleetPermissions | null>(null);
  const [flows, setFlows] = useState<FlowsByIdentity>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<HeldUnlock | null>(null);
  const [pending, setPending] = useState<PendingStart | null>(null);
  const [unlockFailure, setUnlockFailure] = useState<OperatorUnlockFailure | null>(null);
  const [feed, setFeed] = useState<ReadonlyMap<string, UsageAccountView>>(new Map());
  /** Read inside the poll so a tick never closes over a stale client. */
  const clientRef = useRef<FleetClient | null>(null);
  clientRef.current = client;

  const authority = fleetApplyAuthority(permissions);
  const unlock = usableUnlock(held, connection.daemonId, now());

  const load = useCallback(async (bound: FleetClient, token: string | undefined): Promise<void> => {
    try {
      const [read, allowed] = await Promise.all([
        readFleetLoginReadiness(bound, token),
        readFleetPermissions(bound, token),
      ]);
      setReadiness(read);
      setPermissions(allowed);
      setRefusal(null);
      // A usage read that fails leaves the LAST feed alone and says nothing: a sign-in surface whose
      // quota column emptied because one scrape missed would read as "nothing is using anything",
      // which is the fabrication this whole readout exists to avoid.
      await readDaemonUsageFeed(bound).then(
        next => setFeed(usageByWrapper(next)),
        () => undefined,
      );
    } catch (error) {
      setReadiness(null);
      setRefusal(fleetRefusal(error).detail);
    }
  }, []);

  useEffect(() => {
    let live = true;
    setReadiness(null);
    setPermissions(null);
    setFlows({});
    setHeld(null);
    void createClient(connection).then(
      async bound => {
        if (!live) return;
        setClient(bound);
        await load(bound, undefined);
      },
      (error: unknown) => {
        if (!live) return;
        setRefusal(fleetRefusal(error).detail);
      },
    );
    return () => {
      live = false;
    };
  }, [connection, createClient, load]);

  /** Re-read every live sign-in until it settles. */
  useEffect(() => {
    const live = Object.values(flows).filter(flow => !terminal(flow));
    if (live.length === 0) return undefined;
    const handle = setInterval(() => {
      const bound = clientRef.current;
      if (bound === null) return;
      for (const flow of live) {
        void readHarnessLoginFlow(bound, flow.flowId, unlock).then(
          next => setFlows(current => ({ ...current, [next.identity]: next })),
          () => undefined,
        );
      }
    }, pollMs);
    return () => clearInterval(handle);
  }, [flows, pollMs, unlock]);

  /**
   * Start one sign-in, spending the typed password on every step that needs it.
   *
   * `locked` and `confirm` are not alternatives: a remote caller on a machine with an operator password is
   * locked AND owes a per-sign-in confirmation, so the value arrives once and is used twice. Prompting
   * twice for one click is the disease `docs/grants.md` records; it would come back here first.
   */
  const run = useCallback(
    async (start: PendingStart, password: string | undefined): Promise<void> => {
      const bound = clientRef.current;
      if (bound === null) return;
      setBusy(true);
      setRefusal(null);
      setUnlockFailure(null);
      let token = usableUnlock(held, connection.daemonId, now());
      // Tracked rather than inferred afterwards: a throw from the MINT is a password problem, and a throw
      // from the START is a sign-in problem, and the two are shown in two different places.
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
            accountId: start.accountId,
            // Sent only where the daemon SAID it would be asked for. A password on a request that does not
            // need one is a secret spent for nothing.
            ...(password === undefined || !fleetApplyNeedsPassword(authority) ? {} : { operatorPassword: password }),
          },
          token,
        );
        setFlows(current => ({ ...current, [flow.identity]: flow }));
        setPending(null);
      } catch (error) {
        const refused = fleetRefusal(error);
        // In the dialog when the password is what was rejected — the mint, or a start the daemon refused
        // as unauthorized — so it can be retyped where it was typed. On the panel otherwise, and the
        // prompt closes: a dialog left open over a refusal a password cannot fix is theatre.
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
    (identity: FleetLoginIdentity, account: FleetLoginAccount): void => {
      const start: PendingStart = {
        identity: identity.identity,
        accountId: account.accountId,
        label: account.displayName,
      };
      if (fleetApplyNeedsPassword(authority) && usableUnlock(held, connection.daemonId, now()) === undefined) {
        setPending(start);
        setUnlockFailure(null);
        return;
      }
      void run(start, undefined);
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
            if (outcome.outcome === 'accepted') setFlows(current => ({ ...current, [flow.identity]: outcome.flow }));
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
          next => setFlows(current => ({ ...current, [next.identity]: next })),
          (error: unknown) => setRefusal(fleetRefusal(error).detail),
        )
        .finally(() => setBusy(false));
    },
    [unlock],
  );

  const refresh = useCallback((): void => {
    const bound = clientRef.current;
    if (bound === null) return;
    void load(bound, unlock);
  }, [load, unlock]);

  return (
    <section
      data-fleet-sign-in=""
      data-fleet-sign-in-daemon-id={String(connection.daemonId)}
      aria-labelledby="fleet-sign-in-heading"
      className={cn('kt-panel overflow-hidden', className)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-panel py-3">
        <div className="min-w-0">
          <p className={EYEBROW} id="fleet-sign-in-heading">
            Provider sign-in
          </p>
          <p className="m-0 mt-1 text-ui leading-base text-muted">
            Which accounts on this host are signed in, how much of each one is spent, and where a credential comes from
            when there is nothing to sign in to.
          </p>
        </div>
        <Button type="button" variant="outline" className="ml-auto" onClick={refresh} disabled={busy}>
          <RefreshCw size={15} aria-hidden="true" />
          Re-read
        </Button>
      </header>

      <div className="space-y-4 p-panel">
        {refusal === null ? null : (
          <p
            role="alert"
            data-fleet-sign-in-refusal=""
            className="m-0 flex items-start gap-2 whitespace-pre-wrap rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          >
            <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            {refusal}
          </p>
        )}

        {readiness === null ? (
          <p className="m-0 text-ui leading-base text-muted">Reading which accounts need a sign-in…</p>
        ) : readiness.identities.length === 0 ? (
          <p className="m-0 rounded-control border border-dashed border-border px-3 py-2 text-ui text-muted">
            No account is published on this daemon, so there is nothing to sign in.
          </p>
        ) : (
          readiness.identities.map(identity => (
            <IdentityBlock
              key={identity.identity}
              identity={identity}
              flow={flows[identity.identity] ?? null}
              busy={busy}
              mayStart={authority.kind !== 'refused' && authority.kind !== 'unreadable'}
              nowMs={now()}
              usage={usage ?? feed}
              onStart={account => begin(identity, account)}
              onSubmitCode={(flow, code) => submit(flow, code)}
              onCancel={flow => cancel(flow)}
            />
          ))
        )}
      </div>

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
    </section>
  );
}

/** One provider login: its lanes, and either a sign-in or the reason there is none. */
function IdentityBlock({
  identity,
  flow,
  busy,
  mayStart,
  nowMs,
  usage,
  onStart,
  onSubmitCode,
  onCancel,
}: {
  readonly identity: FleetLoginIdentity;
  readonly flow: HarnessLoginFlow | null;
  readonly busy: boolean;
  readonly mayStart: boolean;
  readonly nowMs: number;
  readonly usage: ReadonlyMap<string, UsageAccountView> | undefined;
  readonly onStart: (account: FleetLoginAccount) => void;
  readonly onSubmitCode: (flow: HarnessLoginFlow, code: string) => void;
  readonly onCancel: (flow: HarnessLoginFlow) => void;
}) {
  // The lane a person is asked to approve is the interactive one, exactly as the daemon chooses it; the
  // others receive a copy. Naming a different lane here would offer a sign-in the daemon would run
  // somewhere else.
  const signInAccount = identity.accounts.find(account => account.login.applies);

  return (
    <section
      data-fleet-sign-in-identity={identity.identity}
      className="space-y-3 rounded-control border border-border bg-surface p-3"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <h3 className="m-0 text-ui font-semibold text-fg">{identity.identity}</h3>
        <span className="kt-badge" data-tone={identity.verdict === 'login' ? 'warn' : 'ok'}>
          {identity.verdict}
        </span>
        {identity.reason === undefined ? null : (
          <span className="text-meta leading-base text-muted">{identity.reason}</span>
        )}
      </div>

      <ul className="m-0 list-none space-y-2 p-0" aria-label={`${identity.identity} accounts`}>
        {identity.accounts.map(account => (
          <AccountRow key={account.accountId} account={account} nowMs={nowMs} usage={usage?.get(account.wrapper)} />
        ))}
      </ul>

      {signInAccount === undefined ? null : identity.kind === 'claude' ? (
        <ClaudeLoginPanel
          accountLabel={signInAccount.displayName}
          identity={identity.identity}
          memberCount={identity.accounts.length}
          flow={flow !== null && flow.harness === 'claude' ? flow : null}
          busy={busy || !mayStart}
          refusal={null}
          onStart={() => onStart(signInAccount)}
          onSubmitCode={code => {
            if (flow !== null) onSubmitCode(flow, code);
          }}
          onCancel={() => {
            if (flow !== null) onCancel(flow);
          }}
        />
      ) : (
        <CodexLoginPanel
          accountLabel={signInAccount.displayName}
          identity={identity.identity}
          memberCount={identity.accounts.length}
          flow={flow !== null && flow.harness === 'codex' ? flow : null}
          busy={busy || !mayStart}
          refusal={null}
          onStart={() => onStart(signInAccount)}
          onCancel={() => {
            if (flow !== null) onCancel(flow);
          }}
        />
      )}
    </section>
  );
}

/** One lane: its credential, its usage, and — when a sign-in does not apply — where its credential is from. */
function AccountRow({
  account,
  nowMs,
  usage,
}: {
  readonly account: FleetLoginAccount;
  readonly nowMs: number;
  readonly usage: UsageAccountView | undefined;
}) {
  const source = credentialSourceCopy(account.source);
  const readout = accountUsageReadout(usage, nowMs);
  return (
    <li
      data-fleet-sign-in-account={account.accountId}
      data-fleet-sign-in-applies={String(account.login.applies)}
      className="min-w-0 border-t border-border pt-2 first:border-t-0 first:pt-0"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <code className="font-mono text-meta text-fg">{account.wrapper}</code>
        <span className="text-meta text-muted">{credentialStateCopy(account.credential, nowMs)}</span>
        {account.login.applies ? null : (
          <span className="kt-badge" data-tone="accent" data-fleet-sign-in-source={account.source.source}>
            {source.label}
          </span>
        )}
      </div>
      <p className="m-0 mt-1 text-meta leading-base text-muted" data-fleet-sign-in-usage={readout.kind}>
        {usageSummary(readout)}
      </p>
      {account.login.applies ? null : (
        <p className="m-0 mt-1 text-meta leading-base text-muted" data-fleet-sign-in-source-detail="">
          {account.login.harnessReason ?? source.detail}
        </p>
      )}
    </li>
  );
}

/**
 * The mounted settings sub-tab, ready for the composition root's `daemonSettingsTabs` seam.
 *
 * A tab of its OWN, immediately beside Fleet, rather than a section inside the fleet cockpit. Two
 * reasons, and the second is the one that decided it:
 *
 * 1. A sign-in is a LIVE thing with a deadline and a poll. The cockpit holds a staged change, which is
 *    the opposite: reviewed once, applied once. One object holding both would have a polling loop inside
 *    the state that also holds a diff somebody is reading.
 * 2. The cockpit’s own suite pins every label relationship and live region it has, deliberately, and
 *    four of them render in one document in the harness. Adding a second heading and a second status
 *    region inside it would have meant loosening assertions that exist to catch exactly that.
 *
 * It is still where `docs/design/harness-login.md` §7 asks for it: beside the fleet surface, in the
 * settings page a person reaches from the `quota auth!` they just read, rather than inside a readout four
 * screens render.
 */
export const fleetSignInTab = (createClient: FleetClientFactory) =>
  ({
    id: 'fleet-sign-in',
    label: 'Sign-in',
    description: 'Which provider accounts on this host are signed in, and how much of each one is spent.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <FleetSignInSection connection={connection} createClient={createClient} />
    ),
  }) as const;
