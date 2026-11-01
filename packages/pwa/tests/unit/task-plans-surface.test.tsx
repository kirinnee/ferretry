/** Settings › Secure copy › Task plans: the live plans on this machine, and one tap to end a line or a plan. */

import { describe, expect, it } from 'bun:test';
import { TaskPlansCard, TaskPlansSurface } from '../../src/features/secure-copy/task-plans-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { HONEST_CLIENT_LINE, NO_ACCOUNTS_DEVICE_WORDS } from '../../src/lib/task-plan.ts';
import { interact, mount, must } from '../support/dom.ts';
import { approvedPlan, mixedPlan, PLAN_ID, RAISED, SESSION } from '../support/task-plan-fixtures.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const PLAN_PATH = `/v1/sessions/${SESSION}/task-plans/${PLAN_ID}`;

function fakeClient(answers: Readonly<Record<string, unknown>>) {
  const calls: { readonly path: string; readonly method: string }[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method });
      const key = `${method} ${path}`;
      if (!(key in answers)) throw new Error(`the fake daemon has no answer for ${key}`);
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return schema.parse(typeof answer === 'function' ? (answer as () => unknown)() : answer);
    },
  };
  return { client: client as never, calls };
}

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

describe('the card', () => {
  it('says there are no live plans, with the honest-client line above', async () => {
    const mounted = await mount(<TaskPlansCard busy={false} error={null} onRevoke={() => undefined} plans={[]} />);
    try {
      expect(q(mounted.container, '[data-task-plans-empty]').textContent).toContain('No live task plans');
      expect(q(mounted.container, '[data-task-plans-honest]').textContent).toBe(HONEST_CLIENT_LINE);
    } finally {
      await mounted.unmount();
    }
  });

  it('lists a waiting plan and an approved one, naming the approved account and flagging its code', async () => {
    const mounted = await mount(
      <TaskPlansCard
        busy={false}
        error="Something went wrong."
        onRevoke={() => undefined}
        plans={[
          mixedPlan(),
          { ...approvedPlan(), id: 'e'.repeat(32), raisedAt: RAISED },
          { ...mixedPlan(), state: 'revoked' },
        ]}
      />,
    );
    try {
      expect(mounted.container.querySelectorAll('[data-task-plans-plan]')).toHaveLength(2);
      expect(q(mounted.container, '[data-task-plans-error]').textContent).toBe('Something went wrong.');
      const text = mounted.container.textContent ?? '';
      expect(text).toContain('Waiting for you until');
      expect(text).toContain('Allowed until');
      expect(text).toContain('Account: github work · kirin@atomi.cloud');
      expect(text).toContain('Includes the 6-digit code');
      expect(text).toContain('1 of 2 uses left');
      expect(q(mounted.container, '[data-task-plans-revoke-all]').textContent).toBe('End this plan');
    } finally {
      await mounted.unmount();
    }
  });

  it('disables every revoke while one is under way', async () => {
    const mounted = await mount(
      <TaskPlansCard busy error={null} onRevoke={() => undefined} plans={[approvedPlan()]} />,
    );
    try {
      for (const button of mounted.container.querySelectorAll<HTMLButtonElement>('button'))
        expect(button.disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the surface', () => {
  it('reads the plans, revokes a line, and reads them again', async () => {
    let plans: unknown[] = [approvedPlan()];
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': () => ({ plans }),
      [`POST ${PLAN_PATH}/revoke`]: () => {
        plans = [];
        return { ...approvedPlan(), state: 'revoked' };
      },
    });
    const mounted = await mount(<TaskPlansSurface connection={connection} createClient={async () => client} />);
    try {
      await interact(() => q<HTMLButtonElement>(mounted.container, '[data-task-plans-revoke="0"]').click());
      expect(calls.filter(call => call.path.endsWith('/revoke'))).toHaveLength(1);
      expect(mounted.container.querySelector('[data-task-plans-plan]')).toBeNull();
      expect(mounted.container.querySelector('[data-task-plans-empty]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('revokes the whole plan with its one button', async () => {
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': { plans: [approvedPlan()] },
      [`POST ${PLAN_PATH}/revoke`]: { ...approvedPlan(), state: 'revoked' },
    });
    const mounted = await mount(<TaskPlansSurface connection={connection} createClient={async () => client} />);
    try {
      await interact(() => q<HTMLButtonElement>(mounted.container, '[data-task-plans-revoke-all]').click());
      expect(calls.some(call => call.path.endsWith('/revoke'))).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('says a failed revoke and keeps the plan listed', async () => {
    const { client } = fakeClient({
      'GET /v1/task-plans': { plans: [approvedPlan()] },
      [`POST ${PLAN_PATH}/revoke`]: new Error('the machine is away'),
    });
    const mounted = await mount(<TaskPlansSurface connection={connection} createClient={async () => client} />);
    try {
      await interact(() => q<HTMLButtonElement>(mounted.container, '[data-task-plans-revoke="0"]').click());
      expect(q(mounted.container, '[data-task-plans-error]').textContent).toBe('the machine is away');
      expect(mounted.container.querySelector('[data-task-plans-plan]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('shows a clear message, and no names, on a device that may not see accounts', async () => {
    const { client } = fakeClient({ 'GET /v1/task-plans': Object.assign(new Error('forbidden'), { status: 403 }) });
    const mounted = await mount(<TaskPlansSurface connection={connection} createClient={async () => client} />);
    try {
      expect(q(mounted.container, '[data-task-plans-error]').textContent).toBe(NO_ACCOUNTS_DEVICE_WORDS);
      expect(mounted.container.querySelector('[data-task-plans-plan]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('says what it could not read for any other failure, and for a client that cannot be made', async () => {
    const { client } = fakeClient({ 'GET /v1/task-plans': new Error('offline') });
    const failing = await mount(<TaskPlansSurface connection={connection} createClient={async () => client} />);
    try {
      expect(q(failing.container, '[data-task-plans-error]').textContent).toContain(
        'could not read this daemon’s task plans: offline',
      );
    } finally {
      await failing.unmount();
    }
  });

  it('says it is reading while the first read is out', async () => {
    const mounted = await mount(
      <TaskPlansSurface connection={connection} createClient={() => new Promise<never>(() => undefined)} />,
    );
    try {
      expect(mounted.container.querySelector('[aria-label="Loading task plans"]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
