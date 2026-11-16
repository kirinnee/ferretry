/**
 * ACCOUNTS' WIDENING ACTS ARE BOUND TO THE APP'S ONE PASSKEY PROMPT (G105; S88).
 *
 * Every act that WIDENS (a paste rule, programs in your own profile ON, a standing sign-in rule, a task plan's ticks, a
 * machine-staged confirm, saving a 2FA seed) asks the shell's prompt BEFORE its commit, bound to the machine the half was
 * built for, the act and the staged id. These drive the real screens from their entry points (the settings tabs and the
 * ask renderer) against a client that records every route, with only the shell's `usePasskeyAsk` stood in
 * (`support/app/shell-ask.ts`):
 *
 *   - prompt confirmed  → the bind/commit goes out once, after the ask;
 *   - prompt dismissed  → nothing is committed and the stage is dropped (a machine's own stage keeps waiting);
 *   - prompt throws     → the same, and never retried silently;
 *   - no passkey mount  → today's no-passkey words, the stage dropped, and nothing was asked.
 *
 * Nothing here holds a code, seed or token: the seed is never typed, the stages are ids.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { PasteRule, PasteRuleStaged } from '../../../contract/routes/index.ts';
import { RUNS_WHAT_IT_READS_WARNING } from '../../../contract/routes/index.ts';
import { bindPasskeys } from '../../../app/passkeys.ts';
import { PASTE_RULE_NO_PASSKEY_WORDS } from '../../../app/lib/secure-copy.ts';
import { accountsTab, secureCopyTab, signInApprovalRenderer } from '../../../app/surfaces.tsx';
import { type Mounted, mount, must } from '../../support/app/dom.ts';
import { click, settle, typeInto } from '../../support/app/dom-form.ts';
import { answeredClient, fakeClient } from '../../support/app/fake-client.ts';
import { list } from '../../support/app/accounts-fixtures.ts';
import { ruleClient, type RuleWorld } from '../../support/app/sign-in-rule-client.ts';
import { machineStage, pageRule, ruleList, STAGE_ID, suspendedRule } from '../../support/app/sign-in-rule-fixtures.ts';
import { DAEMON, installShellAsk, onMachine, promptAnswers, shellAsks } from '../../support/app/shell-ask.ts';
import {
  approvedPlan,
  codesLine,
  PLAN_ID,
  planOf,
  SESSION,
  STAGE as PLAN_STAGE,
  sudoLine,
} from '../../support/app/task-plan-fixtures.ts';

installShellAsk();

/** A fake client as a test hands it on: only `call`. */
type Callable = { call(route: string, init?: never): Promise<unknown> };

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const draw = async (element: React.ReactElement) => {
  const view = await mount(element);
  mounted.push(view);
  await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return { q, text: () => view.container.textContent ?? '' };
};

/** A control that is not drawn, or drawn off: with nothing able to ask, a widening cannot even be started. */
const closed = (control: HTMLElement | null): boolean =>
  control === null || (control as HTMLButtonElement).disabled === true;

describe('bindPasskeys: which act, which staged id and which machine each ask is for', () => {
  const words = {
    does: 'Ferretry does the thing.',
    rows: [{ label: 'Who', value: 'Any ferret' }],
    warnings: ['A warning.'],
  };
  const record = () => {
    const sent: { daemon: string; request: unknown }[] = [];
    return {
      sent,
      ask: async (daemon: string, request: unknown) => {
        sent.push({ daemon, request });
        return true;
      },
    };
  };

  it('G105 each widening act asks its own act id, bound to its stage, on its machine, with the daemon’s words', async () => {
    const { sent, ask } = record();
    const asks = bindPasskeys(ask as never, DAEMON);

    expect(await asks.signInRule(STAGE_ID, words)).toBe(true);
    expect(await asks.pasteRule(`prs_${'1'.repeat(24)}` as never, words, 'approve-paste-rule')).toBe(true);
    expect(await asks.pasteRule(`prs_${'2'.repeat(24)}` as never, words, 'allow-profile-targets')).toBe(true);
    expect(await asks.taskPlan(PLAN_STAGE, words)).toBe(true);
    expect(await asks.addKey('st_0123456789abcdef01234567' as never, 'save a key for GitHub')).toBe(true);

    expect(sent).toEqual([
      { daemon: DAEMON, request: { actId: 'approve-sign-in-rule', act: words.does, subject: STAGE_ID, words } },
      {
        daemon: DAEMON,
        request: { actId: 'approve-paste-rule', act: words.does, subject: `prs_${'1'.repeat(24)}`, words },
      },
      {
        daemon: DAEMON,
        request: { actId: 'allow-profile-targets', act: words.does, subject: `prs_${'2'.repeat(24)}`, words },
      },
      { daemon: DAEMON, request: { actId: 'approve-task-plan', act: words.does, subject: PLAN_STAGE, words } },
      {
        daemon: DAEMON,
        request: { actId: 'add-2fa-key', act: 'save a key for GitHub', subject: 'st_0123456789abcdef01234567' },
      },
    ]);
  });

  it('G105 a dismissed prompt is false and a thrown one is thrown, never turned into a yes', async () => {
    const dismissed = bindPasskeys((async () => false) as never, DAEMON);
    expect(await dismissed.signInRule(STAGE_ID, words)).toBe(false);
    const broken = bindPasskeys((async () => Promise.reject(new Error('no sheet'))) as never, DAEMON);
    await expect(broken.taskPlan(PLAN_STAGE, words)).rejects.toThrow('no sheet');
  });
});

