/** The words and the routes behind the task-plan card: nothing here comes from a ferret, and every route is the owner's. */

import { describe, expect, it } from 'bun:test';
import { AUTOMATED_CODE_WARNING } from '@ferretry/protocol';
import {
  allowBlockedWords,
  approvalOf,
  approvedAccountName,
  approvedCode,
  becauseWords,
  clockWords,
  groupLines,
  initialTicks,
  isForbidden,
  isPlanLive,
  lineTitle,
  listTaskPlans,
  machineStageWords,
  NO_PASSKEY_TICK_WORDS,
  planPasskeyWords,
  revokeLines,
  rootBadge,
  rootHost,
  rootTool,
  rootWords,
  runApproval,
  runMachineConfirm,
  settledWords,
  stagedCodeOn,
  stagedLines,
  withCode,
  withPick,
  withTicked,
} from '../../src/lib/task-plan.ts';
import {
  approvedPlan,
  codesLine,
  EXPIRES,
  GITHUB_WORK,
  mixedPlan,
  PLAN_ID,
  pickerLine,
  planOf,
  SESSION,
  STAGE,
  sudoLine,
} from '../support/task-plan-fixtures.ts';

function fakeClient(answers: Readonly<Record<string, unknown>>) {
  const calls: { readonly path: string; readonly method: string; readonly body?: string }[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      const key = `${method} ${path}`;
      if (!(key in answers)) throw Object.assign(new Error(`no answer for ${key}`), { code: 'nope' });
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return schema.parse(answer);
    },
  };
  return { client: client as never, calls };
}

const PLAN_PATH = `/v1/sessions/${SESSION}/task-plans/${PLAN_ID}`;
const SUMMARY = ['Line 1: paste it, once'];
const stagedAnswer = {
  outcome: 'staged',
  staged: { stage: STAGE, plan: PLAN_ID, lines: [0], codes: [], summary: SUMMARY, expiresAt: EXPIRES },
};
const line = (plan: ReturnType<typeof mixedPlan>, index: number) => {
  const found = plan.lines[index];
  if (found === undefined) throw new Error(`no line ${String(index)}`);
  return found;
};

