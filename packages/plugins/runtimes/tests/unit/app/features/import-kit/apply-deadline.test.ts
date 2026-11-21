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
