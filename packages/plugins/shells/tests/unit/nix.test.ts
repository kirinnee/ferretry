import { describe, expect, test } from 'bun:test';
import type { SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import { nixTool } from '../../daemon/adapters/nix.ts';
import { flakeFacts } from './support.ts';

const spawnWith = (answer: (args: readonly string[]) => SpawnResult | Error) => {
  const calls: { program: string; args: readonly string[] }[] = [];
  const spawn = {
    run: async (program: string, args: readonly string[]) => {
      calls.push({ program, args });
      const result = answer(args);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as SpawnPort;
  return { tool: nixTool(spawn), calls };
};
const out = (stdout: string, exitCode = 0, stderr = ''): SpawnResult => ({ exitCode, signal: null, stdout, stderr });

describe('nix over the spawn port', () => {
  test('a nix on the machine is reported with its version', async () => {
    const { tool, calls } = spawnWith(() => out('nix (Nix) 2.24.1\n'));
    expect(await tool.facts()).toEqual({ present: true, version: '2.24.1', path: 'nix' });
    expect(calls[0]).toEqual({ program: 'nix', args: ['--version'] });
  });

  test('no nix (the program cannot be run) says what ferrets use instead and how to fix it', async () => {
    const { tool } = spawnWith(() => new Error('ENOENT'));
    const facts = await tool.facts();
    expect(facts.present).toBe(false);
    expect(!facts.present && facts.consequence).toContain('tools already on this machine');
  });

  test('flake metadata asks nix with the features on, and reads the locked facts', async () => {
    const facts = flakeFacts();
    const { tool, calls } = spawnWith(() =>
      out(JSON.stringify({ url: facts.url, locked: { rev: facts.rev, narHash: facts.narHash } })),
    );
    expect(await tool.flakeMetadata('github:me/shells')).toEqual({ ok: true, value: facts });
    expect(calls[0]?.args).toEqual([
      '--extra-experimental-features',
      'nix-command flakes',
      'flake',
      'metadata',
      '--json',
      'github:me/shells',
    ]);
  });

  test('a failing nix answers with the end of its own words, bounded', async () => {
    const { tool } = spawnWith(() => out('', 1, `${'noise\n'.repeat(200)}error: flake not found`));
    const result = await tool.flakeMetadata('github:me/nope');
    expect(!result.ok && result.error).toContain('error: flake not found');
    expect(!result.ok && result.error.length).toBeLessThanOrEqual(600);
  });

  test('a build answers the environment, or the failure', async () => {
    const good = spawnWith(() => out(JSON.stringify({ variables: { PATH: { type: 'exported', value: '/p' } } })));
    expect(await good.tool.devEnv(['print-dev-env'])).toEqual({ ok: true, value: { PATH: '/p' } });
    const bad = spawnWith(() => out('', 1, 'error: build of x failed'));
    expect((await bad.tool.devEnv(['print-dev-env'])).ok).toBe(false);
    const missing = spawnWith(() => new Error('gone'));
    expect((await missing.tool.devEnv([])).ok).toBe(false);
  });
});
