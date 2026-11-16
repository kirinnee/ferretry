/**
 * Launch flags on a Codex settings item (owner decision !A525): ANY flag is accepted, the launch keeps for itself the few it
 * decides, an AGENT adding a flag that sets the approval policy or sandbox is held for the owner and the owner's own edit
 * is not, and a flag value that looks like a secret is still refused at the write. The last three run through the REAL
 * kernel writer. Fake values only.
 */
import { describe, expect, test } from 'bun:test';
import { AgentConfigCallSchema, type ConfigCollectionDef } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { agentConfig } from '../../../../core/kernel/host/config/agent.ts';
import { createConfigFiles } from '../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../core/kernel/host/state/memory-fs.ts';
import {
  CODEX_SETTINGS,
  launchFlagsKept,
  type SettingsItem,
  SettingsItemSchema,
  settingsItemLoosens,
} from '../../contract/index.ts';
import { launchFlagsLoosen } from '../../contract/launch-flags.ts';
import { settingsDocument, settingsFlags } from '../../daemon/lib/settings.ts';

describe('launchFlagsKept: any flag passes, the ones the launch decides are dropped', () => {
  test('an arbitrary flag the plugin has never heard of is kept, in order, as its own word', () => {
    const words = [
      '--some-future-flag',
      'a value with spaces',
      '--search',
      '-c',
      'model_verbosity="low"',
      '-p',
      'work',
    ];
    expect(launchFlagsKept(words)).toEqual(words);
  });

  test('a -c override of an ordinary key is kept, in every spelling', () => {
    const words = [
      '-c',
      'tui.notifications=true',
      '--config',
      'a.b=1',
      '--config=c.d=2',
      '-c',
      'mcp_servers.other.command="x"',
    ];
    expect(launchFlagsKept(words)).toEqual(words);
  });

  test('the approval and sandbox switches are dropped with their value', () => {
    expect(
      launchFlagsKept([
        '--search',
        '--dangerously-bypass-approvals-and-sandbox',
        '--full-auto',
        '-a',
        'never',
        '--ask-for-approval=never',
        '-s',
        'danger-full-access',
        '--sandbox',
        'read-only',
        '--no-alt-screen',
        '--debug',
      ]),
    ).toEqual(['--search', '--debug']);
  });

  test('a -c override of the approval policy, the sandbox or the Ferretry tools server is dropped, whatever its spelling', () => {
    expect(
      launchFlagsKept([
        '-c',
        'approval_policy="never"',
        '--config',
        'sandbox_mode="danger-full-access"',
        '--config=approval_policy="never"',
        '-c',
        'mcp_servers.ferretry.command="x"',
        '-c',
        'mcp_servers.ferretry={command="x"}',
        '--keep',
      ]),
    ).toEqual(['--keep']);
  });

  test('a -c with nothing after it, and no words at all, are safe', () => {
    expect(launchFlagsKept(['--keep', '-c'])).toEqual(['--keep', '-c']);
    expect(launchFlagsKept(['--sandbox'])).toEqual([]);
    expect(launchFlagsKept([])).toEqual([]);
  });
});

describe('launchFlagsLoosen: only a permission switch the item did not already carry loosens', () => {
  test('each added switch is named, by flag or key and never by value', () => {
    expect(
      launchFlagsLoosen(
        [],
        [
          '--sandbox',
          'danger-full-access',
          '--full-auto',
          '-c',
          'approval_policy="never"',
          '--config=sandbox_mode="x"',
        ],
      ),
    ).toEqual([
      'a launch flag sets the permission mode (--sandbox)',
      'a launch flag sets the permission mode (--full-auto)',
      'a launch flag sets the permission mode (-c approval_policy)',
      'a launch flag sets the permission mode (-c sandbox_mode)',
    ]);
    expect(
      launchFlagsLoosen([], ['--dangerously-bypass-approvals-and-sandbox', '-a', 'never', '-s', 'x']),
    ).toHaveLength(3);
  });

  test('any other flag or -c key, and a switch the item already had, loosens nothing', () => {
    expect(launchFlagsLoosen([], ['--search', '-c', 'model_verbosity="low"', '-c', '--next'])).toEqual([]);
    expect(launchFlagsLoosen(['--sandbox', 'read-only'], ['--sandbox', 'danger-full-access'])).toEqual([]);
  });

  test('the item’s rule reads the flags of both versions, and a new item has no before', () => {
    expect(settingsItemLoosens(undefined, { settings: {}, flags: ['--full-auto'] })).toHaveLength(1);
    expect(settingsItemLoosens({ settings: {} }, { settings: {} })).toEqual([]);
  });
});

