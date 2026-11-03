import { afterEach, describe, expect, it } from 'bun:test';
import type { SpeedupProvider, SpeedupsView, SpeedupTestResult } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { OnboardingSpeedupsStep } from '../../../../../src/features/fleet/setup/speedups-step.tsx';
import type { MachineTabProps } from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { type Call, machineView, STUDIO, scriptedClient } from './setup-support.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const SPEEDUPS_PATH = '/v1/speedups';
const SECRETS_PATH = '/v1/secrets';
const testPath = (provider: SpeedupProvider): string => `/v1/speedups/${provider}/test`;

const LABELS: Readonly<Record<SpeedupProvider, string>> = { jev: 'Jev', groq: 'Groq', cerebras: 'Cerebras' };
const SECRETS: Readonly<Record<SpeedupProvider, string>> = {
  jev: 'JEV_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
};

const view = (set: readonly SpeedupProvider[] = [], vault: SpeedupsView['vault'] = 'ok'): SpeedupsView => ({
  vault,
  providers: (['jev', 'groq', 'cerebras'] as const).map(provider => ({
    provider,
    label: LABELS[provider],
    purpose: `${LABELS[provider]} purpose.`,
    costNote: 'Well under a cent.',
    privacyNote: 'Text goes to the vendor.',
    keyUrl: `https://keys.example.test/${provider}`,
    testNote: 'One call.',
    secretName: SECRETS[provider],
    set: set.includes(provider),
    testStale: false,
  })),
});

const result = (provider: SpeedupProvider, ok: boolean, message = 'The key works.'): SpeedupTestResult => ({
  provider,
  secretName: SECRETS[provider],
  ok,
  code: ok ? 'ok' : 'rejected',
  message,
  at: '2026-01-01T00:00:00.000Z',
});

const summary = (name: string) => ({
  name,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const KEY = 'sk-test-0123456789';

// ── Driving ──────────────────────────────────────────────────────────────────────────────────────

let mounted: Mounted | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
  });
};

const q = (selector: string): Element | null => mounted?.container.querySelector(selector) ?? null;
const text = (selector: string): string => q(selector)?.textContent ?? '';

