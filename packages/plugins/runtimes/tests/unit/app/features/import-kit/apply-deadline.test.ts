/**
 * C59 O5-10: an import whose apply never answers must not spin for good. The owner's import reached the daemon, wrote a
 * login and a settings file, and its answer never came back; the page waited with no end. `useApplyImport` now stops
 * waiting at its deadline and says what failed, and a machine that wants its unlock says so instead of a raw refusal.
 */
import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import {
  type ApplyImport,
  IMPORT_DEADLINE_MS,
  IMPORT_UNLOCK_SENTENCE,
  useApplyImport,
} from '../../../../../app/features/import-kit/use-apply-import.ts';
import type { RuntimesClient } from '../../../../../app/lib/client.ts';
import type { AccountChange } from '../../../../../contract/index.ts';
import { interact, mount } from '../../../support/dom.ts';

const CHANGE: AccountChange = { kind: 'setup.import', include: ['claude-code'] };

/** A machine view that lets this browser apply, and a proposal route the test scripts. */
const clientWith = (propose: () => Promise<unknown>): RuntimesClient => ({
  call: (async (route: string) => {
    if (route === 'GET /v1/runtimes/machine') throw new Error('not read in this test');
    if (route === 'POST /v1/runtimes/proposals') return await propose();
    throw new Error(`no route ${route}`);
  }) as RuntimesClient['call'],
});

