import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import { ONBOARDING_CODES } from '../../../contract/index.ts';
import cli from '../../../cli/index.ts';
import { onboardClient } from '../../../cli/lib/client.ts';

interface Call {
  readonly route: string;
  readonly init?: { params?: Record<string, string>; body?: unknown };
}

function client(answers: Record<string, unknown>, calls: Call[] = []): PluginClient {
  return {
    async call<Answer>(route: string, init?: Call['init']): Promise<Answer> {
      calls.push({ route, ...(init === undefined ? {} : { init }) });
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer as Answer;
    },
    subscribe: () => () => {},
  };
}

function io(tty = false, ask?: (message: string) => Promise<string>) {
  const out: string[] = [];
  const err: string[] = [];
  const terminal: TerminalIo & { ask?: (message: string) => Promise<string> } = {
    out: text => out.push(text),
    err: text => err.push(text),
    isTty: tty,
    ...(ask === undefined ? {} : { ask }),
  };
  return { terminal, out, err };
}

const view = (state: 'pending' | 'found') => ({
  steps: [
    {
      plugin: 'shells',
      id: 'nix',
      title: 'Shells',
      order: 80,
      state,
      ...(state === 'found' ? { at: '2026-11-06T09:00:00.000Z' } : {}),
    },
  ],
  complete: state === 'found',
  setUp: false,
});

const half = (answers: Record<string, unknown>, terminal: TerminalIo, calls: Call[] = []) => {
  const built = cli.build?.({ manifest: cli.manifest, client: client(answers, calls), io: terminal });
  if (built === undefined) throw new Error('the cli half has a build');
  return built.verbs;
};

describe('onboarding cli half', () => {
  test('declares exactly the three verbs of the manifest', () => {
    const { terminal } = io();
    expect(Object.keys(half({}, terminal)).sort()).toEqual(['onboard', 'onboard reset', 'onboard status']);
  });

  test('onboard runs the checks through the client and records through the daemon route', async () => {
    const calls: Call[] = [];
    const { terminal, out } = io();
    const verbs = half(
      {
        'GET /v1/onboarding': view('pending'),
        'GET /v1/shells/nix': { present: true, version: '2.24.1', path: '/x' },
        'POST /v1/onboarding/steps/:plugin/:stepId': { ...view('found').steps[0] },
      },
      terminal,
      calls,
    );
    expect(await verbs.onboard({ args: [], options: {} })).toBe(0);
    expect(calls.map(each => each.route)).toEqual([
      'GET /v1/onboarding',
      'GET /v1/shells/nix',
      'POST /v1/onboarding/steps/:plugin/:stepId',
    ]);
    expect(calls[2]?.init).toEqual({ params: { plugin: 'shells', stepId: 'nix' }, body: { state: 'found' } });
    expect(out.join('')).toContain('Ferretry is set up.');
  });

  test('--yes and -y both leave a missing step for later', async () => {
    for (const options of [{ yes: true }, { y: true }] as Record<string, boolean>[]) {
      const calls: Call[] = [];
      const { terminal } = io();
      const verbs = half(
        {
          'GET /v1/onboarding': view('pending'),
          'GET /v1/shells/nix': { present: false, consequence: 'c', remedy: 'r' },
          'POST /v1/onboarding/steps/:plugin/:stepId': { ...view('found').steps[0], state: 'later' },
        },
        terminal,
        calls,
      );
      expect(await verbs.onboard({ args: [], options })).toBe(0);
      expect(calls.at(-1)?.init?.body).toEqual({ state: 'later' });
    }
  });

  test('onboard asks only when the terminal is a tty AND can ask', async () => {
    const questions: string[] = [];
    const answers = {
      'GET /v1/onboarding': view('pending'),
      'GET /v1/shells/nix': { present: false, consequence: 'c', remedy: 'r' },
      'POST /v1/onboarding/steps/:plugin/:stepId': { ...view('found').steps[0], state: 'skipped' },
    };
    const asking = io(true, async message => {
      questions.push(message);
      return 's';
    });
    expect(await half(answers, asking.terminal).onboard({ args: [], options: {} })).toBe(0);
    expect(questions).toHaveLength(1);

    const notTty = io(false, async () => {
      throw new Error('must not ask');
    });
    expect(await half(answers, notTty.terminal).onboard({ args: [], options: {} })).toBe(2);
    const noAsk = io(true);
    expect(await half(answers, noAsk.terminal).onboard({ args: [], options: {} })).toBe(2);
  });

  test('onboard status prints the steps; --json prints the view', async () => {
    const { terminal, out } = io();
    const verbs = half({ 'GET /v1/onboarding': view('found') }, terminal);
    expect(await verbs['onboard status']({ args: [], options: {} })).toBe(0);
    expect(out.join('')).toContain('Ferretry is set up.');
    out.length = 0;
    await verbs['onboard status']({ args: [], options: { json: true } });
    expect(JSON.parse(out.join(''))).toMatchObject({ schema: 1, complete: true });
  });

  test('onboard reset calls the reset route and says what is next', async () => {
    const calls: Call[] = [];
    const { terminal, out } = io();
    expect(
      await half({ 'POST /v1/onboarding/reset': undefined }, terminal, calls)['onboard reset']({
        args: [],
        options: {},
      }),
    ).toBe(0);
    expect(calls.map(each => each.route)).toEqual(['POST /v1/onboarding/reset']);
    expect(out.join('')).toBe('The first run starts again. Run `fy onboard` to go through it.\n');
  });

  test('a daemon that answers the view in a shape this fy does not know is a refusal printed on stderr, exit 1', async () => {
    const { terminal, err, out } = io();
    expect(await half({ 'GET /v1/onboarding': { nope: true } }, terminal).onboard({ args: [], options: {} })).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).not.toBe('');
  });
});

describe('onboard client', () => {
  test('an unknown step answers undefined, not an error', async () => {
    const refusal = Object.assign(new Error('There is no first-run step logins:nope.'), {
      code: ONBOARDING_CODES.unknownStep,
    });
    const api = onboardClient(client({ 'POST /v1/onboarding/steps/:plugin/:stepId': refusal }));
    expect(await api.record('logins', 'nope', { state: 'done' })).toBeUndefined();
  });

  test('any other refusal is thrown', async () => {
    const api = onboardClient(client({ 'POST /v1/onboarding/steps/:plugin/:stepId': new Error('503') }));
    await expect(api.record('logins', 'login', { state: 'done' })).rejects.toThrow('503');
  });
});