describe('a paste rule and programs in your own profile', () => {
  const STAGE = `prs_${'1'.repeat(24)}`;
  const PROFILE_STAGE = `prs_${'2'.repeat(24)}`;
  const RULE: PasteRule = {
    id: 'a'.repeat(32),
    from: { kind: 'command', program: 'gh' },
    to: { kind: 'terminal', program: 'bash' },
    used: 0,
    createdAt: '2026-08-05T09:00:00.000Z',
    createdBy: { kind: 'host' },
  };
  const STAGED: PasteRuleStaged = {
    stage: STAGE as PasteRuleStaged['stage'],
    kind: 'rule',
    does: 'Ferretry pastes what gh prints into bash in a terminal, for any ferret on this machine, without asking.',
    rows: [
      { label: 'From', value: 'what gh prints' },
      { label: 'To', value: 'bash in a terminal' },
    ],
    runsAnything: true,
    expiresAt: '2026-11-02T09:02:00.000Z',
  };
  const PROFILE: PasteRuleStaged = {
    stage: PROFILE_STAGE as PasteRuleStaged['stage'],
    kind: 'profile-targets',
    does: 'Paste rules may then paste into programs from your own profile, which any ferret can swap.',
    rows: [{ label: 'Widens', value: 'what gh prints → vercel in a terminal' }],
    runsAnything: false,
    expiresAt: '2026-11-02T09:02:00.000Z',
  };

  /** The Secure copy tab on a machine that stages paste rules; `waiting` are stages the machine made itself. */
  const secureCopy = async (waiting: readonly PasteRuleStaged[] = []) => {
    const copy = fakeClient(call => {
      if (call.method === 'POST' && call.path === '/v1/copy-rules/stages') return STAGED;
      if (call.method === 'POST' && call.path === `/v1/copy-rules/stages/${STAGE}/bind`) return STAGED;
      if (call.method === 'POST' && call.path === '/v1/copy-rules/settings/stages') return PROFILE;
      if (call.method === 'POST' && call.path.endsWith('/commit')) {
        return call.path.includes('/settings/') ? { allowProfileTargets: true } : RULE;
      }
      if (call.method === 'DELETE') return { stage: STAGE, dropped: true };
      if (call.path === '/v1/copy-rules/stages') return { stages: waiting };
      if (call.path === '/v1/copy-rules/settings')
        return { settings: { allowProfileTargets: false }, profileRules: [] };
      return { rules: [] };
    });
    const rules = ruleClient({});
    const client = onMachine({
      call: async (route: string, init?: never) => {
        if (route.includes('/v1/copy-rules')) return await (copy.client as Callable).call(route, init);
        if (route === 'GET /v1/accounts/plans') return { plans: [] };
        if (route === 'GET /v1/sign-in-rules') return ruleList();
        return await rules.client.call(route, init);
      },
    });
    const Tab = secureCopyTab(client as never);
    const screen = await draw(<Tab />);
    const routes = () => copy.calls.map(call => `${call.method} ${call.path}`);
    const addOne = async () => {
      await click(screen.q('[data-copy-rule-add-open]'));
      await typeInto(screen.q('[data-copy-rule-from]'), 'gh');
      await typeInto(screen.q('[data-copy-rule-to]'), 'bash');
      await click(screen.q('[data-copy-rule-form] button[type="submit"]'));
      await settle();
    };
    return { ...screen, routes, addOne };
  };

  it('G105 a new paste rule: confirmed → asked once for approve-paste-rule on this machine, then one commit', async () => {
    promptAnswers('yes');
    const { addOne, routes } = await secureCopy();

    await addOne();

    expect(shellAsks()).toEqual([
      {
        daemon: DAEMON,
        request: {
          actId: 'approve-paste-rule',
          act: STAGED.does,
          subject: STAGE,
          words: { does: STAGED.does, rows: [...STAGED.rows], warnings: [RUNS_WHAT_IT_READS_WARNING] },
        },
      },
    ]);
    expect(routes().filter(route => route.endsWith('/commit'))).toEqual([`POST /v1/copy-rules/stages/${STAGE}/commit`]);
    expect(routes().some(route => route.startsWith('DELETE'))).toBe(false);
  });

  for (const answer of ['no', 'throw'] as const) {
    it(`G105 a new paste rule: prompt ${answer === 'no' ? 'dismissed' : 'thrown'} → no commit, the stage dropped, never asked again`, async () => {
      promptAnswers(answer);
      const { addOne, routes } = await secureCopy();

      await addOne();

      expect(shellAsks()).toHaveLength(1);
      expect(routes().some(route => route.endsWith('/commit'))).toBe(false);
      expect(routes()).toContain(`DELETE /v1/copy-rules/stages/${STAGE}`);
    });
  }

  it('G105 a new paste rule with no passkey mount: today’s no-passkey words, the stage dropped, nothing asked', async () => {
    promptAnswers('none');
    const { addOne, routes, text } = await secureCopy();

    await addOne();

    expect(shellAsks()).toEqual([]);
    expect(routes().some(route => route.endsWith('/commit'))).toBe(false);
    expect(routes()).toContain(`DELETE /v1/copy-rules/stages/${STAGE}`);
    expect(text()).toContain(PASTE_RULE_NO_PASSKEY_WORDS);
  });

  it('G105 programs in your own profile ON: confirmed → asked for allow-profile-targets, then one commit', async () => {
    promptAnswers('yes');
    const { q, routes } = await secureCopy();

    await click(q('[data-copy-profile-targets] input, input[data-copy-profile-targets]'));
    await settle();

    expect(shellAsks().map(each => each.request)).toMatchObject([
      { actId: 'allow-profile-targets', subject: PROFILE_STAGE },
    ]);
    expect(routes().filter(route => route.endsWith('/commit'))).toEqual([
      `POST /v1/copy-rules/settings/stages/${PROFILE_STAGE}/commit`,
    ]);
  });

  for (const answer of ['no', 'throw', 'none'] as const) {
    it(`G105 programs in your own profile ON with the prompt ${answer}: nothing is committed`, async () => {
      promptAnswers(answer);
      const { q, routes } = await secureCopy();

      await click(q('[data-copy-profile-targets] input, input[data-copy-profile-targets]'));
      await settle();

      expect(shellAsks()).toHaveLength(answer === 'none' ? 0 : 1);
      expect(routes().some(route => route.endsWith('/commit'))).toBe(false);
    });
  }

  it('G105 a rule the machine staged: confirmed → taken by this device once, asked, one commit', async () => {
    promptAnswers('yes');
    const { q, routes } = await secureCopy([STAGED]);

    await click(q('[data-copy-rule-waiting-approve]'));
    await settle();

    expect(shellAsks().map(each => each.request)).toMatchObject([{ actId: 'approve-paste-rule', subject: STAGE }]);
    expect(routes().filter(route => route.includes(STAGE))).toEqual([
      `POST /v1/copy-rules/stages/${STAGE}/bind`,
      `POST /v1/copy-rules/stages/${STAGE}/commit`,
    ]);
  });

  for (const answer of ['no', 'throw', 'none'] as const) {
    it(`G105 a rule the machine staged with the prompt ${answer}: no commit, and the machine’s stage is not dropped by a stray tap`, async () => {
      promptAnswers(answer);
      const { q, routes } = await secureCopy([STAGED]);

      await click(q('[data-copy-rule-waiting-approve]'));
      await settle();

      expect(routes().some(route => route.endsWith('/commit'))).toBe(false);
      expect(routes().some(route => route.startsWith('DELETE'))).toBe(false);
    });
  }
});