describe('the selected items as the launch reads them', () => {
  const items = new Map<string, SettingsItem>([
    ['z-last', { settings: { tui: { theme: 'dark' }, model: 'z' }, flags: ['--a', '1'] }],
    ['a-none', { settings: { tui: { notifications: true }, model: 'a' } }],
    ['m-middle', { settings: {}, flags: ['--b'] }],
  ]);

  test('settingsFlags appends each item’s flags item by item in name order, and skips an item with none', () => {
    expect(settingsFlags(items)).toEqual(['--b', '--a', '1']);
  });

  test('settingsDocument still merges the same items in name order, nested tables merging and the later item winning', () => {
    expect(settingsDocument(items)).toEqual({ tui: { notifications: true, theme: 'dark' }, model: 'z' });
  });
});

describe('the settings item schema', () => {
  test('holds flags, takes a flags-only item, and refuses an empty word', () => {
    expect(SettingsItemSchema.parse({ settings: { model: 'm' }, flags: ['--search', '-c', 'a=1'] }).flags).toEqual([
      '--search',
      '-c',
      'a=1',
    ]);
    expect(SettingsItemSchema.parse({ flags: ['--search'] })).toEqual({ settings: {}, flags: ['--search'] });
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
const PATH = 'codex/settings/a.yaml';
const BASE = 'settings:\n  model: m\n';
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
    defs: [{ plugin: 'codex', def: CODEX_SETTINGS }],
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
      .port('codex')
      .collection(CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>)
      .get('a');
  return { fs, files, agent, inEffect };
}

describe('through the real writer', () => {
  test('an agent adding ordinary flags of any name is applied at once, and the flags are in effect', async () => {
    const { agent, files, inEffect } = world();
    await files.reload();
    await agent.run(call({ tool: 'config.write', path: PATH, text: BASE }), ferret);
    const answer = await agent.run(
      call({ tool: 'config.write', path: PATH, text: `${BASE}flags:\n  - --some-future-flag\n  - --search\n` }),
      ferret,
    );
    expect(answer.summary).toBe(`Wrote ${PATH}; it is in effect.`);
    expect(files.status().held).toEqual([]);
    expect(inEffect()?.flags).toEqual(['--some-future-flag', '--search']);
  });

  test('an agent adding a sandbox flag is HELD for the owner, and the tighter version stays in effect', async () => {
    const { agent, files, inEffect } = world();
    await files.reload();
    await agent.run(call({ tool: 'config.write', path: PATH, text: BASE }), ferret);
    const answer = await agent.run(
      call({ tool: 'config.write', path: PATH, text: `${BASE}flags:\n  - --sandbox\n  - danger-full-access\n` }),
      ferret,
    );
    expect(answer.summary).toContain('a launch flag sets the permission mode (--sandbox)');
    expect(answer.summary).toContain(`--confirms ${PATH}`);
    expect(inEffect()?.flags).toBeUndefined();
    expect(files.status().held.map(held => held.path)).toEqual([PATH]);
  });

  test('the owner’s own edit adding the same flag is not held', async () => {
    const { files, inEffect } = world();
    await files.reload();
    const outcome = await files
      .writer()
      .write({ plugin: 'codex', def: CODEX_SETTINGS, name: 'a' } as never, `${BASE}flags:\n  - --full-auto\n`, {
        confirmedLoosening: true,
      });
    expect(outcome.kind).toBe('written');
    expect(files.status().held).toEqual([]);
    expect(inEffect()?.flags).toEqual(['--full-auto']);
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
