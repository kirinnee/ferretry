/**
 * B192: every launcher the generator can produce must PARSE in the shells that may run it.
 *
 * Bash scans single quotes inside `${NAME:?word}` even within double quotes, so a guard whose word
 * held an apostrophe ("Ferretry's secret store") made bash reject the whole script
 * (`unexpected EOF while looking for matching '`) while dash accepted it. A guard word that carries a
 * secretsFile path has the same exposure for `'`, `}`, `$`, a backtick, `"` and `\`.
 *
 * These cases write each kind of launcher to a temporary file and ask `bash -n`, `bash --posix -n`
 * and `sh -n` to parse it; then run a guard-only script to prove the guard still refuses and still
 * passes. Fixtures only: no real home, no network, no credential.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { HarnessKind } from '../../daemon/lib/manifest.ts';
import {
  type RuntimeWrapperInput,
  renderCommandScript,
  renderRuntimeWrapperScript,
} from '../../daemon/lib/wrappers.ts';

const directory = mkdtempSync(join(tmpdir(), 'fy-guard-parse-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const ID = '00000000-0000-4000-8000-000000000001';

const SECRET_FILES: readonly (string | undefined)[] = [
  undefined,
  '~/.config/fy/provider-env',
  "/tmp/it's here/secrets",
  '/tmp/brace}/secrets',
  '/tmp/$dollar/secrets',
  '/tmp/with space/secrets',
  '/tmp/dq"/secrets',
  '/tmp/back`tick/secrets',
  '/tmp/back\\slash/secrets',
  `/tmp/it's a "}$\`\\ mix/secrets`,
];

const ENVS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['no env', {}],
  ['one env reference', { ANTHROPIC_AUTH_TOKEN: '$TOKEN_VAR' }],
  ['one store secret', { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' }],
  ['two store secrets', { AUTH_HEADER: '${secret:SCHEME} ${secret:WORK_KEY}' }],
  ['reference and secret', { ANTHROPIC_API_KEY: '${secret:WORK_KEY}', OTHER: '$TOKEN_VAR' }],
];

const runtime = (
  harness: HarnessKind,
  agent: boolean,
  env: Readonly<Record<string, string>>,
  secretsFile: string | undefined,
): RuntimeWrapperInput => ({
  name: `${harness}-${agent ? 'auto' : 'plain'}`,
  id: ID,
  harness,
  agent,
  configDirectory: '$HOME/.state/fleet/homes/x',
  env,
  args: [],
  seedFirstRun: harness === 'claude' && agent,
  trustLaunchFolder: harness === 'codex' && agent,
  fyCommand: 'fy',
  defaultModel: 'a-model',
  secretsFile,
});

const launchers = (): readonly (readonly [string, string])[] => {
  const out: [string, string][] = [];
  for (const harness of ['claude', 'codex'] as const)
    for (const agent of [true, false])
      for (const [envLabel, env] of ENVS)
        for (const file of SECRET_FILES)
          out.push([
            `${harness} ${agent ? 'agent' : 'plain'} / ${envLabel} / secretsFile ${JSON.stringify(file)}`,
            renderRuntimeWrapperScript(runtime(harness, agent, env, file)),
          ]);
  out.push([
    'refused runtime',
    renderRuntimeWrapperScript({ ...runtime('claude', true, {}, undefined), refusal: "it's refused" }),
  ]);
  out.push([
    'command',
    renderCommandScript({
      command: { wrapper: 'w', target: ID, flags: ["--x=it's"], alias: undefined },
      targetWrapper: 'claude-auto',
      binDir: "/tmp/it's/bin",
    }),
  ]);
  return out;
};

const parse = (shell: readonly string[], file: string): { status: number | null; stderr: string } => {
  const run = Bun.spawnSync([...shell, file], { stdout: 'pipe', stderr: 'pipe' });
  return { status: run.exitCode, stderr: run.stderr.toString() };
};

describe('every generated launcher parses', () => {
  const all = launchers();
  const shells: readonly (readonly string[])[] = [
    ['bash', '-n'],
    ['bash', '--posix', '-n'],
    ['sh', '-n'],
  ];
  it('should cover every kind of launcher', () => {
    should(all.length).be.above(100);
  });
  for (const shell of shells) {
    it(`should be accepted by \`${shell.join(' ')}\``, () => {
      const failures: string[] = [];
      all.forEach(([label, script], index) => {
        const file = join(directory, `launcher-${index}.sh`);
        writeFileSync(file, script);
        const { status, stderr } = parse(shell, file);
        if (status !== 0) failures.push(`${label}: exit ${status}: ${stderr.trim().split('\n')[0]}`);
      });
      should(failures.slice(0, 5)).eql([]);
      should(failures.length).equal(0);
    });
  }
});

describe('a guard-only launcher', () => {
  const guardOnly = (env: Readonly<Record<string, string>>, secretsFile?: string): string =>
    renderRuntimeWrapperScript(runtime('claude', false, env, secretsFile))
      .split('\n')
      .filter(line => !line.startsWith('export ') && !line.startsWith('exec '))
      .join('\n');

  const run = (script: string, env: Record<string, string>): { status: number | null; stderr: string } => {
    const file = join(directory, `guard-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(file, script);
    const result = Bun.spawnSync(['bash', file], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { status: result.exitCode, stderr: result.stderr.toString() };
  };

  it('should refuse with the variable and every secret named when a store variable is unset', () => {
    const script = guardOnly({ AUTH_HEADER: '${secret:SCHEME} ${secret:WORK_KEY}' });
    const result = run(script, {});
    should(result.status).not.equal(0);
    should(result.stderr).containEql('AUTH_HEADER');
    should(result.stderr).containEql('SCHEME');
    should(result.stderr).containEql('WORK_KEY');
    should(result.stderr).containEql("Ferretry's secret store");
    should(run(script, { AUTH_HEADER: 'x' }).status).equal(0);
  });

  it('should refuse naming the variable and a hostile secretsFile path when a reference is unset', () => {
    const file = `/tmp/it's a "}$\` mix/secrets`;
    const script = guardOnly({ T: '$TOKEN_VAR' }, file);
    const result = run(script, {});
    should(result.status).not.equal(0);
    should(result.stderr).containEql('TOKEN_VAR');
    should(result.stderr).containEql(file);
    should(run(script, { TOKEN_VAR: 'x' }).status).equal(0);
  });
});