describe('a standing sign-in rule', () => {
  const secureCopyWith = async (world: RuleWorld) => {
    const rules = ruleClient(world);
    const client = onMachine({
      call: async (route: string, init?: never) => {
        if (route.includes('/v1/copy-rules')) {
          return route.endsWith('/stages')
            ? { stages: [] }
            : route.endsWith('/settings')
              ? { settings: { allowProfileTargets: false }, profileRules: [] }
              : { rules: [] };
        }
        if (route === 'GET /v1/accounts/plans') return { plans: [] };
        return await rules.client.call(route, init);
      },
    });
    const Tab = secureCopyTab(client as never);
    return { rules, ...(await draw(<Tab />)) };
  };
  const commits = (rules: { keys(): string[] }) => rules.keys().filter(key => key.endsWith('/commit'));

  it('G105 approving a suspended rule again: confirmed → asked for approve-sign-in-rule, then one commit', async () => {
    promptAnswers('yes');
    const { q, rules } = await secureCopyWith({ list: ruleList({ rules: [suspendedRule()] }) });

    await click(q('[data-rule-resume]'));
    await click(q('[data-rule-approve]'));
    await settle();

    expect(shellAsks().map(each => each.request)).toMatchObject([{ actId: 'approve-sign-in-rule', subject: STAGE_ID }]);
    expect(commits(rules)).toEqual([`POST /v1/sign-in-rules/stages/${STAGE_ID}/commit`]);
  });

  it('G105 renewing an expired rule: confirmed → asked, then one commit', async () => {
    promptAnswers('yes');
    const { q, rules } = await secureCopyWith({ list: ruleList({ rules: [pageRule({ status: 'expired' })] }) });

    await click(q('[data-rule-renew]'));
    await click(q('[data-rule-approve]'));
    await settle();

    expect(shellAsks()).toHaveLength(1);
    expect(commits(rules)).toHaveLength(1);
  });

  for (const answer of ['no', 'throw'] as const) {
    it(`G105 approving a rule again with the prompt ${answer === 'no' ? 'dismissed' : 'thrown'}: no commit, the stage dropped`, async () => {
      promptAnswers(answer);
      const { q, rules } = await secureCopyWith({ list: ruleList({ rules: [suspendedRule()] }) });

      await click(q('[data-rule-resume]'));
      await click(q('[data-rule-approve]'));
      await settle();

      expect(shellAsks()).toHaveLength(1);
      expect(commits(rules)).toEqual([]);
      expect(rules.keys()).toContain(`DELETE /v1/sign-in-rules/stages/${STAGE_ID}`);
    });
  }

  it('G105 approving a rule again with no passkey mount: approve is off, nothing asked, nothing staged or committed', async () => {
    promptAnswers('none');
    const { q, rules } = await secureCopyWith({ list: ruleList({ rules: [suspendedRule()] }) });

    await click(q('[data-rule-resume]'));
    await settle();

    expect(closed(q('[data-rule-approve]'))).toBe(true);
    expect(shellAsks()).toEqual([]);
    expect(commits(rules)).toEqual([]);
    expect(rules.keys().some(key => key === 'POST /v1/sign-in-rules/stages')).toBe(false);
  });

  it('G105 a rule the machine staged: confirmed → taken once, asked, one commit', async () => {
    promptAnswers('yes');
    const { q, rules } = await secureCopyWith({ list: ruleList({ stages: [machineStage()] }), staged: machineStage() });

    await click(q('[data-rule-machine-confirm]'));
    await settle();

    expect(shellAsks().map(each => each.request)).toMatchObject([{ actId: 'approve-sign-in-rule', subject: STAGE_ID }]);
    expect(rules.keys().filter(key => key.includes(STAGE_ID))).toEqual([
      `POST /v1/sign-in-rules/stages/${STAGE_ID}/bind`,
      `POST /v1/sign-in-rules/stages/${STAGE_ID}/commit`,
    ]);
  });

  for (const answer of ['no', 'throw'] as const) {
    it(`G105 a rule the machine staged with the prompt ${answer === 'no' ? 'dismissed' : 'thrown'}: no commit, the stage dropped`, async () => {
      promptAnswers(answer);
      const { q, rules } = await secureCopyWith({
        list: ruleList({ stages: [machineStage()] }),
        staged: machineStage(),
      });

      await click(q('[data-rule-machine-confirm]'));
      await settle();

      expect(commits(rules)).toEqual([]);
      expect(rules.keys()).toContain(`DELETE /v1/sign-in-rules/stages/${STAGE_ID}`);
    });
  }

  it('G105 a rule the machine staged with no passkey mount: the confirm is off and nothing is asked', async () => {
    promptAnswers('none');
    const { q, rules } = await secureCopyWith({ list: ruleList({ stages: [machineStage()] }), staged: machineStage() });

    expect((q('[data-rule-machine-confirm]') as HTMLButtonElement).disabled).toBe(true);
    expect(shellAsks()).toEqual([]);
    expect(commits(rules)).toEqual([]);
  });
});

