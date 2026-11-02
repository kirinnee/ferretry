/** The task-plan card's promises (docs/secure-copy.md "Task plans"): nothing starts ticked, and the owner only narrows. */

import { describe, expect, it } from 'bun:test';
import { TaskPlanCard } from '../../src/features/secure-copy/task-plan-card.tsx';
import {
  approvalOf,
  HONEST_CLIENT_LINE,
  initialTicks,
  mayTick,
  NO_HISTORY_WORDS,
  PICK_FIRST_WORDS,
  TOTP_IMPOSSIBLE_WORDS,
  TOTP_TICK_WARNING,
  totpState,
  withPick,
  withTicked,
} from '../../src/lib/task-plan.ts';
import { interact, mount, must } from '../support/dom.ts';
import {
  approvedPlan,
  cannotLine,
  codesLine,
  GITHUB_HOME,
  GITHUB_WORK,
  mixedPlan,
  passwordOnlyLine,
  pickerLine,
  planOf,
  STAGE,
  sudoLine,
} from '../support/task-plan-fixtures.ts';

const noop = (): void => undefined;

const card = (plan = mixedPlan(), approve: (approval: ReturnType<typeof approvalOf>) => void = noop) => (
  <TaskPlanCard
    agentName="Hadi"
    canUsePasskey
    onApprove={approve}
    onConfirmMachine={noop}
    onDenyMachine={noop}
    onRevoke={noop}
    phase={{ kind: 'idle' }}
    plan={plan}
  />
);

const q = <T extends Element>(root: ParentNode, selector: string, what: string): T =>
  must(root.querySelector<T>(selector), what);

describe('the ticks a plan starts with', () => {
  it('ticks nothing, even a line with one account and a ferret-preselected one', () => {
    const ticks = initialTicks(mixedPlan());
    for (const tick of Object.values(ticks)) expect(tick.ticked).toBe(false);
    expect(approvalOf(mixedPlan(), ticks).lines).toEqual([]);
  });

  it('leaves a picker line without an account, and refuses to tick it until one is picked', () => {
    const plan = planOf({ lines: [pickerLine(0)] });
    const line = plan.lines[0];
    const ticks = initialTicks(plan);
    expect(ticks[0]?.signIn).toBeUndefined();
    expect(mayTick(must(line, 'line'), ticks[0])).toBe(false);
    expect(approvalOf(plan, withTicked(plan, ticks, 0, true)).lines).toEqual([]);
    const picked = withPick(ticks, 0, GITHUB_WORK);
    expect(mayTick(must(line, 'line'), picked[0])).toBe(true);
    expect(approvalOf(plan, withTicked(plan, picked, 0, true)).lines).toEqual([{ line: 0, signIn: GITHUB_WORK }]);
  });

  it('asks for a code only where the ferret asked, the account can and the owner ticked it', () => {
    const plan = planOf({ lines: [passwordOnlyLine(0), cannotLine(1), codesLine(2)] });
    const ticks = initialTicks(plan);
    expect(totpState(must(plan.lines[0], 'line 0'), ticks[0])).toBe('not-asked');
    expect(totpState(must(plan.lines[1], 'line 1'), ticks[1])).toBe('impossible');
    expect(totpState(must(plan.lines[2], 'line 2'), ticks[2])).toBe('available');
  });
});