describe('the owner’s words', () => {
  it('says a root line by its host and tool, and says so honestly when the host is not one', () => {
    expect(rootBadge('kirin-box')).toBe('root on kirin-box');
    expect(rootBadge(undefined)).toBe('root on this machine');
    expect(rootWords('kirin-box', 'kirin', 'su')).toBe(
      'Ferretry types kirin’s password into su on kirin-box: this gives the ferret root on kirin-box',
    );
    expect(rootWords('kirin-box', undefined)).toContain('types the password into sudo, su or doas on kirin-box');
    expect(rootWords(undefined, undefined)).toBe(
      'Ferretry types a password into sudo, su or doas here: this gives the ferret root on this machine',
    );
  });

  it('names the tool and host a terminal line types at, from the picked account or the only one', () => {
    const sudo = line(mixedPlan(), 2);
    if (sudo.kind !== 'terminal-sign-in') throw new Error('expected a terminal line');
    expect(rootHost(undefined, sudo)).toBe('kirin-box');
    expect(rootTool(undefined, sudo)).toBe('sudo');
    const page = line(mixedPlan(), 1);
    if (page.kind !== 'sign-in') throw new Error('expected a page line');
    expect(rootHost(undefined, page)).toBeUndefined();
    expect(rootTool(undefined, page)).toBeUndefined();
  });

  it('says when a staged selection was asked, and which lines', () => {
    expect(machineStageWords({ lines: [0], askedAt: 'not a time' })).toContain('line 1.');
    expect(machineStageWords({ lines: [0, 2, 3], askedAt: '2026-08-05T14:02:00.000Z' })).toContain('lines 1, 3 and 4');
    expect(clockWords('2026-08-05T14:02:00.000Z')).toMatch(/^\d\d:\d\d$/u);
    expect(clockWords('2026-08-05T14:02:00.000ZX')).toBe('14:02');
  });

  it('takes a staged selection’s lines from the plan, and says a code is in one only when the daemon’s list says so', () => {
    const plan = { ...mixedPlan(), machineStage: { stage: STAGE, lines: [1, 3], askedAt: '2026-08-05T14:02:00.000Z' } };
    expect(stagedLines(plan).map(each => each.line)).toEqual([1, 3]);
    const withCodes = line(mixedPlan(), 1);
    expect(stagedCodeOn(undefined, withCodes)).toBe(true);
    expect(stagedCodeOn([1], withCodes)).toBe(true);
    expect(stagedCodeOn([1, 3], withCodes)).toBe(true);
    expect(stagedCodeOn([], withCodes)).toBe(false);
    expect(stagedCodeOn([0, 3], withCodes)).toBe(false);
    expect(stagedCodeOn([1], line(mixedPlan(), 3))).toBe(false);
    expect(stagedCodeOn(undefined, line(mixedPlan(), 3))).toBe(false);
  });

  it('gives a reason in the daemon’s words and nothing for one that draws no line', () => {
    expect(becauseWords(undefined)).toBeUndefined();
    expect(becauseWords('not-here')).toBeUndefined();
    expect(becauseWords('frame')).toContain('frame');
  });

  it('titles a paste line from where the text comes from and where it goes', () => {
    const route = (from: object, to: object) =>
      lineTitle(
        line(
          planOf({
            lines: [{ kind: 'paste', line: 0, uses: 1, why: 'x', state: 'waiting', from, to }],
          }),
          0,
        ),
      );
    expect(
      route({ kind: 'browser', origin: 'https://a.example' }, { kind: 'browser', origin: 'https://b.example' }),
    ).toBe('Paste from text on https://a.example → a field on https://b.example');
    expect(route({ kind: 'clipboard', origin: 'https://a.example' }, { kind: 'secret', name: 'DEPLOY_TOKEN' })).toBe(
      'Paste from the clipboard of https://a.example → the secret DEPLOY_TOKEN',
    );
  });

  it('titles a sign-in with no account in Accounts without a place', () => {
    const none = planOf({ lines: [{ ...pickerLine(0), candidates: [], flags: [] }] });
    expect(lineTitle(line(none, 0))).toContain('a place not in Accounts');
    expect(groupLines(none, initialTicks(none)).map(group => group.title)).toEqual(['Not in Accounts']);
  });

  it('says where a settled plan stands, one sentence each', () => {
    const base = mixedPlan();
    expect(settledWords(base)).toBe('');
    expect(settledWords(approvedPlan())).toStartWith('You allowed lines 1 and 4 until ');
    expect(settledWords({ ...approvedPlan(), lines: [line(approvedPlan(), 0)] })).toStartWith(
      'You allowed line 1 until',
    );
    expect(settledWords({ ...base, state: 'declined' })).toStartWith('Declined');
    expect(settledWords({ ...base, state: 'revoked' })).toStartWith('Revoked');
    expect(settledWords({ ...base, state: 'expired' })).toContain('on time');
    expect(settledWords({ ...base, state: 'ended' })).toContain('with its session');
  });

  it('names the approved account and flags a ticked code, and only for an approved sign-in', () => {
    const settled = approvedPlan();
    expect(approvedAccountName(line(settled, 0))).toBe('github work · kirin@atomi.cloud');
    expect(approvedCode(line(settled, 0))).toBe(true);
    expect(approvedAccountName(line(settled, 1))).toBeUndefined();
    expect(approvedAccountName(line(settled, 3))).toBeUndefined();
    expect(approvedCode(line(settled, 3))).toBe(false);
  });

  it('keeps a plan live while it waits or while a line still has a use, and no longer', () => {
    expect(isPlanLive(mixedPlan())).toBe(true);
    expect(isPlanLive(approvedPlan())).toBe(true);
    expect(isPlanLive({ ...mixedPlan(), state: 'revoked' })).toBe(false);
  });
});

