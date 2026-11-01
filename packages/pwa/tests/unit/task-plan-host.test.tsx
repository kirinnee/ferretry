/**
 * The host drives the card from the DAEMON's plan only: the ref the daemon set, the plan the secrets-gated route
 * returns, the passkey the step-up asks for, and a stage dropped when that passkey is dismissed.
 */

import { describe, expect, it } from 'bun:test';
import { TaskPlanHost } from '../../src/features/secure-copy/task-plan-host.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DISMISSED_PLAN_WORDS, runApproval, runMachineConfirm } from '../../src/lib/task-plan.ts';
import { interact, mount, must } from '../support/dom.ts';
import {
  EXPIRES,
  mixedPlan,
  PLAN_ID,
  planOf,
  SESSION,
  STAGE,
  sudoLine,
  codesLine,
} from '../support/task-plan-fixtures.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });

interface Call {
  readonly path: string;
  readonly method: string;
}

/** A client that answers the plan routes from a table, and remembers every call. */
function fakeClient(answers: Readonly<Record<string, unknown>>) {
  const calls: Call[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method });
      const key = `${method} ${path}`;
      if (!(key in answers)) throw new Error(`the fake daemon has no answer for ${key}`);
      return schema.parse(answers[key]);
    },
  };
  return { client: client as never, calls };
}

const PLAN_PATH = `/v1/sessions/${SESSION}/task-plans/${PLAN_ID}`;
const SUMMARY = ['Line 2: sign in to vercel.com as deploy@atomi.cloud, once'];
const staged = {
  outcome: 'staged',
  staged: { stage: STAGE, plan: PLAN_ID, lines: [0], summary: SUMMARY, expiresAt: EXPIRES },
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
          asked.push(words);
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
      expect(asked).toEqual([SUMMARY.join('\n')]);
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
          order.push(`passkey ${stage} ${words}`);
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
