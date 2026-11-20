import { ensureDom, interact, mount, must } from '@ferretry/app/testing';
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';
import { describe, expect, it } from 'bun:test';
import { ShellsStep } from '../../../app/features/onboarding/shells-step.tsx';
import { type NixCheck, shellsStepView } from '../../../app/features/onboarding/shells-step-model.ts';

ensureDom();

/**
 * A recording `StepHost`: the real contract (`@ferretry/kernel/contract`) with every call kept in order. Onboarding's own
 * `StepHarness` is the same shape; Shells does not depend on another plugin's test helper, so it keeps this small copy.
 */
type Call = 'ready' | 'skip' | 'done' | 'busy' | 'remember' | 'next' | 'back';
function stepHarness() {
  const calls: { kind: Call; why?: string }[] = [];
  const segment: StepSegmentMemory = {};
  const host: StepHost = {
    phase: 'daemon',
    appliesTo: [],
    segment,
    remember: () => void calls.push({ kind: 'remember' }),
    ready: () => void calls.push({ kind: 'ready' }),
    skip: why => void calls.push({ kind: 'skip', why }),
    done: () => void calls.push({ kind: 'done' }),
    busy: () => void calls.push({ kind: 'busy' }),
    next: () => void calls.push({ kind: 'next' }),
    back: () => void calls.push({ kind: 'back' }),
  };
  const skipped = () => calls.find(call => call.kind === 'skip');
  return {
    host,
    count: (kind: Call) => calls.filter(call => call.kind === kind).length,
    get decision() {
      if (skipped() !== undefined) return 'skipped';
      return calls.some(call => call.kind === 'ready') ? 'shown' : 'undecided';
    },
    get skippedWhy() {
      return skipped()?.why;
    },
  };
}

const PRESENT: NixCheck = { kind: 'facts', facts: { present: true, version: '2.24.1', path: 'nix' } };
const ABSENT: NixCheck = {
  kind: 'facts',
  facts: {
    present: false,
    consequence: 'Ferrets use the machine’s own tools.',
    remedy: 'Install nix, then look again.',
  },
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

async function open(check: () => Promise<NixCheck>) {
  const harness = stepHarness();
  const view = await mount(<ShellsStep step={harness.host} check={check} />);
  await settle();
  return { harness, view };
}

describe('the Shells step', () => {
  it('stays under the loading cover until nix has been checked', async () => {
    const harness = stepHarness();
    await mount(<ShellsStep step={harness.host} check={() => new Promise(() => {})} />);
    await settle();
    expect(harness.decision).toBe('undecided');
  });

  it('skips as not-needed, and draws nothing, when nix is on the machine', async () => {
    const { harness, view } = await open(async () => PRESENT);
    expect(harness.decision).toBe('skipped');
    expect(harness.skippedWhy).toBe('not-needed');
    expect(view.container.textContent).toBe('');
  });

  it('shows what ferrets use without nix, with the daemon’s own words, and is ready', async () => {
    const { harness, view } = await open(async () => ABSENT);
    expect(harness.decision).toBe('shown');
    expect(view.container.textContent).toContain('Nix is not on this machine');
    const body = must(view.container.querySelector('[data-testid="shells-step"]'), 'the step body').textContent;
    expect(body).toContain('Ferrets use the machine’s own tools.');
    expect(body).toContain('Install nix, then look again.');
  });

  it('draws only its body: no frame, title, progress, Back, Next or Later, and never moves the flow', async () => {
    const { harness, view } = await open(async () => ABSENT);
    expect(view.container.querySelector('[data-step-page]')).toBeNull();
    expect(view.container.querySelector('h1')).toBeNull();
    expect(view.container.querySelector('[data-step-next]')).toBeNull();
    expect(view.container.querySelector('[data-step-back]')).toBeNull();
    expect(view.container.querySelector('[data-step-later]')).toBeNull();
    expect(view.container.textContent).not.toContain('Later');
    expect(harness.count('next')).toBe(0);
    expect(harness.count('back')).toBe(0);
    expect(harness.count('done')).toBe(0);
    expect(harness.count('remember')).toBe(0);
  });

  it('a failed check shows "Couldn’t check", does not claim ferrets use host tools, and never blocks', async () => {
    const { harness, view } = await open(async () => {
      throw new Error('offline');
    });
    expect(harness.decision).toBe('shown');
    const body = must(view.container.querySelector('[data-testid="shells-step"]'), 'the step body');
    expect(body.getAttribute('data-outcome')).toBe('unreadable');
    expect(body.textContent).toContain('Couldn’t check');
    expect(body.textContent).not.toContain('machine’s own tools');
    expect(harness.count('next')).toBe(0);
  });

  it('"Check again" looks again: nix found now skips the step as not-needed', async () => {
    let asked = 0;
    const { harness, view } = await open(async () => {
      asked += 1;
      if (asked === 1) throw new Error('offline');
      return PRESENT;
    });
    expect(harness.decision).toBe('shown');
    await interact(() => must(view.container.querySelector<HTMLElement>('[data-shells-step-retry]'), 'retry').click());
    await settle();
    expect(asked).toBe(2);
    expect(harness.skippedWhy).toBe('not-needed');
    expect(view.container.textContent).toBe('');
  });

  it('"Check again" that fails again stays on the page, still never claiming anything', async () => {
    let asked = 0;
    const { view } = await open(async () => {
      asked += 1;
      throw new Error('offline');
    });
    await interact(() => must(view.container.querySelector<HTMLElement>('[data-shells-step-retry]'), 'retry').click());
    await settle();
    expect(asked).toBe(2);
    expect(view.container.textContent).toContain('Couldn’t check');
  });

  it('the words come from one pure function', () => {
    expect(shellsStepView(PRESENT)).toEqual({ kind: 'hide' });
    expect(shellsStepView({ kind: 'unreadable' })).toMatchObject({
      kind: 'show',
      outcome: 'unreadable',
      consequence: '',
    });
  });
});
