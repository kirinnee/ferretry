/**
 * WHICH ACCOUNT A CARD OFFERS FIRST, AND WHY (docs/input-requests.md, "Which account is first"): the one-tap button
 * is the offer the DAEMON marked `primary` (secrev-1234), the line under it says why, two or more matched accounts
 * with none chosen say "Pick one", and a hand-tap can become a project default.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { InputRequest } from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { fieldsOf } from '../../../src/lib/input-card.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type Call, fakeClient, NOW, offer, primaryOffer, saved, withSaved } from '../../support/input-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const SECOND = 'si_fedcba9876543210';
const PROJECT = { id: 'p_ferretry', name: 'ferretry' };

const answer = (call: Call) =>
  call.path === '/v1/accounts/defaults'
    ? { defaults: {} }
    : {
        id: 'ab'.repeat(16),
        deliveryId: (call.body as { deliveryId?: string }).deliveryId,
        state: 'delivered',
        submitted: true,
      };

const show = async (value: InputRequest, reply: (call: Call) => unknown = answer) => {
  const fake = fakeClient(reply);
  const view = await mount(
    <InputCard
      agentName="Hadi"
      client={fake.client}
      now={NOW}
      onDone={() => undefined}
      request={value}
      fields={fieldsOf(value)}
    />,
  );
  mounted.push(view);
  const q = <T extends Element = HTMLElement>(selector: string): T | null => view.container.querySelector<T>(selector);
  return { ...fake, q };
};

const two = () => [
  offer({ id: 'WORK', label: 'Work', username: 'kirin@work', signIn: 'si_0123456789abcdef' }),
  offer({ id: 'HOME', label: 'Home', username: 'kirin@home', signIn: SECOND }),
];

describe('the reason line under the one-tap button', () => {
  const reasons = [
    [{ why: 'ferret' as const }, 'Ferret chose this'],
    [{ why: 'project' as const, project: 'ferretry' }, 'Default for ferretry'],
    [{ why: 'folder' as const }, 'Default for this folder'],
    [{ why: 'site' as const }, 'Default for app.clickup.com'],
    [{ why: 'only' as const }, 'Only account here'],
  ] as const;

  for (const [overrides, words] of reasons) {
    it(`says "${words}"`, async () => {
      const { q } = await show(withSaved(saved({ match: 'app.clickup.com', offers: [primaryOffer(overrides)] })));

      expect(q('[data-input-why]')?.textContent).toBe(words);
      expect(q('[data-input-pick-one]')).toBeNull();
    });
  }
});

describe("one tap is the daemon's primary and nothing else", () => {
  it('has no one-tap on a matched offer the daemon did not mark primary (an older daemon)', async () => {
    const { q, calls } = await show(withSaved(saved({ offers: [offer()] })));
    await settle();

    expect(q('[data-variant="primary"][data-input-offer]')).toBeNull();
    expect(q('[data-input-why]')).toBeNull();
    expect(q('[data-input-value]')).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it('is the marked offer even when a matched one comes first in the list', async () => {
    const [work, home] = two();
    const { q } = await show(
      withSaved(
        saved({
          offers: [must(work, 'work'), { ...must(home, 'home'), primary: true, why: 'project', project: 'ferretry' }],
        }),
      ),
    );

    expect(q('[data-variant="primary"][data-input-offer]')?.getAttribute('data-input-offer')).toBe('HOME');
  });

  it('never makes a hinted offer the one-tap on its own', async () => {
    const { q } = await show(withSaved(saved({ offers: [offer({ hinted: true, matched: false })] })));

    expect(q('[data-variant="primary"][data-input-offer]')).toBeNull();
  });
});

describe('Pick one', () => {
  it('lists the matched accounts and counts them when none is chosen', async () => {
    const { q } = await show(withSaved(saved({ offers: two() })));

    expect(q('[data-input-pick-one-line]')?.textContent).toBe('Pick one: 2 accounts sign in here');
    expect(q('[data-input-pick-one] [data-input-offer="WORK"]')).not.toBeNull();
    expect(q('[data-input-pick-one] [data-input-offer="HOME"]')).not.toBeNull();
    expect(q('[data-variant="primary"][data-input-offer]')).toBeNull();
    expect(q('[data-input-value]')).toBeNull();
  });

  it('sends nothing until a tap, then sends the tapped handle', async () => {
    const { q, calls } = await show(withSaved(saved({ offers: two() })));
    await settle();
    expect(calls).toEqual([]);

    await click(q('[data-input-offer="HOME"]'));
    await settle();

    const body = must(
      calls.find(call => call.path.endsWith('/deliver')),
      'a deliver',
    ).body as Record<string, unknown>;
    expect(body.entry).toBe('HOME');
  });
});

describe('Always use for <project>', () => {
  const pick = () => withSaved(saved({ match: 'app.clickup.com', project: PROJECT, offers: two() }));

  it('is offered after a hand-tap and writes the project default through the owner route', async () => {
    const { q, calls } = await show(pick());
    expect(q('[data-input-always]')).toBeNull();

    await click(q('[data-input-offer="HOME"]'));
    await settle();
    expect(q('[data-input-always-button]')?.textContent).toBe('Always use for ferretry');
    expect(calls.some(call => call.path === '/v1/accounts/defaults')).toBe(false);

    await click(q('[data-input-always-button]'));
    await settle();

    const put = must(
      calls.find(call => call.path === '/v1/accounts/defaults'),
      'the defaults write',
    );
    expect(put.method).toBe('PUT');
    expect(put.body).toEqual({ scope: 'projects', within: 'p_ferretry', key: 'app.clickup.com', account: 'HOME' });
    expect(q('[data-input-always-saved]')?.textContent).toContain('Home is now the default for ferretry');
  });

  it('says why it failed and keeps the button', async () => {
    const { q } = await show(pick(), call => {
      if (call.path === '/v1/accounts/defaults') throw new Error('the owner has to confirm this on the machine');
      return answer(call);
    });
    await click(q('[data-input-offer="HOME"]'));
    await settle();
    await click(q('[data-input-always-button]'));
    await settle();

    expect(q('[data-input-always-failure]')?.textContent).toContain('the owner has to confirm');
    expect(q('[data-input-always-button]')).not.toBeNull();
  });

  it('is not offered after the one-tap, without a project, or on an older daemon', async () => {
    const one = await show(
      withSaved(saved({ match: 'app.clickup.com', project: PROJECT, offers: [primaryOffer({ why: 'site' })] })),
    );
    await click(one.q('[data-variant="primary"][data-input-offer]'));
    await settle();
    expect(one.q('[data-input-settled]')).not.toBeNull();
    expect(one.q('[data-input-always]')).toBeNull();

    const unfiled = await show(withSaved(saved({ match: 'app.clickup.com', offers: two() })));
    await click(unfiled.q('[data-input-offer="HOME"]'));
    await settle();
    expect(unfiled.q('[data-input-always]')).toBeNull();

    const old = await show(
      withSaved(saved({ match: 'app.clickup.com', project: PROJECT, offers: [offer({ id: 'HOME', matched: false })] })),
    );
    await click(old.q('[data-input-offer="HOME"]'));
    await settle();
    expect(old.q('[data-input-always]')).toBeNull();
  });
});
