/**
 * Every launcher kind the fleet emits, parsed by every shell that may run it.
 *
 * A launcher is `#!/bin/sh`, and `/bin/sh` is a different program on different hosts: dash on Debian
 * and Ubuntu, bash on macOS. A script that one of them reads and the other rejects dies at start on
 * the one it rejects — before any ferret runs, with nothing in the fleet to say why — and a test that
 * parses with only the local `sh` cannot see it. The secret-backed launcher did exactly that: its
 * guard was `: "${NAME:?… Ferretry's secret store …}"`, and the apostrophe opened a single quote under
 * bash while dash read it as text (BUG 3, &B192).
 *
 * So each kind is written to a file and parsed with `bash -n`, `bash --posix -n` (bash as `sh` runs in
 * that mode) and `sh -n`. The guards are then RUN, because "parses" is not "refuses with the message".
 */
import { describe, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import { type RuntimeWrapperInput, renderCommandScript, renderRuntimeWrapperScript } from '../../src/lib/wrappers.ts';

const ID = '00000000-0000-4000-8000-000000000001';

const runtime = (overrides: Partial<RuntimeWrapperInput> = {}): RuntimeWrapperInput => {
  const harness: HarnessKind = overrides.harness ?? 'claude';
  return {
    name: 'claude-work',
    id: ID,
    harness,
    agent: true,
    configDirectory: '$HOME/.state/fleet/homes/work',
    env: {},
    args: ['--model', 'model one'],
    seedFirstRun: harness === 'claude',
    trustLaunchFolder: harness === 'codex',
    fyCommand: 'fy',
    ...overrides,
  };
};

/** Characters that end or reopen a shell word. A secrets file path can hold any of them (a secret name cannot: it is A-Z, 0-9, _). */
const HOSTILE = `it's "a" $(touch /tmp/fy-pwned) \`id\` } \\ ;`;

const KINDS: readonly { readonly label: string; readonly script: string }[] = [
  { label: 'a claude agent', script: renderRuntimeWrapperScript(runtime()) },
  { label: 'a claude runtime that is not an agent', script: renderRuntimeWrapperScript(runtime({ agent: false })) },
  { label: 'a codex agent', script: renderRuntimeWrapperScript(runtime({ harness: 'codex', name: 'codex-work' })) },
  {
    label: 'a plain runtime exporting literals',
    script: renderRuntimeWrapperScript(runtime({ env: { ANTHROPIC_BASE_URL: "https://example.invalid/it's" } })),
  },
  {
    label: 'a runtime referencing an environment variable, with a secrets file',
    script: renderRuntimeWrapperScript(
      runtime({ env: { ANTHROPIC_AUTH_TOKEN: '$PROVIDER_TOKEN' }, secretsFile: '~/.config/fy/provider-env' }),
    ),
  },
  {
    label: 'a runtime referencing an environment variable, with a secrets file whose path holds shell syntax',
    script: renderRuntimeWrapperScript(
      runtime({ env: { ANTHROPIC_AUTH_TOKEN: '$PROVIDER_TOKEN' }, secretsFile: `/srv/${HOSTILE}/env` }),
    ),
  },
  {
    label: 'a secret-backed runtime',
    script: renderRuntimeWrapperScript(runtime({ env: { ANTHROPIC_AUTH_TOKEN: '${secret:WORK_KEY}' } })),
  },
  {
    label: 'a runtime composing several secrets',
    script: renderRuntimeWrapperScript(runtime({ env: { AUTH_HEADER: '${secret:SCHEME} ${secret:WORK_KEY}' } })),
  },
  {
    label: 'a runtime that cannot launch',
    script: renderRuntimeWrapperScript(runtime({ refusal: "the profile's model is gone" })),
  },
  {
    label: 'a command over a runtime',
    script: renderCommandScript({
      command: { wrapper: 'crc-work', target: ID, flags: ['--chrome', "it's"], alias: 'crc' },
      targetWrapper: 'claude-work',
      binDir: '/home/me/.state/fleet/bin',
    }),
  },
];

/** How each shell is asked to PARSE a file without running it. */
const PARSERS: readonly (readonly string[])[] = [
  ['bash', '-n'],
  ['bash', '--posix', '-n'],
  ['sh', '-n'],
];

const written = (script: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'fy-launcher-')), 'launcher');
  writeFileSync(file, script, { mode: 0o755 });
  return file;
};

describe('every launcher kind', () => {
  for (const kind of KINDS) {
    for (const parser of PARSERS) {
      it(`should parse ${kind.label} under \`${parser.join(' ')}\``, () => {
        // Act
        const result = Bun.spawnSync([...parser, written(kind.script)]);

        // Assert — the shell's own complaint is the failure message
        should(result.stderr.toString()).equal('');
        should(result.exitCode).equal(0);
      });
    }
  }
});

/** The guard lines of a launcher, run alone with `env`: what happens before anything else would. */
const runGuards = (script: string, shell: readonly string[], env: Readonly<Record<string, string>>) => {
  const guards = script.split('\n').filter(line => line.startsWith('[ -n "${'));
  const result = Bun.spawnSync([...shell, written(`${guards.join('\n')}\necho passed\n`)], {
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
};

const SHELLS: readonly (readonly string[])[] = [['bash'], ['bash', '--posix'], ['sh']];

describe('the requirement a secret-backed launcher carries', () => {
  const script = renderRuntimeWrapperScript(runtime({ env: { ANTHROPIC_AUTH_TOKEN: '${secret:WORK_KEY}' } }));

  for (const shell of SHELLS) {
    it(`should refuse with one clear line, naming the secret, under \`${shell.join(' ')}\` when the variable is unset`, () => {
      // Act
      const actual = runGuards(script, shell, {});

      // Assert
      should(actual.exitCode).equal(1);
      should(actual.stdout).equal('');
      should(actual.stderr).equal(
        'ferretry: ANTHROPIC_AUTH_TOKEN is not set — this account takes it from the Ferretry secret store (secret WORK_KEY). Launch it through the daemon, or run: fy secret set WORK_KEY\n',
      );
    });

    it(`should refuse an empty value too, like \`\${NAME:?}\` did, under \`${shell.join(' ')}\``, () => {
      // Act
      const actual = runGuards(script, shell, { ANTHROPIC_AUTH_TOKEN: '' });

      // Assert
      should(actual.exitCode).equal(1);
    });

    it(`should let the launch go on under \`${shell.join(' ')}\` once the daemon has set the variable`, () => {
      // Act — a fixture string, never a credential
      const actual = runGuards(script, shell, { ANTHROPIC_AUTH_TOKEN: 'fixture' });

      // Assert
      should(actual.exitCode).equal(0);
      should(actual.stdout).equal('passed\n');
    });
  }
});

describe('the requirement a launcher with an environment reference carries', () => {
  it('should print a secrets file path holding shell syntax as text, running none of it', () => {
    // Arrange
    const script = renderRuntimeWrapperScript(
      runtime({ env: { ANTHROPIC_AUTH_TOKEN: '$PROVIDER_TOKEN' }, secretsFile: `/srv/${HOSTILE}/env` }),
    );

    // Act
    const actual = runGuards(script, ['sh'], {});

    // Assert
    should(actual.exitCode).equal(1);
    should(actual.stderr).equal(`ferretry: PROVIDER_TOKEN is not set — expected it from /srv/${HOSTILE}/env\n`);
  });
});
