import {
  deviceStanding,
  FakeGate,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
} from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { Tabs } from './tabs.ts';

/** The ferrets this machine knows of: `f1` and `f2`. */
const FERRETS = { get: async (id: string) => (id === 'f1' || id === 'f2' ? { name: id } : undefined) };

/**
 * The browsers daemon half exactly as `build` composes it, over a fake agent browser (real tabs, nothing started), with
 * "What agents may control" fully on. Gate's stand-in admission stamps the standing a real daemon gives: a paired device its own device standing, the ferret `as`
 * names for a ferret's own (privileged local) arrival, the owner for everything else.
 */
export async function handoverHost(): Promise<{
  readonly host: TestHost;
  readonly tabs: Tabs;
  /** The caller for a ferret's own credential (MCP tool calls and a ferret's REST calls). */
  readonly as: (id: string) => { readonly as: ReturnType<typeof ferret> };
}> {
  const tabs = new Tabs();
  let calling = 'f1' as FerretId;
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged
      ? ferretStanding(calling)
      : request.principal?.kind === 'device'
        ? deviceStanding(String(request.principal.holder))
        : ownerStanding(),
  );
  const host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, agentControl: { allows: async () => true } },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate,
  });
  return {
    host,
    tabs,
    as: id => {
      calling = id as FerretId;
      return { as: ferret(id) };
    },
  };
}
