import { describe, expect, test } from 'bun:test';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

const VIEW = {
  harness: 'claude-code',
  location: { state: 'located', path: '/opt/bin/claude', rule: 'PATH', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '2.1.220' },
  method: { kind: 'homebrew', type: 'cask', package: 'claude-code' },
  plan: { kind: 'self', steps: [{ command: 'brew upgrade --cask claude-code' }], rollback: 'none', pinsVersion: false },
  check: { state: 'never' },
  verified: { version: '2.1.220', url: 'https://example.test/verified' },
  verification: 'verified',
  available: false,
  job: null,
};

function run(verb: string, options: Record<string, string | boolean> = {}, view: unknown = VIEW) {
  const calls: { route: string; init?: unknown }[] = [];
  let out = '';
  let err = '';
  const half = cli.build?.({
    manifest,
    client: {
      call: async (route: string, init?: unknown) => {
        calls.push({ route, init });
        return view;
      },
      subscribe: () => () => {},
    } as never,
    io: { out: (text: string) => (out += text), err: (text: string) => (err += text), isTty: false },
  });
  const handler = (half?.verbs as Record<string, (invocation: unknown) => Promise<number>> | undefined)?.[verb];
  return handler?.({ args: [], options }).then(code => ({ code, out, err, calls }));
}

describe('command parity', () => {
  test('V-0279 the harness verbs are grouped under this harness, one per thing today had', () => {
    const verbs = manifest.actions?.cli?.map(entry => entry.verb) ?? [];
    expect(verbs.slice(0, 2)).toEqual(['harness claude-code status', 'harness claude-code update']);
    expect(verbs.every(verb => verb.startsWith('harness claude-code '))).toBe(true);
  });

  test('V-0280 status reads the view and says where claude is, how it runs and whether it is verified', async () => {
    const result = await run('harness claude-code status');

    expect(result?.code).toBe(0);
    expect(result?.calls.map(call => call.route)).toEqual(['GET /v1/claude-code/update']);
    expect(result?.out).toContain('Claude Code 2.1.220');
    expect(result?.out).toContain('/opt/bin/claude');
    expect(result?.out).toContain('is the version Ferretry verified');
  });

  test('V-0280 status --json prints the protocol payload', async () => {
    const result = await run('harness claude-code status', { json: true });

    expect(JSON.parse(result?.out ?? '')).toMatchObject({ harness: 'claude-code', verification: 'verified' });
  });

  test('V-0281 update without --yes changes nothing and says how to go ahead', async () => {
    const result = await run('harness claude-code update');

    expect(result?.code).toBe(1);
    expect(result?.err).toContain('Re-run with --yes');
    expect(result?.calls.map(call => call.route)).toEqual(['GET /v1/claude-code/update']);
  });

  test('V-0281 update --yes --to verified starts the update at the verified version', async () => {
    const result = await run('harness claude-code update', { yes: true, to: 'verified' });

    expect(result?.code).toBe(0);
    expect(result?.calls.at(-1)).toEqual({
      route: 'POST /v1/claude-code/update',
      init: { body: { target: '2.1.220' } },
    });
  });

  test('V-0281 --allow-unverified is the only thing that confirms going past the verified version; --yes never does', async () => {
    const yes = await run('harness claude-code update', { yes: true });
    const allowed = await run('harness claude-code update', { yes: true, 'allow-unverified': true });

    expect(yes?.calls.at(-1)?.init).toEqual({ body: {} });
    expect(allowed?.calls.at(-1)?.init).toEqual({ body: { confirmUnverified: true } });
  });

  test('V-0281 a version that is not a version is a usage error and nothing is called', async () => {
    const result = await run('harness claude-code update', { yes: true, to: 'latest-ish' });

    expect(result?.code).toBe(2);
    expect(result?.calls).toEqual([]);
  });

  test('V-0281 an install the plan cannot run itself prints the steps and exits 1', async () => {
    const manual = {
      ...VIEW,
      plan: { kind: 'manual', explanation: 'managed by Nix', steps: [{ command: 'nix flake update' }] },
    };

    const result = await run('harness claude-code update', { yes: true }, manual);

    expect(result?.code).toBe(1);
    expect(result?.out).toContain('nix flake update');
    expect(result?.calls.map(call => call.route)).toEqual(['GET /v1/claude-code/update']);
  });
});
