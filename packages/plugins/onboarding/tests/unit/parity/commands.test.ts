/**
 * Onboarding's verbs: `fy onboard` (what V-0436's `fy setup` runs as its last step) and `fy daemon setup` (V-0241, proved in
 * full by `tests/unit/cli/setup.test.ts`). `fy setup` itself is the shell's own verb now (install, health, pair, then this
 * `onboard`), and is proved in packages/cli/tests/unit/setup.test.ts; what is proved here is what `fy onboard` does, over a
 * fake daemon and a scripted terminal.
 */
import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

interface Call {
  readonly route: string;
  readonly init?: { params?: Record<string, string>; body?: unknown };
}

const client = (answers: Record<string, unknown>, calls: Call[]): PluginClient => ({
  async call<Answer>(route: string, init?: Call['init']): Promise<Answer> {
    calls.push({ route, ...(init === undefined ? {} : { init }) });
    return answers[route] as Answer;
  },
  subscribe: () => () => {},
});

const terminal = () => {
  const out: string[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: () => {}, isTty: false };
  return { io, out };
};

const step = (state: 'pending' | 'found') => ({
  plugin: 'shells',
  id: 'nix',
  title: 'Shells',
  order: 80,
  state,
  ...(state === 'found' ? { at: '2026-11-16T09:00:00.000Z' } : {}),
});

const verbsOver = (answers: Record<string, unknown>, calls: Call[], io: TerminalIo) => {
  const built = cli.build?.({ manifest: cli.manifest, client: client(answers, calls), io });
  if (built === undefined) throw new Error('the cli half has a build');
  return built.verbs;
};

describe('commands parity', () => {
  test('V-0436 V-0241 Onboarding declares the setup verbs the old spellings land on: onboard, its status and reset, and daemon setup', () => {
    expect((manifest.actions.cli ?? []).map(verb => verb.verb).toSorted()).toEqual([
      'daemon setup',
      'onboard',
      'onboard reset',
      'onboard status',
    ]);
    const onboard = (manifest.actions.cli ?? []).find(verb => verb.verb === 'onboard');
    expect(onboard?.options?.map(option => option.flag)).toEqual(['-y, --yes', '--check', '--json']);
  });

  test('V-0436 `fy onboard --check` says what is present and what is missing, and records nothing', async () => {
    const calls: Call[] = [];
    const { io, out } = terminal();
    const verbs = verbsOver(
      {
        'GET /v1/onboarding': { steps: [step('pending')], complete: false, setUp: false },
        'GET /v1/shells/nix': { present: true, version: '2.24.1', path: '/nix/bin/nix' },
      },
      calls,
      io,
    );
    await verbs.onboard({ args: [], options: { check: true } });
    expect(calls.map(call => call.route)).not.toContain('POST /v1/onboarding/steps/:plugin/:stepId');
    expect(out.join('')).not.toBe('');
  });

  test('V-0436 `fy onboard` finds what is present, records each step it found, and says the machine is set up', async () => {
    const calls: Call[] = [];
    const { io, out } = terminal();
    const verbs = verbsOver(
      {
        'GET /v1/onboarding': { steps: [step('pending')], complete: false, setUp: false },
        'GET /v1/shells/nix': { present: true, version: '2.24.1', path: '/nix/bin/nix' },
        'POST /v1/onboarding/steps/:plugin/:stepId': step('found'),
      },
      calls,
      io,
    );
    expect(await verbs.onboard({ args: [], options: {} })).toBe(0);
    expect(calls.at(-1)).toEqual({
      route: 'POST /v1/onboarding/steps/:plugin/:stepId',
      init: { params: { plugin: 'shells', stepId: 'nix' }, body: { state: 'found' } },
    });
    expect(out.join('')).toContain('Ferretry is set up.');
  });
});