/** A timer the test fires by hand. */
const manualSchedule = () => {
  const timers: { delayMs: number; run: () => void; live: boolean }[] = [];
  return {
    timers,
    schedule: (run: () => void, delayMs: number) => {
      const timer = { delayMs, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    fire: () => {
      for (const timer of timers.splice(0)) if (timer.live) timer.run();
    },
  };
};

const harness = async (client: RuntimesClient, options: Parameters<typeof useApplyImport>[1] = {}) => {
  const held: { current?: ApplyImport } = {};
  const Probe = () => {
    held.current = useApplyImport(client, options);
    return createElement('span', { 'data-refusal': held.current.changes.refusal ?? '' });
  };
  const view = await mount(createElement(Probe));
  const hook = (): ApplyImport => {
    if (held.current === undefined) throw new Error('not mounted');
    return held.current;
  };
  return { view, hook };
};

describe('an import that never answers (C59 O5-10)', () => {
  it('stops waiting at the deadline, answers null, and names what failed instead of spinning', async () => {
    const timer = manualSchedule();
    const { view, hook } = await harness(
      clientWith(() => new Promise(() => undefined)),
      { schedule: timer.schedule },
    );
    let answer: unknown = 'pending';
    await interact(() => {
      void hook()
        .apply(CHANGE, 'Claude Code')
        .then(value => {
          answer = value;
        });
    });
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
    expect(answer).toBe('pending');
    expect(timer.timers.map(entry => entry.delayMs)).toContain(IMPORT_DEADLINE_MS);
    await interact(() => {
      timer.fire();
    });
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
    expect(answer).toBeNull();
    const refusal = view.container.querySelector('[data-refusal]')?.getAttribute('data-refusal') ?? '';
    expect(refusal).toContain('Claude Code import did not answer within 90 s');
    expect(refusal).toContain('Try again');
    await view.unmount();
  });

  it('a machine that wants its unlock says so, and the next press can ask for the passkey again', async () => {
    const locked = Object.assign(new Error('this machine asks you to confirm it is you with a passkey'), {
      status: 401,
      code: 'unlock_required',
    });
    const { view, hook } = await harness(clientWith(() => Promise.reject(locked)));
    let answer: unknown = 'pending';
    await interact(async () => {
      answer = await hook().apply(CHANGE, 'Claude Code');
    });
    expect(answer).toBeNull();
    expect(view.container.querySelector('[data-refusal]')?.getAttribute('data-refusal')).toBe(IMPORT_UNLOCK_SENTENCE);
    await view.unmount();
  });
});

/** What the daemon answers a staged `setup.import`. */
const stagedView = (change: unknown) => ({
  id: 'fy_fprop_abcdefghijklmnopqrstuv',
  revision: 'r1',
  change,
  summary: 'A change',
  consequences: [],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
});

interface Sent {
  readonly route: string;
  readonly signal: AbortSignal | undefined;
}

/** A client whose two POSTs each wait on a hand-held gate, and that records what was sent and with which signal. */
const gated = () => {
  const sent: Sent[] = [];
  const gates: { route: string; settle: (answer: () => unknown) => void }[] = [];
  const client: RuntimesClient = {
    call: (async (route: string, init?: { readonly signal?: AbortSignal; readonly body?: unknown }) => {
      // The panel reads what this browser may change when it mounts; that read is not part of an attempt.
      if (route === 'GET /v1/runtimes/machine') throw new Error('not read in this test');
      sent.push({ route, signal: init?.signal });
      return await new Promise<unknown>((resolve, reject) => {
        gates.push({
          route,
          settle: answer => {
            try {
              const value = answer();
              resolve(
                route === 'POST /v1/runtimes/proposals'
                  ? stagedView((init?.body as { change?: unknown } | undefined)?.change)
                  : value,
              );
            } catch (error) {
              reject(error);
            }
          },
        });
      });
    }) as RuntimesClient['call'],
  };
  return { client, sent, gates };
};

const settle = async (): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

const refusalOf = (view: { container: Element }): string =>
  view.container.querySelector('[data-refusal]')?.getAttribute('data-refusal') ?? '';

const harnessWithBusy = async (client: RuntimesClient, options: Parameters<typeof useApplyImport>[1]) => {
  const held: { current?: ApplyImport } = {};
  const Probe = () => {
    held.current = useApplyImport(client, options);
    return createElement('span', {
      'data-refusal': held.current.changes.refusal ?? '',
      'data-busy': String(held.current.changes.busy),
    });
  };
  const view = await mount(createElement(Probe));
  const hook = (): ApplyImport => {
    if (held.current === undefined) throw new Error('not mounted');
    return held.current;
  };
  const busy = (): string => view.container.querySelector('[data-busy]')?.getAttribute('data-busy') ?? '';
  return { view, hook, busy };
};

describe('an abandoned attempt (C59 O5-10, review round 1)', () => {
  it('at the deadline: busy clears, the in-flight request is aborted, and Retry sends a fresh attempt', async () => {
    const timer = manualSchedule();
    const world = gated();
    const { view, hook, busy } = await harnessWithBusy(world.client, { schedule: timer.schedule });
    await interact(() => {
      void hook().apply(CHANGE, 'Claude Code');
    });
    await settle();
    expect(busy()).toBe('true');
    expect(world.sent.map(entry => entry.route)).toEqual(['POST /v1/runtimes/proposals']);
    expect(world.sent[0]?.signal?.aborted).toBe(false);

    await interact(() => {
      timer.fire();
    });
    await settle();
    expect(busy()).toBe('false');
    expect(world.sent[0]?.signal?.aborted).toBe(true);
    expect(refusalOf(view)).toContain('did not answer within 90 s');

    // Retry: a second attempt goes out with its own, live signal and busy again.
    await interact(() => {
      void hook().apply(CHANGE, 'Claude Code');
    });
    await settle();
    expect(busy()).toBe('true');
    expect(refusalOf(view)).toBe('');
    expect(world.sent).toHaveLength(2);
    expect(world.sent[1]?.signal?.aborted).toBe(false);
    expect(world.sent[1]?.signal).not.toBe(world.sent[0]?.signal);
    await view.unmount();
  });

  it('a stage that answers after the abort never sends its apply POST', async () => {
    const timer = manualSchedule();
    const world = gated();
    const { view, hook } = await harnessWithBusy(world.client, { schedule: timer.schedule });
    await interact(() => {
      void hook().apply(CHANGE, 'Claude Code');
    });
    await settle();
    await interact(() => {
      timer.fire();
    });
    await settle();
    // The late stage answer arrives after the deadline (a carrier that ignored the abort).
    await interact(() => {
      world.gates[0]?.settle(() => undefined);
    });
    await settle();
    expect(world.sent.map(entry => entry.route)).toEqual(['POST /v1/runtimes/proposals']);
    await view.unmount();
  });

  it('a late reply of the old attempt changes neither the refusal nor the new attempt’s busy', async () => {
    const timer = manualSchedule();
    const world = gated();
    const { view, hook, busy } = await harnessWithBusy(world.client, { schedule: timer.schedule });
    await interact(() => {
      void hook().apply(CHANGE, 'Claude Code');
    });
    await settle();
    await interact(() => {
      timer.fire();
    });
    await settle();
    await interact(() => {
      void hook().apply(CHANGE, 'Claude Code');
    });
    await settle();
    expect(busy()).toBe('true');
    // The first attempt's stage now fails late, with a daemon refusal.
    await interact(() => {
      world.gates[0]?.settle(() => {
        throw Object.assign(new Error('the old attempt was refused'), { status: 403, code: 'forbidden' });
      });
    });
    await settle();
    expect(refusalOf(view)).toBe('');
    expect(busy()).toBe('true');
    await view.unmount();
  });
});