describe('the Accounts tab', () => {
  const accounts = async () => {
    const rules = ruleClient({ list: ruleList() });
    const client = onMachine({
      call: async (route: string, init?: never) => {
        if (route === 'GET /v1/accounts') return list();
        if (route === 'GET /v1/accounts/look-alike') return { v: 1, groups: [] };
        return await rules.client.call(route, init);
      },
    });
    const Tab = accountsTab(client as never);
    const screen = await draw(<Tab />);
    await click(screen.q('[data-accounts-row="GITHUB"] button'));
    return { ...screen, rules };
  };

  it('G105 a sign-in’s standing rule: confirmed → asked for approve-sign-in-rule, then one commit', async () => {
    promptAnswers('yes');
    const { q, rules } = await accounts();
    await click(q('[data-accounts-tab="sites"]'));
    await click(q('[data-accounts-signin] button'));
    await click(q('[data-accounts-tab="rule"]'));
    await settle();

    await click(q('[data-rule-start]'));
    await click(q('[data-rule-approve]'));
    await settle();

    expect(shellAsks().map(each => each.request)).toMatchObject([{ actId: 'approve-sign-in-rule', subject: STAGE_ID }]);
    expect(rules.keys().filter(key => key.endsWith('/commit'))).toHaveLength(1);
  });

  it('G105 a sign-in’s standing rule with no passkey mount: nothing asked, no commit', async () => {
    promptAnswers('none');
    const { q, rules } = await accounts();
    await click(q('[data-accounts-tab="sites"]'));
    await click(q('[data-accounts-signin] button'));
    await click(q('[data-accounts-tab="rule"]'));
    await settle();

    await click(q('[data-rule-start]'));
    await settle();

    expect(closed(q('[data-rule-approve]'))).toBe(true);
    expect(shellAsks()).toEqual([]);
    expect(rules.keys().some(key => key.endsWith('/commit'))).toBe(false);
  });

  it('S88 the automatic-codes panel is offered only where a passkey can be asked', async () => {
    promptAnswers('yes');
    const withMount = await accounts();
    await click(withMount.q('[data-accounts-tab="keys"]'));
    expect(withMount.q('[data-codes-panel]')).not.toBeNull();
    expect(withMount.q('[data-accounts-codes-unavailable]')).toBeNull();
  });

  it('S88 with no passkey mount the panel says codes are saved from the app, with a passkey', async () => {
    promptAnswers('none');
    const withoutMount = await accounts();
    await click(withoutMount.q('[data-accounts-tab="keys"]'));
    expect(withoutMount.q('[data-codes-panel]')).toBeNull();
    expect(withoutMount.q('[data-accounts-codes-unavailable]')).not.toBeNull();
  });
});

