/** The Standing rule tab on a sign-in: it shows that sign-in's own rule, read from the secrets-gated rule routes. */
import { afterEach, describe, expect, it } from 'bun:test';
import { AccountsSurface } from '../../../app/features/accounts/accounts-surface.tsx';
import { list, SI_GITHUB } from '../../support/app/accounts-fixtures.ts';
import { type Mounted, mount } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { ruleClient } from '../../support/app/sign-in-rule-client.ts';
import { pageRule, ruleList } from '../../support/app/sign-in-rule-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const site = async () => {
  const rules = ruleClient({ list: ruleList({ rules: [pageRule()] }) });
  const client = {
    call: async (route: string, init?: never) => {
      if (route === 'GET /v1/accounts') return list();
      if (route === 'GET /v1/accounts/look-alike') return { v: 1, groups: [] };
      return await rules.client.call(route, init);
    },
  } as never;
  const view = await mount(<AccountsSurface client={client} />);
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
  it('S105 lists the sign-in’s own rule from the secrets-gated routes', async () => {
    const screen = await site();
    await click(screen.q('[data-accounts-tab="rule"]'));
    await settle();

    expect(screen.q('[data-rule]')?.getAttribute('data-rule')).toBe(pageRule().id);
    expect(screen.rules.keys()).toContain('GET /v1/sign-in-rules');
  });
});