describe('the ticks', () => {
  it('ticks and unticks a line, and drops its code tick with it', () => {
    const plan = planOf({ lines: [codesLine(0)] });
    const ticked = withTicked(plan, initialTicks(plan), 0, true);
    const coded = withCode(plan, ticked, 0, true);
    expect(coded[0]?.totp).toBe(true);
    expect(withTicked(plan, coded, 0, false)[0]).toMatchObject({ ticked: false, totp: false });
    expect(approvalOf(plan, coded).lines).toEqual([{ line: 0, signIn: expect.any(String), totp: true }]);
  });

  it('refuses a code on a line that is not ticked, and a tick or code on a line that is not there', () => {
    const plan = planOf({ lines: [codesLine(0)] });
    const ticks = initialTicks(plan);
    expect(withCode(plan, ticks, 0, true)).toBe(ticks);
    expect(withCode(plan, ticks, 9, true)).toBe(ticks);
    expect(withTicked(plan, ticks, 9, true)).toBe(ticks);
    expect(withPick(ticks, 9, undefined)).toBe(ticks);
  });

  it('unticks a line whose account changes, and keeps no pick when the pick is cleared', () => {
    const plan = planOf({ lines: [pickerLine(0)] });
    const picked = withPick(initialTicks(plan), 0, GITHUB_WORK);
    const ticked = withTicked(plan, picked, 0, true);
    expect(ticked[0]?.ticked).toBe(true);
    const cleared = withPick(ticked, 0, undefined);
    expect(cleared[0]).toEqual({ ticked: false, totp: false });
  });

  it('says why Allow is off: nothing ticked, a problem with the selection, or a device with no passkey', () => {
    const plan = planOf({ lines: [codesLine(0)] });
    expect(allowBlockedWords(plan, initialTicks(plan), true)).toBe(
      'Tick at least one line to allow it, or Decline all.',
    );
    const ticked = withTicked(plan, initialTicks(plan), 0, true);
    expect(allowBlockedWords(plan, ticked, true)).toBeUndefined();
    expect(allowBlockedWords(plan, ticked, false)).toBe(NO_PASSKEY_TICK_WORDS);
  });
});