describe('a task plan’s ticks and a staged 2FA seed, on the ask card', () => {
  const PLAN_PATH = `/v1/ferrets/${SESSION}/task-plans/${PLAN_ID}`;
  const SUMMARY = ['Line 2: sign in to vercel.com as deploy@atomi.cloud, once'];
  const staged = {
    outcome: 'staged',
    staged: {
      stage: PLAN_STAGE,
      plan: PLAN_ID,
      lines: [0],
      codes: [],
      summary: SUMMARY,
      expiresAt: '2026-08-05T11:58:00.000Z',
    },
  };
  const value = (ref: unknown) => ({ ref, ferret: SESSION, ferretName: 'judson', subject: 's', why: 'w' });

  const planCard = async (plan: ReturnType<typeof planOf>, extra: Record<string, unknown> = {}) => {
    const fake = answeredClient({
      'GET /v1/accounts/plans': { plans: [plan] },
      [`POST ${PLAN_PATH}/approval`]: staged,
      [`POST ${PLAN_PATH}/approval/${PLAN_STAGE}/commit`]: approvedPlan(),
      [`DELETE ${PLAN_PATH}/approval/${PLAN_STAGE}`]: { stage: PLAN_STAGE, dropped: true },
      ...extra,
    });
    onMachine(fake.client);
    const Renderer = signInApprovalRenderer(fake.client);
    const screen = await draw(<Renderer value={value({ kind: 'task-plan', planId: PLAN_ID })} />);
    const methods = () => fake.calls.map(call => `${call.method} ${call.path}`);
    return { ...screen, methods };
  };
  const tickAndAllow = async (q: (selector: string) => HTMLElement | null) => {
    await click(q('[data-task-plan-tick="0"]'));
    await click(q('[data-task-plan-allow]'));
    await settle();
  };

  it('G105 ticks approved: asked for approve-task-plan bound to the stage, then one commit', async () => {
    promptAnswers('yes');
    const { q, methods } = await planCard(planOf({ lines: [sudoLine(0)] }));

    await tickAndAllow(q);

    expect(shellAsks()).toHaveLength(1);
    expect(shellAsks()[0]).toMatchObject({
      daemon: DAEMON,
      request: { actId: 'approve-task-plan', subject: PLAN_STAGE },
    });
    expect(methods().filter(route => route.endsWith('/commit'))).toHaveLength(1);
    expect(methods().some(route => route.startsWith('DELETE'))).toBe(false);
  });

  for (const answer of ['no', 'throw'] as const) {
    it(`G105 ticks with the prompt ${answer === 'no' ? 'dismissed' : 'thrown'}: no commit, the stage dropped, asked once`, async () => {
      promptAnswers(answer);
      const { q, methods } = await planCard(planOf({ lines: [sudoLine(0)] }));

      await tickAndAllow(q);

      expect(shellAsks()).toHaveLength(1);
      expect(methods().some(route => route.endsWith('/commit'))).toBe(false);
      expect(methods()).toContain(`DELETE ${PLAN_PATH}/approval/${PLAN_STAGE}`);
    });
  }

  it('G105 ticks with no passkey mount: the line cannot be ticked, nothing is staged or asked', async () => {
    promptAnswers('none');
    const { q, methods } = await planCard(planOf({ lines: [sudoLine(0)] }));

    expect(closed(q('[data-task-plan-tick="0"]'))).toBe(true);
    expect(closed(q('[data-task-plan-allow]'))).toBe(true);
    expect(shellAsks()).toEqual([]);
    expect(methods().some(route => route.includes('/approval'))).toBe(false);
  });

  describe('a selection the machine staged', () => {
    const machinePlan = () => ({
      ...planOf({ lines: [codesLine(0), sudoLine(1)] }),
      machineStage: { stage: PLAN_STAGE, lines: [1], askedAt: '2026-08-05T14:02:00.000Z' },
    });
    const view = { ...staged.staged, lines: [1], state: 'waiting' };
    const world = { [`GET ${PLAN_PATH}/approval/${PLAN_STAGE}`]: view };

    it('G105 confirmed → asked once, then one commit', async () => {
      promptAnswers('yes');
      const { q, methods } = await planCard(machinePlan() as never, world);

      await click(q('[data-task-plan-machine-confirm]'));
      await settle();

      expect(shellAsks().map(each => each.request)).toMatchObject([
        { actId: 'approve-task-plan', subject: PLAN_STAGE },
      ]);
      expect(methods().filter(route => route.endsWith('/commit'))).toHaveLength(1);
    });

    for (const answer of ['no', 'throw'] as const) {
      it(`G105 prompt ${answer === 'no' ? 'dismissed' : 'thrown'} → no commit, and the machine’s own stage keeps waiting`, async () => {
        promptAnswers(answer);
        const { q, methods } = await planCard(machinePlan() as never, world);

        await click(q('[data-task-plan-machine-confirm]'));
        await settle();

        expect(shellAsks()).toHaveLength(1);
        expect(methods().some(route => route.endsWith('/commit'))).toBe(false);
        expect(methods().some(route => route.startsWith('DELETE'))).toBe(false);
      });
    }

    it('G105 no passkey mount → nothing asked, no commit', async () => {
      promptAnswers('none');
      const { q, methods } = await planCard(machinePlan() as never, world);

      await click(q('[data-task-plan-machine-confirm]'));
      await settle();

      expect(shellAsks()).toEqual([]);
      expect(methods().some(route => route.endsWith('/commit'))).toBe(false);
    });
  });

  describe('a staged 2FA seed', () => {
    const SEED_STAGE = 'st_0123456789abcdef01234567';
    const saved = { account: 'GITHUB', factor: must(list().accounts[0]?.factors[1], 'a 2FA key'), mismatch: false };
    const seedCard = async () => {
      const fake = answeredClient({
        'GET /v1/accounts': list(),
        [`GET /v1/accounts/seed-stages/${SEED_STAGE}`]: {
          stage: SEED_STAGE,
          account: 'GITHUB',
          label: 'Authenticator',
          state: 'waiting',
          expiresAt: '2026-11-07T00:00:00.000Z',
          mismatch: false,
        },
        [`POST /v1/accounts/GITHUB/factors/seed/${SEED_STAGE}/commit`]: saved,
      });
      onMachine(fake.client);
      const Renderer = signInApprovalRenderer(fake.client);
      const screen = await draw(<Renderer value={value({ kind: 'two-factor-seed', stage: SEED_STAGE })} />);
      return { ...screen, methods: () => fake.calls.map(call => `${call.method} ${call.path}`) };
    };

    it('S88 confirmed → asked for add-2fa-key bound to the stage, then one commit', async () => {
      promptAnswers('yes');
      const { q, methods } = await seedCard();

      await click(q('[data-seed-warning-tick]'));
      await click(q('[data-seed-allow]'));
      await settle();

      expect(shellAsks()).toHaveLength(1);
      expect(shellAsks()[0]).toMatchObject({ daemon: DAEMON, request: { actId: 'add-2fa-key', subject: SEED_STAGE } });
      expect(methods().filter(route => route.endsWith('/commit'))).toHaveLength(1);
    });

    for (const answer of ['no', 'throw'] as const) {
      it(`S88 prompt ${answer === 'no' ? 'dismissed' : 'thrown'} → nothing saved, asked once`, async () => {
        promptAnswers(answer);
        const { q, methods } = await seedCard();

        await click(q('[data-seed-warning-tick]'));
        await click(q('[data-seed-allow]'));
        await settle();

        expect(shellAsks()).toHaveLength(1);
        expect(methods().some(route => route.endsWith('/commit'))).toBe(false);
      });
    }

    it('S88 no passkey mount → nothing asked, nothing saved, said plainly', async () => {
      promptAnswers('none');
      const { q, methods, text } = await seedCard();

      await click(q('[data-seed-warning-tick]'));
      await click(q('[data-seed-allow]'));
      await settle();

      expect(shellAsks()).toEqual([]);
      expect(methods().some(route => route.endsWith('/commit'))).toBe(false);
      expect(text()).toContain('cannot confirm with a passkey');
    });
  });
});

describe('a client the shell did not make names no machine', () => {
  it('G105 so nothing is asked and every widening keeps the no-passkey path (fail closed)', async () => {
    promptAnswers('yes');
    const rules = ruleClient({ list: ruleList({ rules: [suspendedRule()] }) });
    // Not tagged with onMachine(): `daemonOfClient` knows no machine for it.
    const client = {
      call: async (route: string, init?: never) => {
        if (route.includes('/v1/copy-rules'))
          return route.endsWith('/stages')
            ? { stages: [] }
            : route.endsWith('/settings')
              ? { settings: { allowProfileTargets: false }, profileRules: [] }
              : { rules: [] };
        if (route === 'GET /v1/accounts/plans') return { plans: [] };
        return await rules.client.call(route, init);
      },
    };
    const Tab = secureCopyTab(client as never);
    const { q } = await draw(<Tab />);

    await click(q('[data-rule-resume]'));
    await settle();

    expect(closed(q('[data-rule-approve]'))).toBe(true);
    expect(shellAsks()).toEqual([]);
    expect(rules.keys().some(key => key.endsWith('/commit'))).toBe(false);
  });
});
