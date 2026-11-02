/**
 * The host drives the card from the DAEMON's plan only: the ref the daemon set, the plan the secrets-gated route
 * returns, the passkey the step-up asks for, and a stage dropped when that passkey is dismissed.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { TaskPlanHost } from '../../src/features/secure-copy/task-plan-host.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  DISMISSED_PLAN_WORDS,
  NO_ACCOUNTS_DEVICE_WORDS,
  runApproval,
  runMachineConfirm,
} from '../../src/lib/task-plan.ts';
import { interact, mount, must } from '../support/dom.ts';
import {
  approvedPlan,
  codesLine,
  EXPIRES,
  mixedPlan,
  PLAN_ID,
  planOf,
  SESSION,
  STAGE,
  sudoLine,
} from '../support/task-plan-fixtures.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });

interface Call {
  readonly path: string;
  readonly method: string;
}

/**
 * Holds every timer of 3 s or more instead of arming it, so a test can run the host's retry on demand ("advancing the
 * clock") and see exactly which retries it scheduled.
 */
const realSetTimeout = globalThis.setTimeout;
const held: { readonly ms: number; readonly run: () => void }[] = [];
const holdLongTimers = (): void => {
  globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === 'number' && ms >= 3_000) {
      held.push({ ms, run: handler });
      return 0 as never;
    }
    return realSetTimeout(handler, ms, ...(rest as []));
  }) as typeof setTimeout;
};
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  held.length = 0;
});

/** A client that answers the plan routes from a table, and remembers every call. */
function fakeClient(answers: Readonly<Record<string, unknown>>) {
  const calls: Call[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method });
      const key = `${method} ${path}`;
      if (!(key in answers)) throw new Error(`the fake daemon has no answer for ${key}`);
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return schema.parse(answer);
    },
  };
  return { client: client as never, calls };
}

const PLAN_PATH = `/v1/sessions/${SESSION}/task-plans/${PLAN_ID}`;
const SUMMARY = ['Line 2: sign in to vercel.com as deploy@atomi.cloud, once'];
const staged = {
  outcome: 'staged',
  staged: { stage: STAGE, plan: PLAN_ID, lines: [0], codes: [], summary: SUMMARY, expiresAt: EXPIRES },
};

