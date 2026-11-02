/** After a hand-tapped sign-in the card offers a standing rule: only for a machine that has the rules, and never after the one-tap. */
import { afterEach, describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES, type InputRequest } from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { InputCardHost } from '../../../src/features/input-request/input-card-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { fieldsOf } from '../../../src/lib/input-card.ts';
import type { RuleClient } from '../../../src/lib/sign-in-rules.ts';
import { createAppStore, DaemonClientProvider, StoreProvider } from '../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { healthOf } from '../../support/health.ts';
import { type Call, fakeClient, NOW, offer, primaryOffer, saved, withSaved } from '../../support/input-fixtures.ts';
import { ruleClient } from '../../support/sign-in-rule-client.ts';
import { SITE_SIGN_IN } from '../../support/sign-in-rule-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const two = () => [
  offer({ id: 'WORK', label: 'Work', username: 'kirin@work', signIn: 'si_0123456789abcdef' }),
  offer({ id: 'HOME', label: 'Home', username: 'kirin@home', signIn: SITE_SIGN_IN }),
];

const delivered = (call: Call) => ({
  id: 'ab'.repeat(16),
  deliveryId: (call.body as { deliveryId?: string }).deliveryId,
  state: 'delivered',
  submitted: true,
});

const card = async (value: InputRequest, ruleOffer: boolean) => {
  const fake = fakeClient(delivered);
  const rules = ruleClient();
  const route = (path: string): RuleClient => (path.startsWith('/v1/sign-in-rules') ? rules.client : fake.client);
  const client = {
    request: async (path: string, schema: never, init?: RequestInit) => await route(path).request(path, schema, init),
  } as never;
  const view = await mount(
    <InputCard
      agentName="Hadi"
      client={client}
      fields={fieldsOf(value)}
      now={NOW}
      onDone={() => undefined}
      request={value}
      {...(ruleOffer ? { ruleOffer: { askPasskey: async () => true } } : {})}
    />,
  );
  mounted.push(view);
  return view;
};

describe('the standing-rule offer on the input card', () => {
  it('follows a hand-tapped sign-in, naming the rule it would make', async () => {
    const view = await card(withSaved(saved({ offers: two() })), true);
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();

    expect(view.container.querySelector('[data-input-settled]')).not.toBeNull();
    expect(view.container.querySelector('[data-rule-offer-button]')).not.toBeNull();
  });

  it('is not offered after the daemon’s own one-tap', async () => {
    const view = await card(withSaved(saved({ offers: [primaryOffer({ why: 'site' })] })), true);
    await click(view.container.querySelector('[data-variant="primary"][data-input-offer]'));
    await settle();

    expect(view.container.querySelector('[data-input-settled]')).not.toBeNull();
    expect(view.container.querySelector('[data-rule-offer-button]')).toBeNull();
  });

  it('is not offered where the machine has no rules', async () => {
    const view = await card(withSaved(saved({ offers: two() })), false);
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();

    expect(view.container.querySelector('[data-input-settled]')).not.toBeNull();
    expect(view.container.querySelector('[data-rule-offer-button]')).toBeNull();
  });
});

describe('the input card host', () => {
  const host = async (features: string[], store?: Awaited<ReturnType<typeof createAppStore>>) => {
    const rules = ruleClient();
    const value = withSaved(saved({ offers: two() }), { expiresAt: '2099-01-01T00:00:00.000Z' });
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        if (path.startsWith('/v1/sign-in-rules') || path === '/v1/accounts')
          return await rules.client.request(path, schema as never, init);
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', features));
        if (path.endsWith('/deliver'))
          return schema.parse(delivered({ path, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) }));
        return schema.parse({ requests: [value] });
      },
    };
    const tree = (
      <DaemonClientProvider client={async () => client as never}>
        <InputCardHost
          connection={daemonConnection({
            daemonId: 'workshop',
            baseUrl: 'https://workshop.example.test',
            deviceId: 't1',
          })}
          item={{ input: { requestId: 'ab'.repeat(16) } }}
          sessionId="sess-1"
        />
      </DaemonClientProvider>
    );
    const view = await mount(store === undefined ? tree : <StoreProvider store={store}>{tree}</StoreProvider>);
    mounted.push(view);
    for (let tries = 0; tries < 6; tries += 1) await settle();
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    for (let tries = 0; tries < 4; tries += 1) await settle();
    return view;
  };

  const withStore = async () =>
    await createAppStore({
      repository: { load: async () => null, save: async () => undefined },
      connectClient: async () => ({}) as never,
      fetcher: async () => Response.json({}),
    });

  it('offers a rule after a hand-tap on a machine that reports sign-in rules', async () => {
    const view = await host([DAEMON_FEATURES.signInRules]);
    expect(view.container.querySelector('[data-rule-offer-button]')).not.toBeNull();
  });

  it('offers none on a machine that does not', async () => {
    const view = await host(['messages.tail.1']);
    expect(view.container.querySelector('[data-input-settled]')).not.toBeNull();
    expect(view.container.querySelector('[data-rule-offer-button]')).toBeNull();
  });

  it('asks the app’s own passkey prompt for the rule the owner approves', async () => {
    const store = await withStore();
    const view = await host([DAEMON_FEATURES.signInRules], store);
    await click(view.container.querySelector('[data-rule-offer-button]'));
    for (let tries = 0; tries < 4; tries += 1) await settle();
    await click(view.container.querySelector('[data-rule-approve]'));
    for (let tries = 0; tries < 4; tries += 1) await settle();

    expect(store.stepUp.snapshot()?.words?.does).toContain('for any ferret, without asking');
    expect(store.stepUp.snapshot()?.words?.rows.some(row => row.label === 'Until')).toBe(true);
    store.stepUp.dismiss();
    for (let tries = 0; tries < 4; tries += 1) await settle();
  });
});
