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
  GITHUB_WORK,
  mixedPlan,
  passwordOnlyLine,
  pickerLine,
  planOf,
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
