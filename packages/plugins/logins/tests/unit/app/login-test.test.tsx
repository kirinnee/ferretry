import { describe, expect, it } from 'bun:test';
import type { LoginTestAct } from '../../../contract/index.ts';
import { LoginScopeChip } from '../../../app/components/login-scope-chip.tsx';
import { LoginTest } from '../../../app/features/login-test.tsx';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';

const TEST = 'POST /v1/logins/:loginId/test';

const passed = (spent: 'nothing' | 'one-token' = 'nothing') => ({
  loginId: 'zai-glm',
  ok: true,
  code: 'ok',
  message: 'The provider accepted this login.',
  spent,
  at: '2026-10-16T08:00:00.000Z',
});

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

const openTest = async (act: LoginTestAct, answer: unknown) => {
  const calls: Call[] = [];
  const client = scripted({ [TEST]: answer }, calls);
  const view = await mount(<LoginTest loginId="zai-glm" act={act} client={client} />);
  return { view, calls };
};

describe('LoginTest', () => {
  it('says why there is no Test when the login cannot be tested', async () => {
    const { view } = await openTest({ available: false, reason: 'Bedrock needs signing.' }, passed());
    expect(view.container.textContent).toBe('No Test: Bedrock needs signing.');
    await view.unmount();
  });

  it('sends a free Test at once and shows that it passed', async () => {
    const { view, calls } = await openTest({ available: true, spends: 'nothing', note: 'Free read.' }, passed());
    expect(view.container.textContent).toContain('Free read.');
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    await until(() => view.container.querySelector('[data-login-test-result]') !== null, 'the result');
    expect(view.container.querySelector('[data-login-test-result]')?.textContent).toBe('Test passed — nothing spent.');
    expect(calls.map(call => call.body)).toEqual([{}]);
    await view.unmount();
  });

  it('asks before a one-token Test, sends nothing on Cancel, and consents on Send', async () => {
    const { view, calls } = await openTest(
      { available: true, spends: 'one-token', note: 'One token.' },
      { ...passed('one-token'), ok: false, code: 'rejected', message: 'The provider refused this key.' },
    );
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    expect(view.container.querySelector('[data-login-test-consent]')?.textContent).toContain('one token');
    await click(view.container.querySelector('[data-login-test-cancel]'), 'Cancel');
    expect(view.container.querySelector('[data-login-test-consent]')).toBeNull();
    expect(calls).toHaveLength(0);
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    await click(view.container.querySelector('[data-login-test-send]'), 'Send');
    await until(() => view.container.querySelector('[data-login-test-result]') !== null, 'the result');
    expect(view.container.querySelector('[data-login-test-result="rejected"]')?.textContent).toBe(
      'The provider refused this key.',
    );
    expect(calls.map(call => call.body)).toEqual([{ allowInference: true }]);
    await view.unmount();
  });

  it('says the daemon’s refusal when the Test could not run', async () => {
    const refusal = Object.assign(new Error('x'), {
      status: 409,
      code: 'logins_unavailable',
      message: 'Only a login made from environment variables has a Test.',
    });
    const { view } = await openTest({ available: true, spends: 'nothing', note: 'Free read.' }, refusal);
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    await until(() => view.container.querySelector('[data-login-test-failure]') !== null, 'the failure');
    expect(view.container.querySelector('[data-login-test-failure]')?.textContent).toBe(
      'Only a login made from environment variables has a Test.',
    );
    await view.unmount();
  });
});

describe('LoginScopeChip', () => {
  it('names the one CLI a login drives, or both', async () => {
    const view = await mount(
      <p>
        <LoginScopeChip harnesses={['claude-code']} />
        <LoginScopeChip harnesses={['codex']} />
        <LoginScopeChip harnesses={['claude-code', 'codex']} />
      </p>,
    );
    expect(view.container.textContent).toBe('Claude onlyCodex onlyClaude + Codex');
    expect(
      Array.from(view.container.querySelectorAll('[data-login-scope]')).map(chip =>
        chip.getAttribute('data-login-scope'),
      ),
    ).toEqual(['claude-code', 'codex', 'both']);
    await view.unmount();
  });
});
