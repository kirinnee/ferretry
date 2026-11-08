import { describe, expect, test } from 'bun:test';
import {
  type ResumeLaunchSpec,
  TmuxResumeLauncher,
} from '../../../../../daemon/adapters/session/resume/tmux-resume-launcher.ts';
import { UnregisteredResumeReplacement } from '../../../../../daemon/lib/session/resume/types.ts';
import type { TmuxController, TmuxLaunch } from '../../../../../daemon/lib/session/peers/tmux-lifecycle.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

const ID = parseSessionId('session-a');

/** A tmux controller that only records what it is asked, over a pane whose state a test sets. */
function tmuxWorld(state = { alive: true, dead: false, promptReady: true, visible: 'the screen' }) {
  const launched: TmuxLaunch[] = [];
  const stopped: string[] = [];
  const world = {
    state,
    launched,
    stopped,
    stopFails: undefined as Error | undefined,
    tmux: {
      state: async () => world.state,
      launch: async (launch: TmuxLaunch) => void launched.push(launch),
      stop: async (session: string) => {
        stopped.push(session);
        if (world.stopFails !== undefined) throw world.stopFails;
      },
    } as unknown as TmuxController,
  };
  return world;
}

const baseSpec: ResumeLaunchSpec = {
  tmuxSession: 'fy-a',
  cwd: '/work/a',
  command: ['claude', '--resume'],
  mode: 'auto',
};

function launcher(world: ReturnType<typeof tmuxWorld>, over: Partial<ResumeLaunchSpec> = {}) {
  const delivered: [string, string][] = [];
  const subject = new TmuxResumeLauncher(world.tmux, async () => ({ ...baseSpec, ...over }), {
    deliver: async (session: string, text: string) => void delivered.push([session, text]),
  } as never);
  return { subject, delivered };
}

describe('the tmux resume launcher: reads that address the pane', () => {
  test("observe reports the pane as alive, dead and prompt-ready from the spec's session", async () => {
    const world = tmuxWorld({ alive: true, dead: false, promptReady: false, visible: '' });
    expect(await launcher(world).subject.observe(ID)).toEqual({ alive: true, dead: false, promptReady: false });
  });

  test('snapshot writes the visible screen only of a live pane, and nothing without a writer', async () => {
    const written: [string, string][] = [];
    const world = tmuxWorld();
    const withWriter = new TmuxResumeLauncher(world.tmux, async () => baseSpec, {} as never, {
      write: async (id: string, text: string) => void written.push([id, text]),
    });
    await withWriter.snapshot(ID);
    expect(written).toEqual([[ID, 'the screen']]);
    world.state = { alive: false, dead: true, promptReady: false, visible: 'stale' };
    await withWriter.snapshot(ID);
    world.state = { alive: true, dead: true, promptReady: false, visible: 'stale' };
    await withWriter.snapshot(ID);
    expect(written).toHaveLength(1);
    await launcher(tmuxWorld()).subject.snapshot(ID);
  });

  test("kill stops the spec's tmux session, and deliver hands the text to the delivery adapter for it", async () => {
    const world = tmuxWorld();
    const { subject, delivered } = launcher(world);
    await subject.kill(ID, 'because');
    expect(world.stopped).toEqual(['fy-a']);
    await subject.deliver(ID, 'go on');
    expect(delivered).toEqual([['fy-a', 'go on']]);
  });

  test('confirmExit agrees only when the pane is gone or dead, and an unreadable pane counts as gone', async () => {
    const world = tmuxWorld();
    const { subject } = launcher(world);
    expect((await subject.confirmExit(ID)).confirmed).toBe(false);
    world.state = { alive: true, dead: true, promptReady: false, visible: '' };
    expect((await subject.confirmExit(ID)).confirmed).toBe(true);
    world.state = { alive: false, dead: false, promptReady: false, visible: '' };
    expect((await subject.confirmExit(ID)).confirmed).toBe(true);
    world.tmux.state = async () => await Promise.reject(new Error('no tmux'));
    expect(await subject.confirmExit(ID)).toEqual({
      confirmed: true,
      pane: { alive: false, dead: true, promptReady: false },
    });
  });
});

