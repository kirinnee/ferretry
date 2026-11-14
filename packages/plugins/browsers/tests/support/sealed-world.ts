import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type Needer } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import { BrowsersPort, type BrowsersCopyApi } from '../../contract/port.ts';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { Tabs } from './tabs.ts';

/**
 * The Browsers daemon half built exactly as production builds it, over a fake browser, with an agent credential (ferret f1) and
 * a person's told apart by the standing Gate stamps. Fake values only; never a real credential.
 */
export const SOURCE = 'https://keys.example.test';
export const ACT = '/v1/sessions/f1/browser';
export const asAgent = { as: ferret('f1') };
export const LIVE = (): number => Date.now() + 60_000;

const ALL_ON: AgentControlReader = { allows: async () => true };
const FERRETS = { get: async (id: string) => (id === 'f1' || id === 'f2' ? { name: id } : undefined) };
const calling = 'f1' as FerretId;
const needer = (id: string): Needer => ({
  id,
  permissions: { network: [], spawn: [], secrets: [] } as unknown as Needer['permissions'],
  ownedSecretReferences: () => new Set(),
});

export interface SealedWorld {
  readonly host: TestHost;
  readonly tabs: Tabs;
  readonly copy: BrowsersCopyApi;
}

export async function built(): Promise<SealedWorld> {
  const tabs = new Tabs();
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
  );
  const host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, agentControl: ALL_ON },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate,
  });
  const copy = host.provided(BrowsersPort, needer('accounts')).copy;
  if (copy === undefined) throw new Error('Accounts should be handed the copy reach');
  return { host, tabs, copy };
}

/** A ferret with a page named `keys` on the source site, viewed by its session, and a live copy `token` that sits there. */
export async function sealedWorld(sentinel: string): Promise<SealedWorld> {
  const world = await built();
  const { host, tabs, copy } = world;
  await host.tool('browser_open', { name: 'keys', url: `${SOURCE}/new?token=${sentinel}` }, { as: ferret('f1') });
  await host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, as: ferret('f1') });
  tabs.documentHost = 'keys.example.test';
  tabs.pages = tabs.pages.map(page => (page.id === 'p1' ? { ...page, title: `Your key ${sentinel}` } : page));
  copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], LIVE);
  return world;
}
