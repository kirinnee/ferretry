/** The Standing rule tab on a sign-in: there only where the machine has rules, and it shows that sign-in's own rule. */
import { afterEach, describe, expect, it } from 'bun:test';
import { AccountsSurface } from '../../../src/features/accounts/accounts-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { answer, SI_GITHUB } from '../../support/accounts-fixtures.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { ruleClient } from '../../support/sign-in-rule-client.ts';
import { pageRule, ruleList } from '../../support/sign-in-rule-fixtures.ts';

const CONNECTION = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const site = async (withRules: boolean) => {
  const rules = ruleClient({ list: ruleList({ rules: [pageRule()] }) });
  const accounts = answer({});
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) =>
      path.startsWith('/v1/sign-in-rules')
        ? await rules.client.request(path, schema as never, init)
        : schema.parse(
            accounts({
              path,
              method: init?.method ?? 'GET',
              body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            }),
          ),
  };
  const view = await mount(
    <AccountsSurface
      connection={CONNECTION}
      createClient={async () => client as never}
      {...(withRules ? { rules: { askPasskey: async () => true } } : {})}
    />,
  );
  mounted.push(view);
  await settle();
  await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  await click(q('[data-accounts-row="GITHUB"] button'));
  await click(q('[data-accounts-tab="sites"]'));
  await click(q(`[data-accounts-signin="${SI_GITHUB}"] button`));
  return { q, rules };
};

describe('a sign-in’s Standing rule tab', () => {
  it('lists the sign-in’s own rule from the secrets-gated routes', async () => {
    const screen = await site(true);
    await click(screen.q('[data-accounts-tab="rule"]'));
    await settle();

    expect(screen.q('[data-rule]')?.getAttribute('data-rule')).toBe(pageRule().id);
    expect(screen.rules.keys()).toContain('GET /v1/sign-in-rules');
  });

  it('is not there on a machine without rules', async () => {
    const screen = await site(false);

    expect(screen.q('[data-accounts-tab="rule"]')).toBeNull();
  });
});
