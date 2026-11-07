import { describe, expect, it } from 'bun:test';
import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli, { UNSUPPORTED_OUT, UNSUPPORTED_TRACE } from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';
import { minimalReport } from '../contract/performance-report-fixtures.ts';

interface Call {
  readonly route: string;
}

function run(options: VerbInvocation['options']) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    async call<Answer>(route: string): Promise<Answer> {
      calls.push({ route });
      return { state: 'finished', id: 'profile-1', report: minimalReport() } as Answer;
    },
    subscribe: () => () => {},
  };
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const verbs = cli.build?.({ manifest, client, io }).verbs;
  if (verbs === undefined) throw new Error('the Usage CLI half has no verbs');
  return { verbs, calls, out, err, invoke: () => verbs['daemon profile']({ args: [], options }) };
}

describe('fy daemon profile', () => {
  it('reads --out as a refusal that names the missing file facility, before any window opens', async () => {
    const world = run({ out: 'report.json' });

    const code = await world.invoke();

    expect(code).toBe(2);
    expect(world.err).toEqual([UNSUPPORTED_OUT]);
    expect(UNSUPPORTED_OUT).toContain('no way to write a file');
    expect(world.calls).toEqual([]);
    expect(world.out).toEqual([]);
  });

  it('refuses a bare --out with no file the same way, never starting a profile', async () => {
    const world = run({ out: true });

    expect(await world.invoke()).toBe(2);
    expect(world.calls).toEqual([]);
  });

  it('reads --trace-syscalls as a refusal that names the missing process facility, before any window opens', async () => {
    const world = run({ 'trace-syscalls': true });

    const code = await world.invoke();

    expect(code).toBe(2);
    expect(world.err).toEqual([UNSUPPORTED_TRACE]);
    expect(UNSUPPORTED_TRACE).toContain('no way to start strace or fs_usage');
    expect(world.calls).toEqual([]);
  });

  it('still profiles when tracing is switched off, and prints the daemon report', async () => {
    const world = run({ 'trace-syscalls': false, json: true });

    expect(await world.invoke()).toBe(0);
    expect(world.calls).toEqual([{ route: 'POST /v1/diagnostics/profile' }]);
    expect(JSON.parse(world.out.join('')).version).toBe(1);
  });

  it('refuses a window outside 5 to 300 seconds before asking the daemon', async () => {
    const world = run({ seconds: '4' });

    expect(await world.invoke()).toBe(1);
    expect(world.err[0]).toContain('--seconds must be a whole number from 5 to 300');
    expect(world.calls).toEqual([]);
  });
});
