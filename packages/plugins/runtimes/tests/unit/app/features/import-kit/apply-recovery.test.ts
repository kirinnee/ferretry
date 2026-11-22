/**
 * E3 item 4: an import whose apply never answers used to drop the staged change's id, so the page could only say
 * "it may still finish". It now keeps the id, asks the machine ONCE what became of the change, and shows what landed and
 * what did not in the daemon's words. These cases run the real hook, the real change path and a fake daemon end to end.
 */
import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import {
  type ApplyImport,
  type ImportApplied,
  useApplyImport,
} from '../../../../../app/features/import-kit/use-apply-import.ts';
import type { RuntimesClient } from '../../../../../app/lib/client.ts';
import type { AccountChange } from '../../../../../contract/index.ts';
import { interact, mount } from '../../../support/dom.ts';

const CHANGE: AccountChange = { kind: 'setup.import', include: ['claude-code'] };
const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

const stagedView = (change: unknown) => ({
  id: CHANGE_ID,
  revision: 'r1',
  change,
  summary: 'A change',
  consequences: [],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
});

/** What the daemon answers a read of a spent change, as its route puts it on the wire (the whole body rides along). */
const refusalBody = (body: Record<string, unknown>, message: string): Error =>
  Object.assign(new Error(message), {
    status: 409,
    code: 'fleet_change_consumed',
    body: { error: message, code: 'fleet_change_consumed', ...body },
  });

interface FakeDaemon {
  readonly client: RuntimesClient;
  readonly sent: { readonly route: string; readonly proposalId: string | undefined }[];
}

/** A daemon whose apply never answers; stage works; a read of the change answers `reading` (called each time). */
const daemon = (options: { readonly stage?: boolean; readonly reading: () => unknown }): FakeDaemon => {
  const sent: FakeDaemon['sent'] = [];
  const client: RuntimesClient = {
    call: (async (route: string, init?: { readonly params?: Record<string, string>; readonly body?: unknown }) => {
      if (route === 'GET /v1/runtimes/machine') throw new Error('not read in this test');
      sent.push({ route, proposalId: init?.params?.proposalId });
      if (route === 'POST /v1/runtimes/proposals') {
        if (options.stage === false) return await new Promise(() => undefined);
        return stagedView((init?.body as { change?: unknown } | undefined)?.change);
      }
      if (route === 'POST /v1/runtimes/proposals/:proposalId/apply') return await new Promise(() => undefined);
      if (route === 'GET /v1/runtimes/proposals/:proposalId') {
        const answer = options.reading();
        if (answer instanceof Error) throw answer;
        return answer;
      }
      throw new Error(`no route ${route}`);
    }) as RuntimesClient['call'],
  };
  return { client, sent };
};

