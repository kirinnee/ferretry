import { describe, expect, test } from 'bun:test';
import { deviceStanding } from '@ferretry/core-gate/contract/testing';
import { ApiError, type CallContext, type CallStanding } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import {
  AGENT_ORIGIN,
  type ConversationStageSource,
  DAEMON_ORIGIN,
  type LaunchOrigin,
  PERSON_ORIGIN,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { conversationCopyRefusal } from '../../../../daemon/lib/route-security/conversation-copy.ts';
import { additivesFixture } from './additives-fixture.ts';
import { fakeLaunchRoots, fakeStageOwner, host } from './route-fixture.ts';

/**
 * Who may have a transcript COPIED in from the owner's computer (E-253, E-255): only a start for a person, and from a
 * governed device only one that was stepped up for the copy itself, not merely for starting a ferret.
 */
const CONVERSATION = 'conversation-existing';

/** The owner's computer holds CONVERSATION; staging copies it into the harness's pool, so the resume can find it. */
const stagingInto = (harness: FakeHarness, asked: string[]): ConversationStageSource => ({
  stage: async ({ conversation }) => {
    asked.push(conversation);
    const copied = await harness.importConversation({
      id: conversation,
      source: `projects/-work-a/${conversation}.jsonl`,
    });
    return copied.ok ? ok(undefined) : err({ code: 'failed', reason: copied.error.reason });
  },
});

describe('E-253 the origin of the start decides who stages', () => {
  const stagedBy = async (origin: LaunchOrigin): Promise<readonly string[]> => {
    const asked: string[] = [];
    const f = additivesFixture({ empty: true });
    const source: ConversationStageSource = {
      stage: async ({ conversation }) => {
        asked.push(conversation);
        return ok(undefined);
      },
    };
    f.ports.conversationStage = () => source;
    await f.service.start({ folder: '/work', by: 'owner', harnessConversation: CONVERSATION }, origin);
    return asked;
  };

  test('a person’s start stages the transcript', async () => {
    expect(await stagedBy(PERSON_ORIGIN)).toEqual([CONVERSATION]);
  });

  for (const [who, origin] of [
    ['the daemon’s own start (the Lessons miner)', DAEMON_ORIGIN],
    ['an agent with no ferret behind it', AGENT_ORIGIN],
  ] as const)
    test(`${who} stages nothing, though its attribution says owner`, async () => {
      expect(await stagedBy(origin)).toEqual([]);
    });
});

describe('E-255 copying computer history from a governed device needs a step-up for the copy', () => {
  /** A device that may start a ferret (`promptsAsUse`: no extra prompt) but is asked for a passkey for any other configure. */
  const device = (demands: unknown[], spent: { n: number }) => (): CallStanding => ({
    ...deviceStanding('phone'),
    governance: {
      governed: true,
      decide: demand => {
        demands.push(demand);
        return (demand as { promptsAsUse?: true }).promptsAsUse === true
          ? { allowed: true, refusal: 'granted' }
          : { allowed: false, refusal: 'step-up-required' };
      },
    },
    spendStepUp: () => {
      spent.n += 1;
    },
  });
  const world = async (standing: () => CallStanding | undefined, asked: string[]) => {
    const harness = new FakeHarness().honestHistory();
    const runner = new FakeRunner();
    const h = await host([], {
      harness,
      runner,
      standing,
      plugins: [fakeLaunchRoots({ roots: async () => ['/work'] }), fakeStageOwner(stagingInto(harness, asked))],
    });
    return { h, runner };
  };

  test('a start naming a conversation is refused with the step-up demand, and nothing is staged or started', async () => {
    const asked: string[] = [];
    const demands: unknown[] = [];
    const { h, runner } = await world(device(demands, { n: 0 }), asked);
    const refused = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'copy-without-step-up' },
      body: { folder: '/work/a', harnessConversation: CONVERSATION },
    });
    expect(refused.status).toBe(403);
    expect(refused.json()).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure' },
    });
    expect(asked).toEqual([]);
    expect(runner.starts).toBe(0);
  });

  test('a start naming no conversation asks nothing beyond the start’s own demand', async () => {
    const demands: unknown[] = [];
    const { h } = await world(device(demands, { n: 0 }), []);
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'plain-start' },
      body: { folder: '/work/a' },
    });
    expect(started.status).toBe(201);
    expect(demands).toEqual([]);
  });

  test('a device that is stepped up for the copy continues the conversation and spends the proof once', async () => {
    const asked: string[] = [];
    const spent = { n: 0 };
    const { h } = await world(
      () => ({
        ...deviceStanding('phone'),
        governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
        spendStepUp: () => {
          spent.n += 1;
        },
      }),
      asked,
    );
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'copy-with-step-up' },
      body: { folder: '/work/a', harnessConversation: CONVERSATION },
    });
    expect(started.status).toBe(201);
    expect(asked).toEqual([CONVERSATION]);
    expect(spent.n).toBe(1);
  });

  test('the owner at the machine is not asked', async () => {
    const asked: string[] = [];
    const harness = new FakeHarness().honestHistory();
    const h = await host([], {
      harness,
      runner: new FakeRunner(),
      plugins: [fakeStageOwner(stagingInto(harness, asked))],
    });
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'local-copy' },
      body: { folder: '/work/a', harnessConversation: CONVERSATION },
    });
    expect(started.status).toBe(201);
    expect(asked).toEqual([CONVERSATION]);
  });
});

describe('E-255 the copy gate fails closed where it cannot judge', () => {
  const callOf = (standing: object): CallContext => standing as unknown as CallContext;
  const refusal = (work: () => void): ApiError => {
    try {
      work();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    }
    throw new Error('the copy gate let the call through');
  };

  test('no carrier presentation, or no grants to read, is 503 and never a pass', () => {
    const named = { harnessConversation: CONVERSATION };
    const blind = refusal(() => conversationCopyRefusal(callOf({}), named));
    expect([blind.status, blind.code]).toEqual([503, 'launch_gate_unavailable']);
    const ungoverned = refusal(() => conversationCopyRefusal(callOf({ presentation: { local: false } }), named));
    expect([ungoverned.status, ungoverned.code]).toEqual([503, 'launch_gate_unavailable']);
  });

  test('a device the grants refuse is 403 with the grant code and no step-up demand', () => {
    const call = callOf({
      presentation: { local: false },
      governance: { governed: true, decide: () => ({ allowed: false, refusal: 'not-granted' }) },
    });
    const refused = refusal(() => conversationCopyRefusal(call, { harnessConversation: CONVERSATION }));
    expect([refused.status, refused.code, refused.extra]).toEqual([403, 'grant_not_granted', undefined]);
  });

  test('a start naming no conversation is never judged', () => {
    conversationCopyRefusal(callOf({}), {});
  });
});