describe('the host', () => {
  it('draws nothing for an item with no daemon-set taskPlan ref, and reads no plan for it', async () => {
    const { client, calls } = fakeClient({ 'GET /v1/task-plans': { plans: [mixedPlan()] } });
    const mounted = await mount(
      <TaskPlanHost connection={connection} createClient={async () => client} item={{}} offered sessionId={SESSION} />,
    );
    try {
      expect(mounted.container.querySelector('[data-task-plan]')).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws the plan the daemon holds for the ref', async () => {
    const { client } = fakeClient({ 'GET /v1/task-plans': { plans: [mixedPlan()] } });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={{ taskPlan: { planId: PLAN_ID } }}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      expect(mounted.container.querySelector(`[data-task-plan="${PLAN_ID}"]`)).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the paste-plan card on a machine that does not offer task-plan.1', async () => {
    const { client, calls } = fakeClient({ 'GET /v1/copy-plans': { plans: [] } });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={{ taskPlan: { planId: PLAN_ID }, copyPlan: { planId: PLAN_ID } }}
        offered={false}
        sessionId={SESSION}
      />,
    );
    try {
      expect(mounted.container.querySelector('[data-task-plan]')).toBeNull();
      expect(calls.some(call => call.path === '/v1/task-plans')).toBe(false);
      expect(calls.some(call => call.path === '/v1/copy-plans')).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('drops the stage and approves nothing when the passkey is dismissed', async () => {
    const plan = planOf({ lines: [sudoLine(0)] });
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': { plans: [plan] },
      [`POST ${PLAN_PATH}/approval`]: staged,
      [`DELETE ${PLAN_PATH}/approval/${STAGE}`]: { stage: STAGE, dropped: true },
    });
    const asked: string[] = [];
    const mounted = await mount(
      <TaskPlanHost
        askPasskey={async (_stage, words) => {
          asked.push(words.rows.map(row => row.value).join('\n'));
          return false;
        }}
        connection={connection}
        createClient={async () => client}
        item={{ taskPlan: { planId: PLAN_ID } }}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      await interact(() =>
        must(mounted.container.querySelector<HTMLInputElement>('[data-task-plan-tick="0"]'), 'tick').click(),
      );
      await interact(() =>
        must(mounted.container.querySelector<HTMLButtonElement>('[data-task-plan-allow]'), 'allow').click(),
      );
      expect(asked).toEqual(['Line 2: sign in to vercel.com as deploy@atomi.cloud, once']);
      expect(calls.some(call => call.method === 'DELETE')).toBe(true);
      expect(calls.some(call => call.path.endsWith('/commit'))).toBe(false);
      expect(mounted.container.textContent).toContain(DISMISSED_PLAN_WORDS);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the approval', () => {
  const plan = planOf({ lines: [codesLine(0)] });
  const approval = { lines: [{ line: 0 }] };

  it('commits only after the passkey, with the words the daemon staged', async () => {
    const order: string[] = [];
    const { client, calls } = fakeClient({
      [`POST ${PLAN_PATH}/approval`]: staged,
      [`POST ${PLAN_PATH}/approval/${STAGE}/commit`]: planOf({ state: 'declined', lines: [codesLine(0)] }),
    });
    const outcome = await runApproval(
      {
        client,
        askPasskey: async (stage, words) => {
          order.push(`passkey ${stage} ${words.rows.map(row => row.value).join('\n')}`);
          return true;
        },
      },
      plan,
      approval,
    );
    expect(outcome.kind).toBe('settled');
    expect(order).toEqual([`passkey ${STAGE} ${SUMMARY.join('\n')}`]);
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST']);
  });

  it('drops the stage when the passkey is dismissed or errors, and never commits', async () => {
    for (const ask of [async () => false, async () => Promise.reject(new Error('no sheet'))]) {
      const { client, calls } = fakeClient({
        [`POST ${PLAN_PATH}/approval`]: staged,
        [`DELETE ${PLAN_PATH}/approval/${STAGE}`]: { stage: STAGE, dropped: true },
      });
      const outcome = await runApproval({ client, askPasskey: ask }, plan, approval);
      expect(outcome.kind === 'settled').toBe(false);
      expect(calls.map(call => call.method)).toEqual(['POST', 'DELETE']);
    }
  });

  it('refuses to approve a sign-in on a device that cannot ask for a passkey, and drops the stage', async () => {
    const { client, calls } = fakeClient({
      [`POST ${PLAN_PATH}/approval`]: staged,
      [`DELETE ${PLAN_PATH}/approval/${STAGE}`]: { stage: STAGE, dropped: true },
    });
    const outcome = await runApproval({ client, askPasskey: undefined }, plan, approval);
    expect(outcome.kind).toBe('failed');
    expect(calls.some(call => call.path.endsWith('/commit'))).toBe(false);
  });

  it('leaves a selection staged at the machine waiting when its passkey is dismissed', async () => {
    const { client, calls } = fakeClient({
      [`GET ${PLAN_PATH}/approval/${STAGE}`]: { ...staged.staged, state: 'waiting' },
    });
    const outcome = await runMachineConfirm({ client, askPasskey: async () => false }, plan, STAGE);
    expect(outcome.kind).toBe('dismissed');
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
  });
});

const click = async (root: ParentNode, selector: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
};

describe('the host, around the card', () => {
  const stagedPlan = () => ({
    ...planOf({ lines: [codesLine(0), sudoLine(1)] }),
    machineStage: { stage: STAGE, lines: [1], askedAt: '2026-08-05T14:02:00.000Z' },
  });
  const stageView = { ...staged.staged, lines: [1], state: 'waiting' };
  const itemRef = { taskPlan: { planId: PLAN_ID } };

  it('shows the daemon’s summary of a selection staged at the machine, and confirms it with the passkey', async () => {
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': { plans: [stagedPlan()] },
      [`GET ${PLAN_PATH}/approval/${STAGE}`]: stageView,
      [`POST ${PLAN_PATH}/approval/${STAGE}/commit`]: approvedPlan(),
    });
    let done = 0;
    const asked: string[] = [];
    const mounted = await mount(
      <TaskPlanHost
        askPasskey={async (_stage, words) => {
          asked.push(words.rows.map(row => row.value).join('\n'));
          return true;
        }}
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        onDone={() => {
          done += 1;
        }}
        sessionId={SESSION}
      />,
    );
    try {
      expect(
        must(mounted.container.querySelector('[data-task-plan-machine-summary]'), 'summary').textContent,
      ).toContain(SUMMARY[0] ?? '');
      await click(mounted.container, '[data-task-plan-machine-confirm]');
      expect(asked).toEqual(['sign in to vercel.com as deploy@atomi.cloud, once']);
      expect(calls.some(call => call.path.endsWith('/commit'))).toBe(true);
      expect(mounted.container.querySelector('[data-task-plan-state="approved"]')).not.toBeNull();
      expect(done).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('drops a selection staged at the machine when the owner denies it, and reads the plan again', async () => {
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': { plans: [stagedPlan()] },
      [`GET ${PLAN_PATH}/approval/${STAGE}`]: stageView,
      [`DELETE ${PLAN_PATH}/approval/${STAGE}`]: { stage: STAGE, dropped: true },
    });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      await click(mounted.container, '[data-task-plan-machine-deny]');
      expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
      expect(calls.filter(call => call.path === '/v1/task-plans').length).toBeGreaterThan(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('says so when a stage cannot be dropped', async () => {
    const { client } = fakeClient({
      'GET /v1/task-plans': { plans: [stagedPlan()] },
      [`GET ${PLAN_PATH}/approval/${STAGE}`]: stageView,
      [`DELETE ${PLAN_PATH}/approval/${STAGE}`]: new Error('the machine is away'),
    });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      await click(mounted.container, '[data-task-plan-machine-deny]');
      expect(must(mounted.container.querySelector('[data-task-plan-failure]'), 'failure').textContent).toBe(
        'the machine is away',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('draws the staged card without a summary while the stage cannot be read', async () => {
    const { client } = fakeClient({
      'GET /v1/task-plans': { plans: [stagedPlan()] },
    });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      expect(mounted.container.querySelector('[data-task-plan-state="machine-staged"]')).not.toBeNull();
      expect(mounted.container.querySelector('[data-task-plan-machine-summary]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('revokes one line of an approved plan and shows the plan the daemon answers with', async () => {
    const revoked = { ...approvedPlan(), state: 'revoked' };
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': { plans: [approvedPlan()] },
      [`POST ${PLAN_PATH}/revoke`]: revoked,
    });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      await click(mounted.container, '[data-task-plan-revoke="0"]');
      expect(calls.filter(call => call.path.endsWith('/revoke'))).toHaveLength(1);
      expect(mounted.container.querySelector('[data-task-plan-state="revoked"]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('says a failed revoke and leaves the plan as it was', async () => {
    const { client } = fakeClient({
      'GET /v1/task-plans': { plans: [approvedPlan()] },
      [`POST ${PLAN_PATH}/revoke`]: new Error('could not reach the machine'),
    });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      await click(mounted.container, '[data-task-plan-revoke="0"]');
      expect(must(mounted.container.querySelector('[data-task-plan-failure]'), 'failure').textContent).toBe(
        'could not reach the machine',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('shows what went wrong when the daemon refuses an approval', async () => {
    const { client } = fakeClient({
      'GET /v1/task-plans': { plans: [planOf({ lines: [codesLine(0)] })] },
      [`POST ${PLAN_PATH}/approval`]: new Error('the daemon said no'),
    });
    const mounted = await mount(
      <TaskPlanHost
        askPasskey={async () => true}
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      await click(mounted.container, '[data-task-plan-tick="0"]');
      await click(mounted.container, '[data-task-plan-allow]');
      expect(must(mounted.container.querySelector('[data-task-plan-failure]'), 'failure').textContent).toBe(
        'the daemon said no',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing while the plan is not on the machine, and not for another session’s plan', async () => {
    const { client } = fakeClient({ 'GET /v1/task-plans': { plans: [mixedPlan()] } });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId="other"
      />,
    );
    try {
      expect(mounted.container.querySelector('[data-task-plan]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('on a device that may not see accounts says so once, names nothing, stops asking and still offers the paste card', async () => {
    holdLongTimers();
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': forbidden,
      'GET /v1/copy-plans': { plans: [] },
    });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={{ taskPlan: { planId: PLAN_ID }, copyPlan: { planId: PLAN_ID } }}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      const note = must(mounted.container.querySelector('[data-task-plan-forbidden]'), 'forbidden note');
      expect(note.textContent).toContain(NO_ACCOUNTS_DEVICE_WORDS);
      expect(mounted.container.textContent).not.toContain('github');
      expect(mounted.container.querySelector('[data-task-plan]')).toBeNull();
      expect(calls.filter(call => call.path === '/v1/task-plans')).toHaveLength(1);
      expect(calls.some(call => call.path === '/v1/copy-plans')).toBe(true);
      // Time passes past the 9 s retry: nothing was scheduled, so there is no further request.
      expect(held).toEqual([]);
      await interact(async () => await Promise.resolve());
      expect(calls.filter(call => call.path === '/v1/task-plans')).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('on a device that may not see accounts and has no paste plan, says only that', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    const { client } = fakeClient({ 'GET /v1/task-plans': forbidden });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      expect(must(mounted.container.querySelector('[data-task-plan-forbidden]'), 'note').textContent).toBe(
        NO_ACCOUNTS_DEVICE_WORDS,
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('retries a read that failed for another reason, quietly, and draws nothing meanwhile', async () => {
    holdLongTimers();
    const { client, calls } = fakeClient({ 'GET /v1/task-plans': new Error('offline') });
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      expect(mounted.container.querySelector('[data-task-plan]')).toBeNull();
      expect(mounted.container.querySelector('[data-task-plan-forbidden]')).toBeNull();
      expect(calls).toHaveLength(1);
      // The retry is armed for 9 s; when that time comes the read is asked again.
      expect(held.map(timer => timer.ms)).toEqual([9_000]);
      await interact(async () => held.shift()?.run());
      expect(calls.filter(call => call.path === '/v1/task-plans')).toHaveLength(2);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing when the client cannot be made', async () => {
    const mounted = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => Promise.reject(new Error('no client'))}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      expect(mounted.container.querySelector('[data-task-plan]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('names the agent on the card, or says “The ferret” when it was not given one', async () => {
    const { client } = fakeClient({ 'GET /v1/task-plans': { plans: [mixedPlan()] } });
    const named = await mount(
      <TaskPlanHost
        agentName="Hadi"
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      expect(named.container.textContent).toContain('Hadi says');
    } finally {
      await named.unmount();
    }
    const unnamed = await mount(
      <TaskPlanHost
        connection={connection}
        createClient={async () => client}
        item={itemRef}
        offered
        sessionId={SESSION}
      />,
    );
    try {
      expect(unnamed.container.textContent).toContain('The ferret says');
    } finally {
      await unnamed.unmount();
    }
  });
});
