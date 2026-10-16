import { afterEach, describe, expect, it } from 'bun:test';
import type { ForkSessionOutcome, SessionView } from '@ferretry/protocol';
import { ForkForm } from '../../../../src/features/session-actions/fork-form.tsx';
import type { SessionActionFormHost } from '../../../../src/features/session-actions/registry.ts';
import { interact, mount, must, type Mounted } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const OUTCOME: ForkSessionOutcome = {
  session: { id: 'fork-1', name: 'Fork of Hadi', agent: 'claude', harness: 'claude', model: null, status: 'running' },
  plan: {
    v: 1,
    planId: 'plan-1',
    preparedAt: '2026-10-16T10:00:00.000Z',
    source: { sessionId: 'a1', cutMessagePoint: { v: 1, byteOffset: 1 } },
    target: { agent: 'claude', harness: 'claude', model: null, effort: null, contextWindow: 200_000 },
    notCarried: [],
  },
};

const VIEW: SessionView = sessionView('a1', { config: { agent: 'nero', name: 'Fix the gate', teammate: 'hadi' } });

const type = async (field: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

interface Harness {
  readonly root: HTMLElement;
  readonly nameInput: HTMLInputElement;
  readonly submit: HTMLButtonElement;
  readonly closes: number[];
  readonly forked: ForkSessionOutcome[];
}

const open = async (
  fork: (teammate: string | undefined) => Promise<ForkSessionOutcome>,
  view: SessionView = VIEW,
): Promise<Harness> => {
  const closes: number[] = [];
  const forked: ForkSessionOutcome[] = [];
  const host: SessionActionFormHost = { close: () => closes.push(1), open: () => undefined, compact: false };
  mounted = await mount(<ForkForm fork={fork} host={host} onForked={outcome => forked.push(outcome)} view={view} />);
  const root = mounted.container;
  return {
    root,
    nameInput: must(root.querySelector('input'), 'name input') as HTMLInputElement,
    submit: must(root.querySelector('[data-action-submit]'), 'submit button') as HTMLButtonElement,
    closes,
    forked,
  };
};

const submitForm = async (root: HTMLElement): Promise<void> => {
  const form = must(root.querySelector('form'), 'the form');
  await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};

describe('ForkForm', () => {
  it('names the source by its callsign, and says what the fork carries', async () => {
    const h = await open(async () => OUTCOME);
    expect(h.root.textContent).toContain('Hadi’s conversation');
    expect(h.root.textContent).toContain('nero');
  });

  it('falls back to the session name when the source has no teammate callsign', async () => {
    const h = await open(async () => OUTCOME, sessionView('a1', { config: { agent: 'nero', teammate: undefined } }));
    expect(h.root.textContent).toContain(`${sessionView('a1').config.name}’s conversation`);
  });

  it('starts with an empty name, and leaving it empty asks the daemon to pick one', async () => {
    const calls: (string | undefined)[] = [];
    const h = await open(async teammate => {
      calls.push(teammate);
      return OUTCOME;
    });
    expect(h.nameInput.value).toBe('');
    await submitForm(h.root);
    expect(calls).toEqual([undefined]);
  });

  it('lower-cases what is typed, trims it, and sends it as the fork’s name', async () => {
    const calls: (string | undefined)[] = [];
    const h = await open(async teammate => {
      calls.push(teammate);
      return OUTCOME;
    });
    await type(h.nameInput, 'Nero-2');
    expect(h.nameInput.value).toBe('nero-2');
    await submitForm(h.root);
    expect(calls).toEqual(['nero-2']);
  });

  it('closes the form and reports the outcome to the caller on success', async () => {
    const h = await open(async () => OUTCOME);
    await submitForm(h.root);
    expect(h.closes).toEqual([1]);
    expect(h.forked).toEqual([OUTCOME]);
  });

  it('shows the daemon’s refusal, and never closes, on failure', async () => {
    const h = await open(async () => {
      throw new Error('there is no message to fork from yet');
    });
    await submitForm(h.root);
    expect(h.root.textContent).toContain('there is no message to fork from yet');
    expect(h.closes).toEqual([]);
    expect(h.forked).toEqual([]);
  });

  it('cancels through the host without forking', async () => {
    const calls: unknown[] = [];
    const h = await open(async () => {
      calls.push('called');
      return OUTCOME;
    });
    const cancel = must(
      [...h.root.querySelectorAll('button')].find(button => button.textContent === 'Cancel'),
      'Cancel button',
    );
    await interact(() => cancel.click());
    expect(h.closes).toEqual([1]);
    expect(calls).toEqual([]);
  });

  it('ignores a resubmit while the first fork is still in flight', async () => {
    let resolve: ((outcome: ForkSessionOutcome) => void) | undefined;
    const calls: unknown[] = [];
    const h = await open(
      () =>
        new Promise<ForkSessionOutcome>(res => {
          resolve = res;
          calls.push('called');
        }),
    );
    const form = must(h.root.querySelector('form'), 'the form');
    await interact(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls).toEqual(['called']);
    resolve?.(OUTCOME);
    await interact(() => undefined);
  });
});