describe('the routes', () => {
  it('reads the list, and revokes named lines or the whole plan', async () => {
    const { client, calls } = fakeClient({
      'GET /v1/task-plans': { plans: [mixedPlan()] },
      [`POST ${PLAN_PATH}/revoke`]: approvedPlan(),
    });
    expect((await listTaskPlans(client)).plans).toHaveLength(1);
    await revokeLines(client, mixedPlan(), [3]);
    await revokeLines(client, mixedPlan());
    expect(calls.filter(call => call.path.endsWith('/revoke')).map(call => call.body)).toEqual([
      JSON.stringify({ lines: [3] }),
      '{}',
    ]);
  });

  it('recognises a refusal of the whole device by its 403 and nothing else', () => {
    expect(isForbidden(Object.assign(new Error('no'), { status: 403 }))).toBe(true);
    expect(isForbidden(Object.assign(new Error('no'), { status: 500 }))).toBe(false);
    expect(isForbidden(new Error('no'))).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });

  it('is answered at once for a selection with no sign-in line, and never asks for a passkey', async () => {
    const answered = approvedPlan();
    const { client } = fakeClient({ [`POST ${PLAN_PATH}/approval`]: { outcome: 'answered', plan: answered } });
    const outcome = await runApproval({ client, askPasskey: undefined }, mixedPlan(), { lines: [{ line: 3 }] });
    expect(outcome).toEqual({ kind: 'settled', plan: answered });
  });

  it('says what the daemon refused with, in words for the owner', async () => {
    const refuse = async (code: string) => {
      const { client } = fakeClient({
        [`POST ${PLAN_PATH}/approval`]: Object.assign(new Error('refused'), { code }),
      });
      return await runApproval({ client, askPasskey: undefined }, mixedPlan(), { lines: [{ line: 0 }] });
    };
    expect(await refuse('passkey_required')).toMatchObject({ words: expect.stringContaining('Add a passkey') });
    expect(await refuse('stage_not_found')).toMatchObject({ words: expect.stringContaining('timed out') });
    expect(await refuse('other')).toEqual({ kind: 'failed', words: 'refused' });
    const { client } = fakeClient({ [`POST ${PLAN_PATH}/approval`]: new Error('plain') });
    expect(await runApproval({ client, askPasskey: undefined }, mixedPlan(), { lines: [{ line: 0 }] })).toEqual({
      kind: 'failed',
      words: 'plain',
    });
  });

  it('confirms a machine stage only while it is waiting, and says so when it is gone', async () => {
    const gone = fakeClient({
      [`GET ${PLAN_PATH}/approval/${STAGE}`]: { ...stagedAnswer.staged, state: 'approved' },
    });
    expect(await runMachineConfirm({ client: gone.client, askPasskey: async () => true }, mixedPlan(), STAGE)).toEqual({
      kind: 'failed',
      words: expect.stringContaining('timed out'),
    });
    const missing = fakeClient({});
    expect(
      await runMachineConfirm({ client: missing.client, askPasskey: async () => true }, mixedPlan(), STAGE),
    ).toMatchObject({ kind: 'failed' });
  });

  it('commits a machine stage after its passkey, and reports each step', async () => {
    const steps: string[] = [];
    const { client } = fakeClient({
      [`GET ${PLAN_PATH}/approval/${STAGE}`]: { ...stagedAnswer.staged, state: 'waiting' },
      [`POST ${PLAN_PATH}/approval/${STAGE}/commit`]: approvedPlan(),
    });
    const outcome = await runMachineConfirm(
      { client, askPasskey: async () => true, report: step => steps.push(step) },
      mixedPlan(),
      STAGE,
    );
    expect(outcome.kind).toBe('settled');
    expect(steps).toEqual(['staging', 'passkey', 'committing']);
  });
});

describe('the sudo line is a terminal line', () => {
  it('has a place the tool and host can be read from', () => {
    expect(line(planOf({ lines: [sudoLine(0)] }), 0).kind).toBe('terminal-sign-in');
  });
});

describe('the words on the passkey for a task plan', () => {
  const plan = mixedPlan();
  const staged = (lines: number[], codes: number[]) => ({
    lines,
    codes,
    summary: lines.map(number => `Line ${String(number + 1)}: summary`),
  });

  it('warns in red about root for a sudo line and about both factors for an automated code, in the dialog flags', () => {
    const words = planPasskeyWords(plan, staged([1, 2], [1]));
    expect(words.does).toBe('Let the ferret use these lines without asking');
    expect(words.warnings).toHaveLength(2);
    expect(words.warnings[0]).toContain('kirin-box');
    expect(words.warnings[1]).toBe(AUTOMATED_CODE_WARNING);
  });

  it('names the row, not this machine, when a machine-made stage could type at more than one host', () => {
    const base = sudoLine(0);
    const two = planOf({
      lines: [
        {
          ...base,
          candidates: [
            ...base.candidates,
            ...base.candidates.map(each => ({
              ...each,
              signIn: 'si_00000000000000ab',
              place: { ...each.place, host: 'other-box' },
            })),
          ],
          preselect: undefined,
        },
      ],
    });
    const [warning] = planPasskeyWords(two, staged([0], [])).warnings;
    expect(warning).toContain('root on the host named in the row');
    expect(warning).not.toContain('this machine');
  });

  it('adds no warning for a plain line and uses the singular for one line', () => {
    const words = planPasskeyWords(plan, staged([0], []));
    expect(words.does).toBe('Let the ferret use this line without asking');
    expect(words.warnings).toEqual([]);
  });
});