describe('the tmux resume launcher: relaunch', () => {
  test("replays the recorded command with the session's own identity in the pane environment", async () => {
    const world = tmuxWorld();
    const { subject } = launcher(world, { env: { KEEP: 'yes' }, mode: 'interactive' });
    expect(await subject.relaunch(ID)).toBeUndefined();
    expect(world.launched).toHaveLength(1);
    expect(world.launched[0]).toMatchObject({ session: 'fy-a', cwd: '/work/a', command: ['claude', '--resume'] });
    expect(world.launched[0]?.env).toMatchObject({ KEEP: 'yes' });
    expect(Object.values(world.launched[0]?.env ?? {})).toContain(ID);
  });

  test('builds the command at launch when the spec offers a builder, wraps it with limits, and names the wrapper in the renewal', async () => {
    const world = tmuxWorld();
    const calls: string[] = [];
    const subject = new TmuxResumeLauncher(
      world.tmux,
      async () => ({
        ...baseSpec,
        agent: '/bin/claude-wrapper',
        relaunch: async () => ['claude', '--fresh'],
      }),
      {} as never,
      undefined,
      { command: async (_id, command) => ['limit-wrap', ...command] },
      undefined,
      undefined,
      { forWrapper: async (wrapper, cwd) => (calls.push(`env ${wrapper} ${cwd}`), { ACCOUNT: 'a', HOME: '/ignored' }) },
      { beforeLaunch: async wrapper => void calls.push(`renew ${wrapper}`) },
      async () => ({ media: '/media', questionAsked: '/question' }),
      undefined,
      { rotate: async id => (calls.push(`rotate ${id}`), 'secret') },
    );
    await subject.relaunch(ID);
    expect(calls).toEqual(['rotate session-a', 'env /bin/claude-wrapper /work/a', 'renew /bin/claude-wrapper']);
    expect(world.launched[0]?.command).toEqual(['limit-wrap', 'claude', '--fresh']);
    expect(world.launched[0]?.env?.ACCOUNT).toBe('a');
    expect(world.launched[0]?.env?.HOME).toBeUndefined();
    expect(Object.values(world.launched[0]?.env ?? {})).toEqual(expect.arrayContaining(['/media', '/question']));
  });

  test('answers the launch instructions only when both the client name and the describer are bound', async () => {
    const instructions = { text: 'how to use fy' } as never;
    const seen: string[] = [];
    const make = (clientName?: string, describe?: never) =>
      new TmuxResumeLauncher(
        tmuxWorld().tmux,
        async () => baseSpec,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        clientName,
        undefined,
        describe,
      );
    const describe = ((client: string) => (seen.push(client), instructions)) as never;
    expect(await make('fy', describe).relaunch(ID)).toBe(instructions);
    expect(seen).toEqual(['fy']);
    expect(await make(undefined, describe).relaunch(ID)).toBeUndefined();
    expect(await make('fy', undefined).relaunch(ID)).toBeUndefined();
  });

  test('an empty command cannot be relaunched, and nothing is launched', async () => {
    const world = tmuxWorld();
    const { subject } = launcher(world, { command: [] });
    await expect(subject.relaunch(ID)).rejects.toThrow('has an empty command and cannot be relaunched');
    expect(world.launched).toEqual([]);
  });
});

describe('the tmux resume launcher: registering the replacement', () => {
  const retry = (slept: number[]) => ({ attempts: 3, delayMs: 7, sleep: async (ms: number) => void slept.push(ms) });
  const make = (
    world: ReturnType<typeof tmuxWorld>,
    registerSession: (id: never, session: string) => Promise<void>,
    slept: number[],
  ) =>
    new TmuxResumeLauncher(
      world.tmux,
      async () => baseSpec,
      {} as never,
      undefined,
      undefined,
      { registerSession },
      retry(slept),
    );

  test('a registration that lands on the second attempt keeps the replacement, after one pause', async () => {
    const world = tmuxWorld();
    const slept: number[] = [];
    let attempts = 0;
    await make(
      world,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('pane not published');
      },
      slept,
    ).relaunch(ID);
    expect(attempts).toBe(2);
    expect(slept).toEqual([7]);
    expect(world.stopped).toEqual([]);
  });

  test('a registration that never lands kills the replacement and raises, naming the last failure', async () => {
    const world = tmuxWorld();
    const slept: number[] = [];
    const failure = await make(world, async () => await Promise.reject(new Error('no pid yet')), slept)
      .relaunch(ID)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnregisteredResumeReplacement);
    expect((failure as Error).message).toContain('no pid yet');
    expect((failure as Error).message).toContain('the unregistered replacement pane was killed');
    expect(slept).toEqual([7, 7]);
    expect(world.stopped).toEqual(['fy-a']);
  });

  test('when the replacement cannot be killed either, the failure says so', async () => {
    const world = tmuxWorld();
    world.stopFails = new Error('tmux gone');
    const failure = await make(world, async () => await Promise.reject('plain text failure'), [])
      .relaunch(ID)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnregisteredResumeReplacement);
    expect((failure as Error).message).toContain('plain text failure');
    expect((failure as Error).message).toContain('could not be killed either (tmux gone)');
  });

  test('the default retry pauses on a real timer between attempts', async () => {
    const world = tmuxWorld();
    let attempts = 0;
    const subject = new TmuxResumeLauncher(world.tmux, async () => baseSpec, {} as never, undefined, undefined, {
      registerSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('race');
      },
    });
    await subject.relaunch(ID);
    expect(attempts).toBe(2);
  });
});