/** A timer the test fires by hand: only the import deadline is held, anything shorter runs at once. */
const manualSchedule = () => {
  const timers: { delayMs: number; run: () => void; live: boolean }[] = [];
  return {
    schedule: (run: () => void, delayMs: number) => {
      const timer = { delayMs, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    fire: (delayMs: number) => {
      for (const timer of timers) if (timer.live && timer.delayMs === delayMs) timer.run();
    },
  };
};

const run = async (world: FakeDaemon) => {
  const clock = manualSchedule();
  const held: { current?: ApplyImport } = {};
  const Probe = () => {
    held.current = useApplyImport(world.client, { schedule: clock.schedule, deadlineMs: 1_000 });
    return createElement('span', { 'data-refusal': held.current.changes.refusal ?? '' });
  };
  const view = await mount(createElement(Probe));
  const hook = (): ApplyImport => {
    if (held.current === undefined) throw new Error('not mounted');
    return held.current;
  };
  let answer: ImportApplied | null | 'pending' = 'pending';
  await interact(() => {
    void hook()
      .apply(CHANGE, 'Claude Code')
      .then(value => {
        answer = value;
      });
  });
  await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  await interact(() => {
    clock.fire(1_000);
  });
  await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
  const refusal = (): string => view.container.querySelector('[data-refusal]')?.getAttribute('data-refusal') ?? '';
  return { view, hook, answer: () => answer, refusal };
};

const reads = (world: FakeDaemon): FakeDaemon['sent'] =>
  world.sent.filter(entry => entry.route === 'GET /v1/runtimes/proposals/:proposalId');

describe('an import that timed out after its change was staged', () => {
  it('keeps the change id, reads it back ONCE, and shows what landed and what did not', async () => {
    const world = daemon({
      reading: () =>
        refusalBody(
          {
            landed: ['secret-store key ANTHROPIC_API_KEY', 'login claude-default'],
            notLanded: ['the runtimes and fleet files'],
          },
          'was only partly applied',
        ),
    });
    const { view, hook, answer, refusal } = await run(world);

    expect(answer()).toBeNull();
    expect(reads(world)).toEqual([{ route: 'GET /v1/runtimes/proposals/:proposalId', proposalId: CHANGE_ID }]);
    expect(hook().partial).toEqual({
      label: 'Claude Code',
      landed: ['secret-store key ANTHROPIC_API_KEY', 'login claude-default'],
      notLanded: ['the runtimes and fleet files'],
    });
    expect(refusal()).toContain('did not answer within 1 s');
    expect(refusal()).toContain('Part of it did land on this machine');
    expect(refusal()).toContain('Try again');
    await view.unmount();
  });

  it('says the machine is still finishing it when the change is being applied right now', async () => {
    const world = daemon({ reading: () => refusalBody({ applying: true }, 'is being applied right now') });
    const { view, hook, answer, refusal } = await run(world);

    expect(answer()).toBeNull();
    expect(hook().partial).toBeNull();
    expect(refusal()).toContain('still finishing it');
    expect(reads(world)).toHaveLength(1);
    await view.unmount();
  });

  it('counts an import the machine finished while the page was not looking as done', async () => {
    const world = daemon({ reading: () => refusalBody({}, 'has already been applied') });
    const { view, hook, answer, refusal } = await run(world);

    expect(answer()).toEqual({ kind: 'imported', sentences: ['The import finished on this machine.'] });
    expect(hook().applied?.kind).toBe('imported');
    expect(refusal()).toBe('');
    await view.unmount();
  });

  it('says nothing was written when the change was never spent', async () => {
    const world = daemon({ reading: () => stagedView({}) });
    const { view, hook, answer, refusal } = await run(world);

    expect(answer()).toBeNull();
    expect(hook().partial).toBeNull();
    expect(refusal()).toContain('Nothing was written on this machine');
    await view.unmount();
  });

  it('falls back to the plain timeout words when the read cannot be answered, and still reads only once', async () => {
    const world = daemon({ reading: () => new Error('the machine is not answering') });
    const { view, answer, refusal } = await run(world);

    expect(answer()).toBeNull();
    expect(refusal()).toContain('It may still finish on this machine');
    expect(reads(world)).toHaveLength(1);
    await view.unmount();
  });

  it('reads nothing when the stage itself never answered: nothing can have landed', async () => {
    const world = daemon({ stage: false, reading: () => new Error('must not be asked') });
    const { view, answer, refusal } = await run(world);

    expect(answer()).toBeNull();
    expect(reads(world)).toHaveLength(0);
    expect(refusal()).toContain('did not answer within 1 s');
    await view.unmount();
  });
});

describe('a refusal that names what landed', () => {
  it('shows both lists for a change that failed part-way, with no timeout involved', async () => {
    const failing: RuntimesClient = {
      call: (async (route: string, init?: { readonly body?: unknown }) => {
        if (route === 'GET /v1/runtimes/machine') throw new Error('not read in this test');
        if (route === 'POST /v1/runtimes/proposals')
          return stagedView((init?.body as { change?: unknown } | undefined)?.change);
        throw Object.assign(new Error('the disk is full. Part of this change was applied.'), {
          status: 409,
          code: 'fleet_change_failed',
          body: { landed: ['learning.yaml'], notLanded: ['voice.yaml'] },
        });
      }) as RuntimesClient['call'],
    };
    const held: { current?: ApplyImport } = {};
    const Probe = () => {
      held.current = useApplyImport(failing);
      return createElement('span');
    };
    const view = await mount(createElement(Probe));
    await interact(async () => {
      await held.current?.apply(CHANGE, 'Claude Code');
    });

    expect(held.current?.partial).toEqual({
      label: 'Claude Code',
      landed: ['learning.yaml'],
      notLanded: ['voice.yaml'],
    });
    await view.unmount();
  });
});
