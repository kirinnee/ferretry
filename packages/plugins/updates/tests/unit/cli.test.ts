import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { DaemonUpdateViewSchema, planUpdate } from '../../contract/index.ts';
import cli from '../../cli/index.ts';
import manifest from '../../manifest.ts';
import { runUpdateVerb, viewLines } from '../../cli/lib/verb.ts';

const LATEST = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };
const method = { kind: 'nix-profile', element: 'ferretry' } as const;

const view = (overrides: Record<string, unknown> = {}) =>
  DaemonUpdateViewSchema.parse({
    current: '4.28.0',
    method,
    plan: planUpdate(method, { product: 'ferretry', clientName: 'fy' }),
    check: { state: 'ok', checkedAt: '2026-10-18T09:00:00.000Z', latest: LATEST },
    available: true,
    midTurn: 0,
    autoInstall: false,
    job: null,
    ...overrides,
  });

const report = (outcome: 'succeeded' | 'rolled-back') => ({
  state: 'finished',
  report: {
    from: '4.28.0',
    target: '4.29.0',
    outcome,
    message: outcome === 'succeeded' ? 'Updated to 4.29.0.' : 'Rolled back to 4.28.0.',
    finishedAt: '2026-10-18T10:00:00.000Z',
  },
});

function harness(views: ReturnType<typeof view>[], confirm?: (question: string) => Promise<boolean>) {
  const out: string[] = [];
  const err: string[] = [];
  const started: unknown[] = [];
  let looks = 0;
  return {
    out,
    err,
    started,
    deps: {
      view: async () => views[Math.min(looks++, views.length - 1)] as ReturnType<typeof view>,
      start: async (request: unknown) => {
        started.push(request);
        return view({ job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T09:59:00.000Z' } });
      },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      sleep: async () => undefined,
      ...(confirm === undefined ? {} : { confirm }),
    },
  };
}

const options = { check: false, yes: false, whenIdle: false, to: undefined, json: false };

describe('fy update', () => {
  test('shows how the daemon was installed and that it is behind, and changes nothing with --check', async () => {
    const h = harness([view()]);
    expect(await runUpdateVerb(h.deps, { ...options, check: true })).toBe(0);
    expect(h.out.join('\n')).toContain('behind    4.28.0 → 4.29.0');
    expect(h.out.join('\n')).toContain('nix profile element ferretry');
    expect(h.started).toEqual([]);
  });

  test('without --yes or a prompt it asks for the yes instead of updating', async () => {
    const h = harness([view()]);
    expect(await runUpdateVerb(h.deps, options)).toBe(1);
    expect(h.started).toEqual([]);
    expect(h.err.join('\n')).toContain('--yes');
  });

  test('--yes starts the update the person saw and reports the outcome the daemon leaves', async () => {
    const h = harness([view(), view({ job: report('succeeded') })]);
    expect(await runUpdateVerb(h.deps, { ...options, yes: true })).toBe(0);
    expect(h.started).toEqual([{ target: '4.29.0', when: 'now' }]);
    expect(h.out.at(-1)).toBe('Updated to 4.29.0.');
  });

  test('--when-idle waits for no ferret to be mid-turn, and a rolled-back update fails the command', async () => {
    const h = harness([view(), view({ job: report('rolled-back') })], async () => true);
    expect(await runUpdateVerb(h.deps, { ...options, whenIdle: true })).toBe(1);
    expect(h.started).toEqual([{ target: '4.29.0', when: 'when-idle' }]);
    expect(h.err.at(-1)).toBe('Rolled back to 4.28.0.');
  });

  test('a method the daemon cannot update itself says what to do instead of offering a button', async () => {
    const manual = { kind: 'system-package', manager: 'apt' } as const;
    const h = harness([view({ method: manual, plan: planUpdate(manual, { product: 'ferretry', clientName: 'fy' }) })]);
    expect(await runUpdateVerb(h.deps, { ...options, yes: true })).toBe(0);
    expect(h.started).toEqual([]);
    expect(
      viewLines(view({ method: manual, plan: planUpdate(manual, { product: 'ferretry', clientName: 'fy' }) })).join(
        '\n',
      ),
    ).toContain('sudo apt-get update');
  });
});

describe('the verb on the shell', () => {
  const io = (): TerminalIo & { readonly errors: string[] } => {
    const errors: string[] = [];
    return { out: () => undefined, err: text => void errors.push(text), isTty: false, errors };
  };
  const invocation = (options: VerbInvocation['options']): VerbInvocation => ({ args: [], options });
  const noClient: PluginClient = { call: async () => view() as never, subscribe: () => () => undefined };

  test("--run without the shell's machine ports says so and exits 69", async () => {
    const terminal = io();
    const half = cli.build?.({ manifest, client: noClient, io: terminal });
    expect(await half?.verbs.update(invocation({ run: true }))).toBe(69);
    expect(terminal.errors.join('')).toContain('cannot drive the package managers');
  });

  test('the manifest owns exactly `update`', () => {
    expect(Object.keys(cli.build?.({ manifest, client: noClient, io: io() })?.verbs ?? {})).toEqual(['update']);
  });
});
