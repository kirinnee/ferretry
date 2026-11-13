import { afterEach, describe, expect, test } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { Tabs } from '../support/tabs.ts';

/**
 * FAKE material only. The reviewer's re-check: a title that carries a pairing fragment whose code has whitespace
 * inside it must leave no piece of the code — and no fingerprint — in what `browser_list` publishes.
 */
const FINGERPRINT = `fy_daemon_${'A'.repeat(43)}`;
let host: TestHost | undefined;
afterEach(async () => {
  await host?.stop();
  host = undefined;
});

async function listedTitle(title: string): Promise<string> {
  const tabs = new Tabs();
  const half = implementDaemon(daemon.manifest, {
    build: context => buildBrowsers(context, { launcher: { launch: async () => tabs.automation } }),
  });
  host = await testHost({
    plugins: [half],
    uses: { ferrets: { get: async () => ({ name: 'f1' }) }, agentControl: { allows: async () => true } },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate: new StandInAdmission(request =>
      request.arrival.kind === 'local' && request.arrival.privileged
        ? ferretStanding('f1' as FerretId)
        : ownerStanding(),
    ),
  });
  await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, { as: ferret('f1') });
  tabs.pages = tabs.pages.map(page => (page.id === 'p1' ? { ...page, title } : page));
  return JSON.stringify(await host.tool('browser_list', {}, { as: ferret('f1') }));
}

describe('browser_list never publishes a whitespace-split code or its fragment', () => {
  const fragment = (code: string) => `#v1;url=https%3A%2F%2Fexample.test;code=${code};fp=${FINGERPRINT}`;

  test('the reviewer’s spaced code (FA KE FA KE) and the fingerprint are gone from the title', async () => {
    const listed = await listedTitle(`Pair ${fragment('FA KE FA KE')}`);
    expect(listed).not.toContain('KE FA KE');
    expect(listed).not.toContain('FA KE');
    expect(listed).not.toContain(FINGERPRINT);
    expect(listed).toContain('Pair #[pairing link hidden]');
  });

  test('tabs, mixed case and ordinary text after the fragment (which stays)', async () => {
    const listed = await listedTitle(`Pair ${fragment('fA\tkE  Fa\tkE')} then go home`);
    expect(listed).not.toContain('kE');
    expect(listed).not.toContain(FINGERPRINT);
    expect(listed).toContain('Pair #[pairing link hidden] then go home');
  });

  test('a spaced code at the very end of the title', async () => {
    const listed = await listedTitle('Pair #v1;url=x;code=FA KE FA KE');
    expect(listed).not.toContain('KE FA KE');
    expect(listed).not.toContain('FA KE');
  });
});