const clickOn = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const typeInto = async (provider: SpeedupProvider, value: string): Promise<void> => {
  const input = must(q(`#speedup-key-${provider}`) as HTMLInputElement | null, `the ${provider} field`);
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

const save = () => q('[data-onboarding-primary="save-keys"]') as HTMLButtonElement | null;

interface Run {
  readonly calls: Call[];
  readonly saved: number[];
  readonly finished: number[];
}

const start = async (answers: Parameters<typeof scriptedClient>[0]): Promise<Run> => {
  const calls: Call[] = [];
  const saved: number[] = [];
  const finished: number[] = [];
  const client = scriptedClient({ '/v1/fleet/machine': machineView(), ...answers }, calls);
  const tab: MachineTabProps = {
    connection: STUDIO,
    machineName: 'studio-mac',
    machine: machineView(),
    online: true,
    checking: false,
    onRetry: () => undefined,
    createClient: async () => client,
  };
  mounted = await mount(
    <OnboardingSpeedupsStep
      tab={tab}
      onSaved={() => saved.push(calls.length)}
      onFinished={() => finished.push(calls.length)}
    />,
  );
  await settle();
  return { calls, saved, finished };
};

const posted = (calls: readonly Call[], path: string) => calls.filter(call => call.path === path);

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

describe('OnboardingSpeedupsStep', () => {
  it('shows Jev on the page, folds Groq and Cerebras under dictation clean-up, and says keys are never shown again', async () => {
    await start({ [SPEEDUPS_PATH]: view(['jev']) });
    expect(q('[data-onboarding-step-body="speedups"]')).not.toBeNull();
    expect(text('[data-onboarding-step-body="speedups"]')).toContain(
      'Keys make Ferretry faster and cheaper. Nothing breaks without them.',
    );
    expect(text('[data-onboarding-step-body="speedups"]')).toContain(
      'studio-mac’s secret store and is never shown again',
    );
    const jev = must(q('[data-speedup-field="jev"]'), 'the Jev field');
    expect(jev.closest('details')).toBeNull();
    expect(jev.querySelector('[data-speedup-set]')?.textContent).toContain('set');
    const folded = must(q('[data-speedups-dictation]'), 'the dictation details');
    expect(folded.tagName).toBe('DETAILS');
    expect(folded.hasAttribute('open')).toBe(false);
    expect(folded.querySelector('summary')?.textContent).toBe('Dictation clean-up keys (Groq, Cerebras)');
    expect(folded.querySelector('[data-speedup-field="groq"]')).not.toBeNull();
    expect(folded.querySelector('[data-speedup-field="cerebras"]')).not.toBeNull();
    // A key is a password field that no manager keeps a copy of.
    const field = q('#speedup-key-jev') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
  });

  it('has one primary, Save keys, and it is off until a whole key is typed', async () => {
    await start({ [SPEEDUPS_PATH]: view() });
    expect(mounted?.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
    expect(save()?.textContent).toBe('Save keys');
    expect(save()?.disabled).toBe(true);
    await typeInto('jev', 'short');
    expect(save()?.disabled).toBe(true);
    expect(text('[data-speedup-field="jev"]')).toContain('At least 8 characters');
    await typeInto('jev', KEY);
    expect(save()?.disabled).toBe(false);
  });

  it('saves every typed key through the secret route, tests each, then says saved and then finished', async () => {
    let reads = 0;
    const run = await start({
      [SPEEDUPS_PATH]: () => view(reads++ === 0 ? [] : ['jev', 'groq']),
      [SECRETS_PATH]: (call: Call) => summary((call.body as { name: string }).name),
      [testPath('jev')]: result('jev', true),
      [testPath('groq')]: result('groq', true),
    });
    await typeInto('jev', ` ${KEY} `);
    await typeInto('groq', `${KEY}-groq`);
    await clickOn(save(), 'Save keys');
    expect(posted(run.calls, SECRETS_PATH).map(call => call.body)).toEqual([
      { name: 'JEV_API_KEY', value: KEY },
      { name: 'GROQ_API_KEY', value: `${KEY}-groq` },
    ]);
    expect(posted(run.calls, testPath('jev'))).toHaveLength(1);
    expect(posted(run.calls, testPath('groq'))).toHaveLength(1);
    expect(posted(run.calls, testPath('cerebras'))).toHaveLength(0);
    // “saved” is told once the keys are stored, before the tests; “finished” only after they all pass.
    expect(run.saved).toHaveLength(1);
    expect(run.finished).toHaveLength(1);
    const firstTest = run.calls.findIndex(call => call.path === testPath('jev'));
    expect(run.saved[0]).toBeLessThanOrEqual(firstTest);
    expect(run.finished[0]).toBeGreaterThan(firstTest);
    expect(q('[data-speedups-problem]')).toBeNull();
    // The value never comes back onto the page.
    expect(mounted?.container.innerHTML).not.toContain(KEY);
    expect((q('#speedup-key-jev') as HTMLInputElement).value).toBe('');
  });

  it('stays on the page, with a message, when a test does not pass', async () => {
    const run = await start({
      [SPEEDUPS_PATH]: view(['jev']),
      [SECRETS_PATH]: (call: Call) => summary((call.body as { name: string }).name),
      [testPath('jev')]: result('jev', false, 'Jev did not accept that key.'),
    });
    await typeInto('jev', KEY);
    await clickOn(save(), 'Save keys');
    expect(run.saved).toHaveLength(1);
    expect(run.finished).toHaveLength(0);
    expect(text('[data-speedups-problem]')).toBe(
      'Saved, but the test didn’t pass. Jev: Jev did not accept that key. Paste a corrected key, or skip.',
    );
    expect(save()?.textContent).toBe('Save keys');
    expect(save()?.disabled).toBe(true);
    // A corrected key can be pasted straight away.
    await typeInto('jev', `${KEY}-fixed`);
    expect(save()?.disabled).toBe(false);
  });

  it('names a test that could not run at all, and still does not move on', async () => {
    const run = await start({
      [SPEEDUPS_PATH]: view(),
      [SECRETS_PATH]: (call: Call) => summary((call.body as { name: string }).name),
      [testPath('jev')]: new FyHttpError('The machine went quiet.', 504, 'timeout'),
    });
    await typeInto('jev', KEY);
    await clickOn(save(), 'Save keys');
    expect(run.finished).toHaveLength(0);
    expect(text('[data-speedups-problem]')).toContain('Saved, but the test didn’t pass. Jev:');
  });

  it('says why when the key cannot be saved, tells nobody it was saved, and runs no test', async () => {
    const run = await start({
      [SPEEDUPS_PATH]: view(),
      [SECRETS_PATH]: new FyHttpError('The machine refused.', 403, 'forbidden'),
    });
    await typeInto('jev', KEY);
    await clickOn(save(), 'Save keys');
    expect(run.saved).toHaveLength(0);
    expect(run.finished).toHaveLength(0);
    expect(text('[data-speedups-problem]')).not.toBe('');
    expect(run.calls.some(call => call.path.endsWith('/test'))).toBe(false);
  });

  it('says so when the keys cannot be read, and offers nothing to save', async () => {
    await start({ [SPEEDUPS_PATH]: new FyHttpError('The machine is unreachable.', 502, 'unreachable') });
    expect(text('[data-setup-note="speedups-unreadable"]')).toContain('Couldn’t read studio-mac’s keys');
    expect(q('[data-speedup-field]')).toBeNull();
    expect(save()?.disabled).toBe(true);
  });

  it('warns before a key is pasted over a secret store that cannot be read', async () => {
    await start({ [SPEEDUPS_PATH]: view([], 'damaged') });
    expect(text('[data-setup-note="speedups-vault"]')).toContain('The secret store can’t be read');
  });
});