describe('the card, drawn', () => {
  it('starts with every box unticked and the honest-client line on it', async () => {
    const mounted = await mount(card());
    try {
      for (const box of mounted.container.querySelectorAll<HTMLInputElement>('[data-task-plan-tick]'))
        expect(box.checked).toBe(false);
      expect(q(mounted.container, '[data-task-plan-honest]', 'the honest-client line').textContent).toContain(
        HONEST_CLIENT_LINE,
      );
      expect(q<HTMLButtonElement>(mounted.container, '[data-task-plan-allow]', 'allow').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('will not tick a picker line until an account is picked', async () => {
    const mounted = await mount(card(planOf({ lines: [pickerLine(0)] })));
    try {
      const tick = q<HTMLInputElement>(mounted.container, '[data-task-plan-tick="0"]', 'tick');
      expect(tick.disabled).toBe(true);
      expect(mounted.container.textContent).toContain(PICK_FIRST_WORDS);
      const pick = q<HTMLSelectElement>(mounted.container, '[data-task-plan-pick="0"]', 'picker');
      await interact(() => {
        pick.value = GITHUB_WORK;
        pick.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(q<HTMLInputElement>(mounted.container, '[data-task-plan-tick="0"]', 'tick').disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('hides the code tick when no code was asked, and disables it where the account cannot make one', async () => {
    const mounted = await mount(card(planOf({ lines: [passwordOnlyLine(0), cannotLine(1)] })));
    try {
      expect(mounted.container.querySelector('[data-task-plan-code-tick="0"]')).toBeNull();
      const impossible = q<HTMLInputElement>(mounted.container, '[data-task-plan-code-tick="1"]', 'code tick');
      expect(impossible.disabled).toBe(true);
      expect(mounted.container.textContent).toContain(TOTP_IMPOSSIBLE_WORDS);
    } finally {
      await mounted.unmount();
    }
  });

  it('shows the red one-factor warning beside the code tick, and the root and no-history flags', async () => {
    const mounted = await mount(card(planOf({ lines: [codesLine(0), sudoLine(1)] })));
    try {
      expect(q(mounted.container, '[data-task-plan-one-factor]', 'warning').textContent).toBe(TOTP_TICK_WARNING);
      const code = q<HTMLInputElement>(mounted.container, '[data-task-plan-code-tick="0"]', 'code');
      expect(code.disabled).toBe(true);
      await interact(() => q<HTMLInputElement>(mounted.container, '[data-task-plan-tick="0"]', 'tick').click());
      await interact(() => q<HTMLInputElement>(mounted.container, '[data-task-plan-code-tick="0"]', 'code').click());
      expect(q<HTMLInputElement>(mounted.container, '[data-task-plan-code-tick="0"]', 'code').checked).toBe(true);
      expect(mounted.container.textContent).toContain(NO_HISTORY_WORDS);
      expect(q(mounted.container, '[data-task-plan-root]', 'root line').textContent).toContain('kirin-box');
    } finally {
      await mounted.unmount();
    }
  });

  it('sends exactly what is ticked', async () => {
    const sent: ReturnType<typeof approvalOf>[] = [];
    const mounted = await mount(card(planOf({ lines: [codesLine(0), sudoLine(1)] }), approval => sent.push(approval)));
    try {
      await interact(() => q<HTMLInputElement>(mounted.container, '[data-task-plan-tick="1"]', 'tick').click());
      await interact(() => q<HTMLButtonElement>(mounted.container, '[data-task-plan-allow]', 'allow').click());
      expect(sent).toHaveLength(1);
      expect(sent[0]?.lines.map(line => line.line)).toEqual([1]);
    } finally {
      await mounted.unmount();
    }
  });

  it('says nothing is ticked only while nothing is, and keeps each line keeping its own number once approved', async () => {
    const mounted = await mount(card());
    try {
      expect(mounted.container.textContent).toContain('Nothing is ticked yet.');
      await interact(() => q<HTMLInputElement>(mounted.container, '[data-task-plan-tick="1"]', 'tick').click());
      expect(mounted.container.textContent).not.toContain('Nothing is ticked yet.');
    } finally {
      await mounted.unmount();
    }
    const settled = await mount(card(approvedPlan()));
    try {
      const text = settled.container.textContent ?? '';
      expect(text).toContain('You allowed lines 1 and 4');
      expect(text).toContain('Line 4 ·');
      expect(text).toContain('Line 3 ·');
    } finally {
      await settled.unmount();
    }
  });

  it('shows an approved plan with its uses left and a revoke, and none of the ticking', async () => {
    const mounted = await mount(card(approvedPlan()));
    try {
      expect(mounted.container.querySelector('[data-task-plan-tick]')).toBeNull();
      expect(mounted.container.querySelector('[data-task-plan-revoke]')).not.toBeNull();
      expect(mounted.container.querySelector('[data-task-plan-revoke-all]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});

const codeOnlyLine = (line: number) => ({ ...codesLine(line), fields: ['totp' as const], preselect: undefined });

const withStage = (plan: ReturnType<typeof mixedPlan>, lines: readonly number[]) => ({
  ...plan,
  machineStage: { stage: STAGE, lines: [...lines], askedAt: '2026-08-05T14:02:00.000Z' },
});

describe('the ticking card, in more states', () => {
  it('says why a ticked account cannot be ticked twice, and lets the first stand', async () => {
    const twin = { ...codesLine(1), why: 'Check the logs' };
    const mounted = await mount(card(planOf({ lines: [codesLine(0), twin] })));
    try {
      await interact(() => q<HTMLInputElement>(mounted.container, '[data-task-plan-tick="0"]', 'tick').click());
      expect(q(mounted.container, '[data-task-plan-taken]', 'the taken line').textContent).toContain('already uses');
      expect(q<HTMLInputElement>(mounted.container, '[data-task-plan-tick="1"]', 'second tick').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('treats a line that asks only for a code as one tick, with the warning and no second box', async () => {
    const mounted = await mount(card(planOf({ lines: [codeOnlyLine(0)] })));
    try {
      expect(mounted.container.querySelector('[data-task-plan-code-tick]')).toBeNull();
      expect(q(mounted.container, '[data-task-plan-one-factor]', 'warning').textContent).toBe(TOTP_TICK_WARNING);
    } finally {
      await mounted.unmount();
    }
    const cannot = await mount(card(planOf({ lines: [{ ...codeOnlyLine(0), candidates: cannotLine(0).candidates }] })));
    try {
      expect(q(cannot.container, '[data-task-plan-one-factor]', 'impossible').textContent).toBe(TOTP_IMPOSSIBLE_WORDS);
    } finally {
      await cannot.unmount();
    }
  });

  it('hides the code box and the no-codes words until an account is picked on a picker line', async () => {
    const mounted = await mount(card(planOf({ lines: [pickerLine(0)] })));
    try {
      expect(mounted.container.querySelector('[data-task-plan-code-tick]')).toBeNull();
      expect(mounted.container.textContent).not.toContain(TOTP_IMPOSSIBLE_WORDS);
      const pick = q<HTMLSelectElement>(mounted.container, '[data-task-plan-pick="0"]', 'picker');
      await interact(() => {
        pick.value = GITHUB_HOME;
        pick.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(mounted.container.textContent).toContain(TOTP_IMPOSSIBLE_WORDS);
      const again = q<HTMLSelectElement>(mounted.container, '[data-task-plan-pick="0"]', 'picker again');
      await interact(() => {
        again.value = '';
        again.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(mounted.container.textContent).not.toContain(TOTP_IMPOSSIBLE_WORDS);
    } finally {
      await mounted.unmount();
    }
  });

  it('names su and doas where the account is a su or doas account, and sudo, su or doas while it is not known', async () => {
    const su = sudoLine(0);
    const first = su.candidates[0];
    if (first === undefined) throw new Error('no candidate');
    const suLine = { ...su, candidates: [{ ...first, place: { ...first.place, tool: 'su' } }] };
    const mounted = await mount(card(planOf({ lines: [suLine] })));
    try {
      expect(q(mounted.container, '[data-task-plan-root]', 'root').textContent).toContain('into su on kirin-box');
    } finally {
      await mounted.unmount();
    }
  });

  it('flags root only on a sudo, su or doas line that is offered, never on an unavailable ssh line', async () => {
    const ssh = {
      ...sudoLine(0),
      state: 'unavailable' as const,
      because: 'tool-not-covered' as const,
      flags: [] as never[],
    };
    const first = ssh.candidates[0];
    if (first === undefined) throw new Error('no candidate');
    const unavailable = {
      ...ssh,
      candidates: [{ ...first, place: { ...first.place, tool: 'ssh', dest: 'deploy.example.com' } }],
    };
    const mounted = await mount(card(planOf({ lines: [unavailable, sudoLine(1)] })));
    try {
      const flagged = [...mounted.container.querySelectorAll('[data-task-plan-line]')].map(
        each => each.querySelector('[data-task-plan-root]') !== null,
      );
      expect(flagged).toEqual([false, true]);
      expect(mounted.container.textContent).not.toContain('into ssh');
    } finally {
      await mounted.unmount();
    }
  });

  it('lists every secret-store overwrite and stopped-line case under what you will still be asked', async () => {
    const mounted = await mount(card());
    try {
      const text = q(mounted.container, '[data-task-plan-still-asked]', 'still asked').textContent ?? '';
      expect(text).toContain('A paste that would replace a secret the store already holds');
      expect(text).toContain('any program but sudo, su and doas');
    } finally {
      await mounted.unmount();
    }
  });

  it('says why Allow is off, and shows a failed and a dismissed approval', async () => {
    const plan = planOf({ lines: [codesLine(0)] });
    const failed = await mount(
      <TaskPlanCard
        agentName="Hadi"
        canUsePasskey={false}
        onApprove={noop}
        onConfirmMachine={noop}
        onDenyMachine={noop}
        onRevoke={noop}
        phase={{ kind: 'failed', words: 'The daemon said no.' }}
        plan={plan}
      />,
    );
    try {
      expect(q(failed.container, '[data-task-plan-failure]', 'failure').textContent).toBe('The daemon said no.');
      expect(q(failed.container, '[data-task-plan-allow-why]', 'why').textContent).toContain('Tick at least one');
    } finally {
      await failed.unmount();
    }
    const dismissed = await mount(
      <TaskPlanCard
        agentName="Hadi"
        canUsePasskey
        onApprove={noop}
        onConfirmMachine={noop}
        onDenyMachine={noop}
        onRevoke={noop}
        phase={{ kind: 'dismissed' }}
        plan={plan}
      />,
    );
    try {
      expect(q(dismissed.container, '[data-task-plan-dismissed]', 'dismissed').textContent).toContain('dismissed');
    } finally {
      await dismissed.unmount();
    }
  });

  it('declines everything with an empty approval', async () => {
    const sent: ReturnType<typeof approvalOf>[] = [];
    const mounted = await mount(card(mixedPlan(), approval => sent.push(approval)));
    try {
      await interact(() => q<HTMLButtonElement>(mounted.container, '[data-task-plan-decline]', 'decline').click());
      expect(sent).toEqual([{ lines: [] }]);
    } finally {
      await mounted.unmount();
    }
  });

  it('shows a line that cannot be pre-approved with the daemon’s reason, and no box to tick', async () => {
    const stopped = { ...cannotLine(0), state: 'unavailable' as const, because: 'not-in-accounts' as const };
    const mounted = await mount(card(planOf({ lines: [stopped] })));
    try {
      expect(mounted.container.querySelector('[data-task-plan-tick]')).toBeNull();
      expect(q(mounted.container, '[data-task-plan-line-status]', 'status').textContent).toContain(
        "it isn't in Accounts",
      );
    } finally {
      await mounted.unmount();
    }
  });
});

describe('a selection staged at the machine', () => {
  const staged = (plan: ReturnType<typeof mixedPlan>, overrides: Partial<Parameters<typeof TaskPlanCard>[0]> = {}) => (
    <TaskPlanCard
      agentName="Hadi"
      canUsePasskey
      onApprove={noop}
      onConfirmMachine={noop}
      onDenyMachine={noop}
      onRevoke={noop}
      phase={{ kind: 'idle' }}
      plan={plan}
      {...overrides}
    />
  );

  it('shows the daemon’s summary, and every warning the ticking card gives the same lines', async () => {
    const plan = withStage(mixedPlan(), [1, 2]);
    const summary = [
      'Line 2: sign in as deploy@atomi.cloud with its username, password and code, once',
      'Line 3: type the password of kirin; this gives the ferret root there, once',
    ];
    const mounted = await mount(staged(plan, { machineCodes: [1], machineSummary: summary }));
    try {
      expect(mounted.container.querySelector('[data-task-plan-state="machine-staged"]')).not.toBeNull();
      expect(q(mounted.container, '[data-task-plan-machine]', 'words').textContent).toContain('lines 2 and 3');
      expect(q(mounted.container, '[data-task-plan-machine-summary]', 'summary').textContent).toContain(
        summary[0] ?? '',
      );
      expect(q(mounted.container, '[data-task-plan-one-factor]', 'code warning').textContent).toContain(
        TOTP_TICK_WARNING,
      );
      expect(q(mounted.container, '[data-task-plan-root]', 'root').textContent).toContain('root on kirin-box');
      expect(q(mounted.container, '[data-task-plan-flag="no-history"]', 'no history').textContent).toContain(
        NO_HISTORY_WORDS,
      );
      expect(q(mounted.container, '[data-task-plan-still-asked]', 'still asked')).not.toBeNull();
      expect(q(mounted.container, '[data-task-plan-expiry]', 'expiry').textContent).toContain('UTC');
      expect(mounted.container.querySelectorAll('[data-task-plan-line]')).toHaveLength(2);
      expect(mounted.container.textContent).toContain('says: “Restart the build agent”');
    } finally {
      await mounted.unmount();
    }
  });

  it('warns about a code until the daemon says there is none, and leaves a picker line’s root words general', async () => {
    const plan = withStage(planOf({ lines: [codesLine(0), pickerLine(1), passwordOnlyLine(2)] }), [0, 1, 2]);
    const waiting = await mount(staged(plan));
    try {
      expect(waiting.container.querySelector('[data-task-plan-machine-summary]')).toBeNull();
      expect(waiting.container.querySelectorAll('[data-task-plan-one-factor]').length).toBeGreaterThan(0);
    } finally {
      await waiting.unmount();
    }
    const read = await mount(staged(plan, { machineCodes: [], machineSummary: ['Line 1: sign in, once'] }));
    try {
      expect(read.container.querySelector('[data-task-plan-one-factor]')).toBeNull();
    } finally {
      await read.unmount();
    }
  });

  it('still warns about the code when the summary is clipped before it says so (a long account)', async () => {
    const plan = withStage(planOf({ lines: [codesLine(0)] }), [0]);
    const clipped = `Line 1: sign in as ${'deploy-account-with-a-very-long-name@'.repeat(6)}`.slice(0, 239).concat('…');
    expect(clipped).not.toMatch(/codes?/u);
    const mounted = await mount(staged(plan, { machineCodes: [0], machineSummary: [clipped] }));
    try {
      expect(q(mounted.container, '[data-task-plan-one-factor]', 'code warning').textContent).toContain(
        TOTP_TICK_WARNING,
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('confirms and denies, and says what is happening, what went wrong and what a missing passkey means', async () => {
    const plan = withStage(mixedPlan(), [3]);
    const taps: string[] = [];
    const mounted = await mount(
      staged(plan, { onConfirmMachine: () => taps.push('confirm'), onDenyMachine: () => taps.push('deny') }),
    );
    try {
      await interact(() =>
        q<HTMLButtonElement>(mounted.container, '[data-task-plan-machine-confirm]', 'confirm').click(),
      );
      await interact(() => q<HTMLButtonElement>(mounted.container, '[data-task-plan-machine-deny]', 'deny').click());
      expect(taps).toEqual(['confirm', 'deny']);
    } finally {
      await mounted.unmount();
    }
    for (const [phase, selector] of [
      [{ kind: 'working', progress: 'passkey' }, '[data-task-plan-progress="passkey"]'],
      [{ kind: 'dismissed' }, '[data-task-plan-dismissed]'],
      [{ kind: 'failed', words: 'Nope.' }, '[data-task-plan-failure]'],
    ] as const) {
      const view = await mount(staged(plan, { phase }));
      try {
        expect(view.container.querySelector(selector)).not.toBeNull();
      } finally {
        await view.unmount();
      }
    }
    const noPasskey = await mount(staged(plan, { canUsePasskey: false }));
    try {
      expect(noPasskey.container.querySelector('[data-task-plan-no-passkey]')).not.toBeNull();
      expect(q<HTMLButtonElement>(noPasskey.container, '[data-task-plan-machine-confirm]', 'confirm').disabled).toBe(
        true,
      );
    } finally {
      await noPasskey.unmount();
    }
  });
});

describe('the settled card', () => {
  const settled = (plan: ReturnType<typeof mixedPlan>, onRevoke: (lines?: readonly number[]) => void = noop) => (
    <TaskPlanCard
      agentName="Hadi"
      canUsePasskey
      onApprove={noop}
      onConfirmMachine={noop}
      onDenyMachine={noop}
      onRevoke={onRevoke}
      phase={{ kind: 'idle' }}
      plan={plan}
    />
  );

  it('names the approved account, flags a ticked code, says when it was answered and keeps the honest line', async () => {
    const mounted = await mount(settled(approvedPlan()));
    try {
      const text = mounted.container.textContent ?? '';
      expect(q(mounted.container, '[data-task-plan-account]', 'account').textContent).toBe(
        'Account: github work · kirin@atomi.cloud',
      );
      expect(q(mounted.container, '[data-task-plan-one-factor]', 'code').textContent).toContain(
        'Includes the 2FA code',
      );
      expect(text).toContain('Answered at ');
      expect(q(mounted.container, '[data-task-plan-honest]', 'honest').textContent).toContain(HONEST_CLIENT_LINE);
      expect(text).toContain('Not allowed');
    } finally {
      await mounted.unmount();
    }
  });

  it('names a root account approved, and revokes one line or all of them', async () => {
    const asked: (readonly number[] | undefined)[] = [];
    const plan = {
      ...approvedPlan(),
      lines: [
        ...approvedPlan().lines.slice(0, 2),
        {
          ...sudoLine(2),
          state: 'approved' as const,
          approved: { signIn: sudoLine(2).candidates[0]?.signIn ?? '', totp: false, remaining: 1 },
        },
        ...approvedPlan().lines.slice(3),
      ],
    };
    const parsed = planOf({ ...plan, lines: plan.lines });
    const mounted = await mount(settled(parsed, lines => asked.push(lines)));
    try {
      expect(q(mounted.container, '[data-task-plan-root]', 'root').textContent).toContain('root on kirin-box');
      await interact(() =>
        q<HTMLButtonElement>(mounted.container, '[data-task-plan-revoke="2"]', 'revoke line').click(),
      );
      await interact(() =>
        q<HTMLButtonElement>(mounted.container, '[data-task-plan-revoke-all]', 'revoke all').click(),
      );
      expect(asked).toEqual([[2], undefined]);
    } finally {
      await mounted.unmount();
    }
  });

  it('offers no revoke once the plan is over, and shows a failed revoke', async () => {
    const revoked = { ...approvedPlan(), state: 'revoked' as const };
    const over = await mount(settled(revoked));
    try {
      expect(over.container.querySelector('[data-task-plan-revoke]')).toBeNull();
      expect(over.container.querySelector('[data-task-plan-revoke-all]')).toBeNull();
    } finally {
      await over.unmount();
    }
    const failed = await mount(
      <TaskPlanCard
        agentName="Hadi"
        canUsePasskey
        onApprove={noop}
        onConfirmMachine={noop}
        onDenyMachine={noop}
        onRevoke={noop}
        phase={{ kind: 'failed', words: 'Could not revoke.' }}
        plan={approvedPlan()}
      />,
    );
    try {
      expect(q(failed.container, '[data-task-plan-failure]', 'failure').textContent).toBe('Could not revoke.');
    } finally {
      await failed.unmount();
    }
  });
});
