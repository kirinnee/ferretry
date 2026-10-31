import { afterEach, describe, expect, it } from 'bun:test';
import type { CopyPlan } from '@ferretry/protocol';
import { CopyPlanCard } from '../../../src/features/secure-copy/copy-plan-card.tsx';
import { CopyPlanHost } from '../../../src/features/secure-copy/copy-plan-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type Call, fakeClient } from '../../support/input-fixtures.ts';

const CONNECTION = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const mounted: Mounted[] = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const PLAN: CopyPlan = {
  id: 'b'.repeat(32),
  sessionId: 'sess-1',
  agendaItemId: 'A8',
  items: [
    {
      from: { kind: 'command', program: 'vercel' },
      to: { kind: 'terminal', program: 'vercel' },
      why: 'the deploy token',
    },
    {
      from: { kind: 'browser', origin: 'https://github.com' },
      to: { kind: 'browser', origin: 'https://vercel.com' },
      why: 'the build token',
    },
  ],
  state: 'pending',
  raisedAt: '2026-08-05T09:58:00.000Z',
  expiresAt: '2026-08-05T11:58:00.000Z',
};

const card = async (plan: CopyPlan, onAnswer: (items: readonly number[]) => Promise<string>) => {
  const view = await mount(<CopyPlanCard agentName="Hadi" onAnswer={onAnswer} plan={plan} />);
  mounted.push(view);
  return {
    view,
    q: (selector: string) => view.container.querySelector(selector),
    text: () => view.container.textContent ?? '',
  };
};

describe('the paste plan card', () => {
  it("lists each planned route with the ferret's words, all ticked, and says until when", async () => {
    const { q, text } = await card(PLAN, async () => 'ok');

    expect(text()).toContain('Each ticked paste goes through once, without asking, until 2026-08-05 11:58 UTC.');
    expect(text()).toContain('2026-08-05 11:58 UTC');
    expect(q('[data-copy-plan-item="1"]')?.textContent).toContain('a field on https://vercel.com');
    expect(q('[data-copy-plan-item="1"] [data-copy-plan-why]')?.textContent).toBe('Hadi says: “the build token”');
    expect(q('[data-copy-plan-allow]')?.textContent).toBe('Allow all 2');
  });

  it('allows only what is ticked, and shows what the daemon settled', async () => {
    const answered: (readonly number[])[] = [];
    const { q } = await card(PLAN, async items => {
      answered.push(items);
      return 'Allowed 1 of 2, each once.';
    });
    await click(q('[data-copy-plan-tick="1"]'));
    expect(q('[data-copy-plan-allow]')?.textContent).toBe('Allow 1 of 2');
    await click(q('[data-copy-plan-tick="1"]'));
    await click(q('[data-copy-plan-tick="0"]'));
    await click(q('[data-copy-plan-allow]'));
    await settle();

    expect(answered).toEqual([[1]]);
    expect(q('[data-copy-plan-settled]')?.textContent).toBe('Allowed 1 of 2, each once.');
  });

  it('declines with no items, and keeps Allow off with none ticked', async () => {
    const answered: (readonly number[])[] = [];
    const single = { ...PLAN, items: [PLAN.items[0] as CopyPlan['items'][number]] };
    const { q } = await card(single, async items => {
      answered.push(items);
      return 'Declined: each paste will ask you.';
    });
    expect(q('[data-copy-plan-allow]')?.textContent).toBe('Allow it');
    await click(q('[data-copy-plan-tick="0"]'));
    expect(q('[data-copy-plan-allow]')?.hasAttribute('disabled')).toBe(true);
    await click(q('[data-copy-plan-decline]'));
    await settle();

    expect(answered).toEqual([[]]);
  });

  it('says why an answer failed and lets the owner try again', async () => {
    const { q } = await card(PLAN, async () => {
      throw new Error('the plan is already approved');
    });
    await click(q('[data-copy-plan-allow]'));
    await settle();

    expect(q('[data-copy-plan-failure]')?.textContent).toBe('the plan is already approved');
    expect(q('[data-copy-plan-allow]')?.hasAttribute('disabled')).toBe(false);
  });

  it('words a failure that is not an Error', async () => {
    const { q } = await card(PLAN, () => Promise.reject('offline'));
    await click(q('[data-copy-plan-decline]'));
    await settle();

    expect(q('[data-copy-plan-failure]')?.textContent).toBe('offline');
  });
});

const host = async (answer: (call: Call) => unknown, planId = 'b'.repeat(32), onDone?: () => void) => {
  const fake = fakeClient(answer);
  const view = await mount(
    <CopyPlanHost
      agentName="Hadi"
      connection={CONNECTION}
      createClient={async () => fake.client}
      item={{ copyPlan: { planId } }}
      sessionId="sess-1"
      {...(onDone === undefined ? {} : { onDone })}
    />,
  );
  mounted.push(view);
  await settle();
  return { ...fake, view, q: (selector: string) => view.container.querySelector(selector) };
};

describe('the paste plan host', () => {
  it('finds the plan behind its card, answers it and says what came of it', async () => {
    let done = 0;
    const { q, calls } = await host(
      call => (call.method === 'GET' ? { plans: [PLAN] } : { ...PLAN, state: 'approved', approved: [0, 1] }),
      PLAN.id,
      () => {
        done += 1;
      },
    );
    await click(q('[data-copy-plan-allow]'));
    await settle();

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/copy-plans',
      `POST /v1/sessions/sess-1/copy-plans/${PLAN.id}/approve`,
    ]);
    expect(q('[data-copy-plan-settled]')?.textContent).toBe('Allowed 2 of 2, each once.');
    expect(done).toBe(1);
  });

  it('says a declined plan asks each time, and names the ferret plainly when it has no name', async () => {
    const fake = fakeClient(call => (call.method === 'GET' ? { plans: [PLAN] } : { ...PLAN, state: 'declined' }));
    const view = await mount(
      <CopyPlanHost
        connection={CONNECTION}
        createClient={async () => fake.client}
        item={{ copyPlan: { planId: PLAN.id } }}
        sessionId="sess-1"
      />,
    );
    mounted.push(view);
    await settle();
    expect(view.container.textContent).toContain('The ferret says: “the deploy token”');
    await click(view.container.querySelector('[data-copy-plan-decline]'));
    await settle();

    expect(view.container.querySelector('[data-copy-plan-settled]')?.textContent).toBe(
      'Declined: each paste will ask you.',
    );
  });

  it('draws nothing for a card with no plan behind it, or when the plans cannot be read', async () => {
    const other = await host(() => ({ plans: [PLAN] }), 'c'.repeat(32));
    const broken = await host(() => {
      throw new Error('no route');
    });

    expect(other.view.container.innerHTML).toBe('');
    expect(broken.view.container.innerHTML).toBe('');
  });

  it('counts an approval whose list the daemon left out as none', async () => {
    const { q } = await host(call => (call.method === 'GET' ? { plans: [PLAN] } : { ...PLAN, state: 'approved' }));
    await click(q('[data-copy-plan-allow]'));
    await settle();

    expect(q('[data-copy-plan-settled]')?.textContent).toBe('Allowed 0 of 2, each once.');
  });
});
