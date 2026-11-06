/** After a hand-tapped sign-in the card offers a standing rule: only for a machine that has the rules, and never after the one-tap. */
import { afterEach, describe, expect, it } from 'bun:test';
import type { InputRequest } from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { InputCardHost } from '../../../src/features/input-request/input-card-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { fieldsOf } from '../../../src/lib/input-card.ts';
import type { RuleClient } from '../../../src/lib/sign-in-rules.ts';
import { createAppStore, DaemonClientProvider, StoreProvider } from '../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type Call, fakeClient, NOW, offer, primaryOffer, saved, withSaved } from '../../support/input-fixtures.ts';
import { type RuleWorld, ruleClient } from '../../support/sign-in-rule-client.ts';
import { SITE_SIGN_IN } from '../../support/sign-in-rule-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const two = () => [
  offer({ id: 'WORK', label: 'Work', username: 'kirin@work', signIn: 'si_0123456789abcdef' }),
  offer({ id: 'HOME', label: 'Home', username: 'kirin@home', signIn: SITE_SIGN_IN }),
];

const delivered = (call: Call) =>
  call.path === '/v1/accounts/defaults'
    ? { defaults: {} }
    : {
        id: 'ab'.repeat(16),
        deliveryId: (call.body as { deliveryId?: string }).deliveryId,
        state: 'delivered',
        submitted: true,
      };

type Hold = readonly [boolean, string | undefined];

