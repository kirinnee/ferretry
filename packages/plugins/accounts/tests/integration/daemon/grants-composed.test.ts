/**
 * THE COMPOSED ACCOUNTS PROVIDES THE VAULT ITS GRANTS (`input.saved:saved` → `grants()`, docs/input-requests.md): the real
 * daemon half (`daemon/index.ts`, `rules.ts`) booted over the kernel's test host, read the way the Vault reads it, by a
 * plugin that takes the hook. Nothing is approved, so no grant is in force; what is proved is that the production
 * composition hands the Vault ONE source whose rules and plan lines are Accounts' own, and that it hears of every script.
 */
import { afterEach, describe, it } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { InputSavedLogins, type SavedLoginsProvider } from '@ferretry/core-vault/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import accounts from '../../../daemon/index.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

/** What the Vault is to the hook: the one plugin that looks the provider up. */
let looked: () => SavedLoginsProvider | undefined = () => undefined;
const reader = implementDaemon(
  definePlugin({
    id: 'vault',
    title: 'Hook reader',
    version: '1.0.0',
    api: 5,
    core: true,
    kinds: [],
    hooks: { offers: [{ hook: InputSavedLogins }] },
  }),
  {
    build: ctx => {
      looked = () => {
        const found = ctx.hooks.provider(InputSavedLogins, 'saved');
        return found === 'unavailable' ? undefined : found;
      };
      return {};
    },
  },
);

async function booted() {
  const host = await testHost({
    plugins: [accounts, reader],
    fakes: { vault: new FakeVault(), asks: new FakeAsks(), gate: new FakeGate(), sealed: new FakeSealedDocuments() },
  });
  hosts.push(host);
  return host;
}

describe('the composed Accounts hands the Vault what the owner approved in advance', () => {
  it('I131 should provide one grant source, enabled, with nothing in force before anything is approved', async () => {
    await booted();

    const offered = looked()?.grants?.() as {
      enabled(): boolean;
      of(session: string): readonly unknown[];
      scriptedOrigins(): { hosts: ReadonlyMap<string, number>; running?: boolean };
      running?(): () => void;
      scriptedOn?(host: string | undefined): void;
    };

    should(offered.enabled()).equal(true);
    should(offered.of('mvv6b4qw-49d0158d')).eql([]);
  });

  it('should hear of an agent script and a page script, so no standing rule fills past either', async () => {
    await booted();
    const offered = looked()?.grants?.() as {
      scriptedOrigins(): { hosts: ReadonlyMap<string, number>; running?: boolean };
      running(): () => void;
      scriptedOn(host: string | undefined): void;
    };

    const end = offered.running();
    should(offered.scriptedOrigins().running).equal(true);
    end();
    offered.scriptedOn('github.com');

    should(offered.scriptedOrigins().running).equal(undefined);
    should(offered.scriptedOrigins().hosts.has('github.com')).equal(true);
  });
});
