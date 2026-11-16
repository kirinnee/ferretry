/**
 * Launch flags on a settings item (owner decision !A525): ANY flag is accepted, the launch keeps for itself the few it
 * decides, an AGENT adding a flag that sets the permission mode is held for the owner and the owner's own edit is not, and
 * a flag value that looks like a secret is still refused at the write. The last three run through the REAL kernel writer.
 * Fake values only.
 */
import { describe, expect, test } from 'bun:test';
import { AgentConfigCallSchema, type ConfigCollectionDef } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { agentConfig } from '../../../../core/kernel/host/config/agent.ts';
import { createConfigFiles } from '../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../core/kernel/host/state/memory-fs.ts';
import {
  CLAUDE_CODE_SETTINGS,
  launchFlagsKept,
  type SettingsItem,
  SettingsItemSchema,
  settingsItemLoosens,
} from '../../contract/index.ts';
import { launchFlagsLoosen } from '../../contract/launch-flags.ts';

describe('launchFlagsKept: any flag passes, the ones the launch decides are dropped', () => {
  test('an arbitrary flag the plugin has never heard of is kept, in order, each value attached to its flag', () => {
    expect(
      launchFlagsKept([
        '--some-future-flag',
        'a value with spaces',
        '--verbose',
        '--add-dir',
        '/a',
        '--add-dir=/b',
        '--x',
        'constructor',
      ]),
    ).toEqual([
      '--some-future-flag=a value with spaces',
      '--verbose',
      '--add-dir=/a',
      '--add-dir=/b',
      '--x=constructor',
    ]);
  });

  test('the permission mode, in either spelling, and both skip switches are dropped with their value', () => {
    expect(
      launchFlagsKept([
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--permission-mode=plan',
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
        '--debug',
      ]),
    ).toEqual(['--verbose', '--debug']);
  });

  test('an `=`-form owned flag drops only itself: the flag and the value right after it stay', () => {
    expect(launchFlagsKept(['--permission-mode=plan', '--model', 'opus'])).toEqual(['--model=opus']);
    expect(launchFlagsKept(['--session-id=abc', '--verbose', '--add-dir', '/a'])).toEqual([
      '--verbose',
      '--add-dir=/a',
    ]);
    expect(launchFlagsKept(['--permission-mode=plan', '--keep=1'])).toEqual(['--keep=1']);
  });

  test('the conversation flags are dropped, so a settings flag cannot break resume or attribution', () => {
    expect(
      launchFlagsKept(['--session-id', 'abc', '--resume', 'abc', '-r', '--continue', '-c', '--fork-session', '--x']),
    ).toEqual(['--x']);
    // `--resume` takes a value only when the next word is not a flag; `--session-id=…` carries its own.
    expect(launchFlagsKept(['--resume', '--x', '--session-id=abc', '-r=abc', '--y'])).toEqual(['--x', '--y']);
  });

  test('a short owned flag is dropped in EVERY spelling: attached value, `=`, and inside a cluster', () => {
    expect(launchFlagsKept(['-rabc', '-r=abc', '-cfoo', '-dr', '-rc', '-vc', '-r', 'abc', '--keep'])).toEqual([
      '--keep',
    ]);
  });

  test('the home’s two files are dropped: --settings and --mcp-config with their value, and nothing else is eaten', () => {
    expect(
      launchFlagsKept(['--settings', 'other.json', '--mcp-config', 'a.json', 'b.json', '--keep', '--settings']),
    ).toEqual(['--keep']);
    expect(launchFlagsKept(['--settings=x.json', '--mcp-config=y.json', '--keep'])).toEqual(['--keep']);
  });

  test('a value flag with no word after it, and no words at all, are safe', () => {
    expect(launchFlagsKept(['--permission-mode'])).toEqual([]);
    expect(launchFlagsKept([])).toEqual([]);
  });
});

describe('launchFlagsKept: an item word is a flag or the value right after one, so no word can change how the launch parses', () => {
  test('a bare -- is refused, so the launch’s flags can never become positionals', () => {
    expect(launchFlagsKept(['--', '--keep'])).toEqual(['--keep']);
    expect(launchFlagsKept(['--keep', '--'])).toEqual(['--keep']);
    expect(launchFlagsKept(['--model', '--'])).toEqual(['--model']);
  });

  test('a subcommand or positional that does not follow a flag is refused, however it is placed', () => {
    expect(launchFlagsKept(['mcp', '--keep', 'update'])).toEqual(['--keep=update']);
    expect(launchFlagsKept(['doctor', 'install'])).toEqual([]);
    expect(launchFlagsKept(['--a', 'one', 'two', '--b'])).toEqual(['--a=one', '--b']);
  });

  test('the word after a bare flag is attached to it, so it can never be read as a subcommand', () => {
    expect(launchFlagsKept(['--verbose', 'mcp'])).toEqual(['--verbose=mcp']);
  });
});