const card = async (
  value: InputRequest,
  ruleOffer: boolean,
  options: { readonly holds?: Hold[]; readonly world?: RuleWorld } = {},
) => {
  const fake = fakeClient(delivered);
  const rules = ruleClient(options.world);
  const route = (path: string): RuleClient =>
    path.startsWith('/v1/sign-in-rules') || path === '/v1/accounts' ? rules.client : fake.client;
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
      {...(options.holds === undefined
        ? {}
        : { onHold: (holding: boolean, settled?: string) => options.holds?.push([holding, settled]) })}
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
  const host = async (store?: Awaited<ReturnType<typeof createAppStore>>) => {
    const rules = ruleClient();
    const value = withSaved(saved({ offers: two() }), { expiresAt: '2099-01-01T00:00:00.000Z' });
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        if (path.startsWith('/v1/sign-in-rules') || path === '/v1/accounts')
          return await rules.client.request(path, schema as never, init);
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

  it('offers a rule after a hand-tap', async () => {
    const view = await host();
    expect(view.container.querySelector('[data-rule-offer-button]')).not.toBeNull();
  });

  it('asks the app’s own passkey prompt for the rule the owner approves', async () => {
    const store = await withStore();
    const view = await host(store);
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

describe('the card’s hold on the view it is drawn in (#B147)', () => {
  it('holds while the Send is on its way, then lets go with its words when nothing follows', async () => {
    const holds: Hold[] = [];
    const view = await card(withSaved(saved({ offers: [primaryOffer({ why: 'site' })] })), true, { holds });
    expect(holds).toEqual([]);
    await click(view.container.querySelector('[data-variant="primary"][data-input-offer]'));
    await settle();

    expect(holds[0]).toEqual([true, undefined]);
    expect(holds.at(-1)).toEqual([false, 'Sent to %terminal:deploy.']);
  });

  it('keeps holding while the standing-rule offer is on screen', async () => {
    const holds: Hold[] = [];
    const view = await card(withSaved(saved({ offers: two() })), true, { holds });
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();

    expect(view.container.querySelector('[data-rule-offer-button]')).not.toBeNull();
    expect(holds.at(-1)).toEqual([true, undefined]);
  });

  it('lets go once the daemon says this sign-in has no rule to offer yet', async () => {
    const holds: Hold[] = [];
    const view = await card(withSaved(saved({ offers: two() })), true, {
      holds,
      world: { eligibility: { signIn: SITE_SIGN_IN, eligible: false, because: 'no-history' } },
    });
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();

    expect(view.container.querySelector('[data-rule-offer-button]')).toBeNull();
    expect(holds.at(-1)).toEqual([false, 'Sent to %terminal:deploy.']);
  });

  it('lets go without words when the Send failed, so the view is not closed on a sentence that is not true', async () => {
    const holds: Hold[] = [];
    const fake = fakeClient(() => {
      throw Object.assign(new Error('the request ended'), { status: 410, code: 'gone' });
    });
    const value = withSaved(saved({ offers: [primaryOffer({ why: 'site' })] }));
    const view = await mount(
      <InputCard
        agentName="Hadi"
        client={fake.client}
        fields={fieldsOf(value)}
        now={NOW}
        onDone={() => undefined}
        onHold={(holding, settled) => holds.push([holding, settled])}
        request={value}
      />,
    );
    mounted.push(view);
    await click(view.container.querySelector('[data-variant="primary"][data-input-offer]'));
    await settle();

    expect(holds).toEqual([
      [true, undefined],
      [false, undefined],
    ]);
  });
});

describe('finishing a follow-up lets go of the view (#B147)', () => {
  const PROJECT = { id: 'p_ferretry', name: 'ferretry' };
  const pick = () => withSaved(saved({ match: 'app.clickup.com', project: PROJECT, offers: two() }));
  const flush = async () => {
    for (let tries = 0; tries < 4; tries += 1) await settle();
  };
  const finishRule = async (view: Mounted) => {
    await click(view.container.querySelector('[data-rule-offer-button]'));
    await flush();
    await click(view.container.querySelector('[data-rule-approve]'));
    await flush();
  };

  it('lets go once "Always use for <project>" is saved', async () => {
    const holds: Hold[] = [];
    const view = await card(pick(), false, { holds });
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();
    expect(holds.at(-1)).toEqual([true, undefined]);

    await click(view.container.querySelector('[data-input-always-button]'));
    await flush();

    expect(view.container.querySelector('[data-input-always-saved]')).not.toBeNull();
    expect(holds.at(-1)).toEqual([false, 'Sent to %terminal:deploy.']);
  });

  it('keeps holding while a write for the default fails, and while the button is still there', async () => {
    const holds: Hold[] = [];
    const fake = fakeClient(call => {
      if (call.path === '/v1/accounts/defaults') throw new Error('the owner has to confirm this on the machine');
      return delivered(call);
    });
    const value = pick();
    const view = await mount(
      <InputCard
        agentName="Hadi"
        client={fake.client}
        fields={fieldsOf(value)}
        now={NOW}
        onDone={() => undefined}
        onHold={(holding, settled) => holds.push([holding, settled])}
        request={value}
      />,
    );
    mounted.push(view);
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();
    await click(view.container.querySelector('[data-input-always-button]'));
    await flush();

    expect(view.container.querySelector('[data-input-always-failure]')).not.toBeNull();
    expect(holds.at(-1)).toEqual([true, undefined]);
  });

  it('lets go once the standing rule is approved', async () => {
    const holds: Hold[] = [];
    const view = await card(withSaved(saved({ offers: two() })), true, { holds });
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();
    expect(holds.at(-1)).toEqual([true, undefined]);

    await finishRule(view);

    expect(view.container.querySelector('[data-rule-offer-saved]')).not.toBeNull();
    expect(holds.at(-1)).toEqual([false, 'Sent to %terminal:deploy.']);
  });

  it('keeps holding until EVERY offered follow-up is done', async () => {
    const holds: Hold[] = [];
    const view = await card(pick(), true, { holds });
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await settle();

    await click(view.container.querySelector('[data-input-always-button]'));
    await flush();
    expect(view.container.querySelector('[data-input-always-saved]')).not.toBeNull();
    expect(holds.at(-1)).toEqual([true, undefined]);

    await finishRule(view);
    expect(holds.at(-1)).toEqual([false, 'Sent to %terminal:deploy.']);
  });
});
