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
    expect(view.container.textContent).toContain('Ferrets can use per-project shells with nix');
    const body = must(view.container.querySelector('[data-testid="shells-step"]'), 'the step body').textContent;
    expect(body).toContain('Ferrets use the machine’s own tools.');
    expect(body).toContain('Install nix, then look again.');
  });

  it('Later moves on without recording an answer, and Back goes back', async () => {
    const { harness, view } = await open(async () => ABSENT);
    await interact(() => must(view.container.querySelector<HTMLElement>('[data-step-next]'), 'Later').click());
    await interact(() => must(view.container.querySelector<HTMLElement>('[data-step-back]'), 'Back').click());
    expect(harness.count('next')).toBe(1);
    expect(harness.count('back')).toBe(1);
    expect(harness.count('done')).toBe(0);
    expect(harness.count('remember')).toBe(0);
  });

  it('a failed check still shows the page: it says it could not look, and never blocks', async () => {
    const { harness, view } = await open(async () => {
      throw new Error('offline');
    });
    expect(harness.decision).toBe('shown');
    expect(view.container.textContent).toContain('could not check whether nix is on this machine');
  });

  it('the words come from one pure function', () => {
    expect(shellsStepView(PRESENT)).toEqual({ kind: 'hide' });
    expect(shellsStepView({ kind: 'unreadable' })).toMatchObject({ kind: 'show', consequence: '' });
  });
});