describe('launchFlagsLoosen: only a permission switch the item did not already carry loosens', () => {
  test('each added switch is named, by flag and never by value', () => {
    expect(launchFlagsLoosen([], ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'])).toEqual(
      [
        'a launch flag sets the permission mode (--permission-mode)',
        'a launch flag sets the permission mode (--dangerously-skip-permissions)',
      ],
    );
    expect(launchFlagsLoosen([], ['--allow-dangerously-skip-permissions'])).toHaveLength(1);
  });

  test('any other flag, and a switch the item already had, loosens nothing', () => {
    expect(launchFlagsLoosen([], ['--verbose', '--model', 'x', '--disallowed-tools=Bash'])).toEqual([]);
    expect(launchFlagsLoosen(['--permission-mode=plan'], ['--permission-mode=bypassPermissions'])).toEqual([]);
  });

  test('the item’s rule reads the flags of both versions, and a new item has no before', () => {
    expect(settingsItemLoosens(undefined, { settings: {}, flags: ['--dangerously-skip-permissions'] })).toHaveLength(1);
    expect(settingsItemLoosens({ settings: {} }, { settings: {} })).toEqual([]);
  });
});

describe('the settings item schema', () => {
  test('holds flags, takes a flags-only item, and refuses an empty word', () => {
    expect(
      SettingsItemSchema.parse({ settings: { theme: 'dark' }, flags: ['--verbose', '--model', 'x'] }).flags,
    ).toEqual(['--verbose', '--model', 'x']);
    expect(SettingsItemSchema.parse({ flags: ['--verbose'] })).toEqual({ settings: {}, flags: ['--verbose'] });
    expect(SettingsItemSchema.safeParse({ flags: [''] }).success).toBe(false);
    expect(SettingsItemSchema.safeParse({ flags: ['--x'], nope: 1 }).success).toBe(false);
  });
});

const SILENT = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT,
};
const HOME = '/settings-flags-test-only';
const PATH = 'claude-code/settings/a.yaml';
const BASE = 'settings:\n  theme: dark\n';
const ferret = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } } as const;
const call = (body: Record<string, unknown>) => AgentConfigCallSchema.parse(body);

function world() {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: fixedClock(),
    log: SILENT,
    binary: 'fy',
    defs: [{ plugin: 'claude-code', def: CLAUDE_CODE_SETTINGS }],
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async () => true }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const inEffect = () =>
    files
      .port('claude-code')
      .collection(CLAUDE_CODE_SETTINGS as ConfigCollectionDef<SettingsItem>)
      .get('a');
  return { fs, files, agent, inEffect };
}

describe('through the real writer', () => {
  test('an agent adding ordinary flags of any name is applied at once, and the flags are in effect', async () => {
    const { agent, files, inEffect } = world();
    await files.reload();
    await agent.run(call({ tool: 'config.write', path: PATH, text: BASE }), ferret);
    const answer = await agent.run(
      call({
        tool: 'config.write',
        path: PATH,
        text: `${BASE}flags:\n  - --some-future-flag\n  - --model\n  - opus\n`,
      }),
      ferret,
    );
    expect(answer.summary).toBe(`Wrote ${PATH}; it is in effect.`);
    expect(files.status().held).toEqual([]);
    expect(inEffect()?.flags).toEqual(['--some-future-flag', '--model', 'opus']);
  });

  test('an agent adding a permission flag is HELD for the owner, and the tighter version stays in effect', async () => {
    const { agent, files, inEffect } = world();
    await files.reload();
    await agent.run(call({ tool: 'config.write', path: PATH, text: BASE }), ferret);
    const answer = await agent.run(
      call({ tool: 'config.write', path: PATH, text: `${BASE}flags:\n  - --dangerously-skip-permissions\n` }),
      ferret,
    );
    expect(answer.summary).toContain('a launch flag sets the permission mode (--dangerously-skip-permissions)');
    expect(answer.summary).toContain(`--confirms ${PATH}`);
    expect(inEffect()?.flags).toBeUndefined();
    expect(files.status().held.map(held => held.path)).toEqual([PATH]);
  });

  test('the owner’s own edit adding the same flag is not held', async () => {
    const { files, inEffect } = world();
    await files.reload();
    const outcome = await files
      .writer()
      .write(
        { plugin: 'claude-code', def: CLAUDE_CODE_SETTINGS, name: 'a' } as never,
        `${BASE}flags:\n  - --permission-mode\n  - plan\n`,
        { confirmedLoosening: true },
      );
    expect(outcome.kind).toBe('written');
    expect(files.status().held).toEqual([]);
    expect(inEffect()?.flags).toEqual(['--permission-mode', 'plan']);
  });

  test('a flag value shaped like a secret is still refused, nothing is written, and the value is never repeated', async () => {
    const { agent, files, fs } = world();
    await files.reload();
    await agent.run(call({ tool: 'config.write', path: PATH, text: BASE }), ferret);
    const fake = 'Zk3pQ9vXw2LmN7rT';
    const answer = await agent.run(
      call({ tool: 'config.write', path: PATH, text: `${BASE}flags:\n  - --api-key\n  - ${fake}\n` }),
      ferret,
    );
    expect(answer.summary).toBe(`Nothing was written: ${PATH} does not check. Fix each issue and try again.`);
    expect(JSON.stringify(answer)).not.toContain(fake);
    expect(await fs.readText(`${HOME}/config/${PATH}`)).toBe(BASE);
  });
});
