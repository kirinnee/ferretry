import { afterEach, beforeEach, expect, test } from 'bun:test';
import { HarnessConfigSchema as ClaudeHarnessSchema } from '@ferretry/plugin-claude-code/contract';
import { HarnessConfigSchema as CodexHarnessSchema } from '@ferretry/plugin-codex/contract';
import { AgendaConfigSchema } from '@ferretry/plugin-agenda/contract';
import { ConnectionsConfigSchema } from '@ferretry/plugin-connections/contract';
import { CatalogsConfigSchema } from '@ferretry/plugin-catalogs/contract';
import { VaultConfigSchema } from '@ferretry/core-vault/contract';
import { AsksConfigFile } from '@ferretry/core-asks/contract';
import { CAPABILITY_NAMES, DEFAULT_SECURITY_SETTINGS, GateConfigSchema } from '@ferretry/core-gate/contract';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import { daemonSettingsStep } from '../../src/steps/daemon-settings.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

/** A v4 file written as raw text (for the files this step must never open, or a damaged one). */
const raw = async (path: string, text: string) => {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
};
const daemon = (value: unknown) => f.put('config/daemon.json', value);

const text = (path: string) => readFile(join(f.to, 'config', path), 'utf8');
/** The file exactly as the owner will read it: no v5 defaults applied. */
const written = async (path: string): Promise<Record<string, unknown>> =>
  parse(await text(path), { version: '1.2', uniqueKeys: true }) as Record<string, unknown>;
const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => schema.parse((await written(path)) ?? {});
const exists = (path: string) =>
  stat(join(f.to, 'config', path)).then(
    () => true,
    () => false,
  );

test('a v4 restricted grant stays restricted, and configure is carried only where use is on', async () => {
  await daemon({
    grants: {
      terminal: { use: false, configure: false },
      browser: { use: true, configure: false },
      secrets: { use: false, configure: true },
    },
  });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const gate = await read('gate.yaml', GateConfigSchema);
  expect(gate.grants.terminal).toEqual({ use: false, configure: false });
  expect(gate.grants.browser).toEqual({ use: true, configure: false });
  // v4 refused every demand of a capability whose use is off, so configure was never in effect.
  expect(gate.grants.secrets).toEqual({ use: false, configure: false });
  expect(gate.grants.fleet).toEqual({ use: true, configure: true });
});

test('a v4 grant or axis left out is written explicitly with v4’s value, never left to v5’s wider default', async () => {
  // terminal.configure is unwritten: v4 enforced it as off (use is off); v5's default for an unwritten axis is on.
  await daemon({ grants: { terminal: { use: false } } });
  expect((await daemonSettingsStep.run(f.ctx())).status).toBe('converted');
  const file = await written('gate.yaml');
  const grants = file.grants as Record<string, Record<string, unknown>>;
  // Every capability and both axes are in the FILE, so no v5 default (today's or a later one) is ever read.
  for (const name of CAPABILITY_NAMES) {
    expect(typeof grants[name]?.use).toBe('boolean');
    expect(typeof grants[name]?.configure).toBe('boolean');
  }
  expect(grants.terminal).toEqual({ use: false, configure: false });
  expect(GateConfigSchema.parse({ grants: { terminal: { use: false } } }).grants.terminal.configure).toBe(true);
  // No security.json: v4's defaults, also written out in full.
  expect(file.security).toEqual({ ...DEFAULT_SECURITY_SETTINGS, memberUnlockDays: 30 });
});

test('a home with no daemon.json still writes every grant explicitly', async () => {
  expect((await daemonSettingsStep.run(f.ctx())).status).toBe('converted');
  const gate = await written('gate.yaml');
  expect(Object.keys(gate.grants as object).sort()).toEqual([...CAPABILITY_NAMES].sort());
  expect(await exists('connections.yaml')).toBe(false);
});

test('security.json carries as written; a damaged one carries v4’s strictest reading', async () => {
  const settings = {
    unlockOnOpen: true,
    unlockValidityHours: 2,
    stepUpOnActions: true,
    stepUpWindowMinutes: 5,
    deviceKeyRotationDays: 14,
    idleExpiryDays: 10,
  };
  await f.put('state/security.json', { schemaVersion: 1, settings, updatedAt: '2026-11-01T00:00:00.000Z' });
  await daemonSettingsStep.run(f.ctx());
  // v4's member unlock (unset: its default, 30) is kept beside the security settings.
  expect((await read('gate.yaml', GateConfigSchema)).security).toEqual({ ...settings, memberUnlockDays: 30 });

  const damaged = await fixture();
  try {
    await mkdir(join(damaged.from, 'state'), { recursive: true });
    await writeFile(join(damaged.from, 'state/security.json'), '{ not json');
    const report = await daemonSettingsStep.run(damaged.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toContain('strictest');
    const gate = GateConfigSchema.parse(
      parse(await readFile(join(damaged.to, 'config/gate.yaml'), 'utf8'), { version: '1.2' }),
    );
    expect(gate.security).toMatchObject({ unlockValidityHours: 1, stepUpOnActions: true, stepUpWindowMinutes: 0 });
  } finally {
    await damaged.clean();
  }
});

test('an owner’s carrier enabled: false stays false (relay, tunnel, WebRTC)', async () => {
  await daemon({
    carriers: [
      { kind: 'bind', host: '127.0.0.1', port: 7444 },
      { kind: 'relay', source: 'discovery', enabled: false },
      { kind: 'tunnel', source: 'discovery', enabled: false },
    ],
    webrtc: { enabled: false },
  });
  expect((await daemonSettingsStep.run(f.ctx())).status).toBe('converted');
  const file = await written('connections.yaml');
  expect(file.relay).toEqual([{ source: 'discovery', enabled: false }]);
  expect(file.tunnel).toEqual({ enabled: false });
  expect(file.webrtc).toEqual({ enabled: false });
  expect(file.direct).toEqual({ host: '127.0.0.1', port: 7444 });
  const connections = ConnectionsConfigSchema.parse(file);
  expect(connections.relay?.[0]?.enabled).toBe(false);
});

test('the legacy spelling carries too: host/port become direct, a switched-off relay block stays off', async () => {
  await daemon({ port: 7455, relay: { url: 'wss://relay.example.com', enabled: false, reconnectSeconds: 9 } });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const file = await written('connections.yaml');
  expect(file.direct).toEqual({ host: '127.0.0.1', port: 7455 });
  expect(file.relay).toEqual([{ url: 'wss://relay.example.com', enabled: false, reconnectSeconds: 9 }]);
  expect(file.tunnel).toBeUndefined();
});

test('a bind supersedes host/port, and every relay entry carries in order with its own on/off', async () => {
  await daemon({
    host: '0.0.0.0',
    carriers: [
      { kind: 'bind', host: '127.0.0.1', port: 7444 },
      { kind: 'relay', url: 'wss://own.example.com' },
      { kind: 'relay', source: 'discovery', enabled: false },
    ],
  });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const file = await written('connections.yaml');
  expect(file.direct).toEqual({ host: '127.0.0.1', port: 7444 });
  expect(file.relay).toEqual([
    { url: 'wss://own.example.com', enabled: true },
    { source: 'discovery', enabled: false },
  ]);
  expect(report.notCarried.map(item => item.what)).toContain('config/daemon.json host');
  expect(report.kept).toContainEqual({ what: 'relay entries', count: 2 });

  // Two relays switched on: v5 dials the same ordered set, so both carry.
  const two = await fixture();
  try {
    await two.put('config/daemon.json', {
      carriers: [
        { kind: 'relay', url: 'wss://own.example.com' },
        { kind: 'relay', source: 'discovery' },
      ],
    });
    expect((await daemonSettingsStep.run(two.ctx())).status).toBe('converted');
    const relays = parse(await readFile(join(two.to, 'config/connections.yaml'), 'utf8'), { version: '1.2' }).relay;
    expect(relays).toEqual([
      { url: 'wss://own.example.com', enabled: true },
      { source: 'discovery', enabled: true },
    ]);
  } finally {
    await two.clean();
  }
});

test('harness paths and the agenda deadline are added to the files the Settings step wrote', async () => {
  await raw('config/machine.yaml', 'agentPermissions: skip\nagendaMode: false\n');
  await daemon({
    harness: { paths: { claude: '~/bin/claude', codex: '/opt/codex/bin/codex' }, searchPaths: ['~/.local/bin'] },
    agenda: { deadlineWarnHours: 6 },
    attention: { deadlineWarnHours: 1, replySettleSeconds: 20 },
  });
  const ctx = f.ctx();
  expect((await settingsStep.run(ctx)).status).toBe('converted');
  const report = await daemonSettingsStep.run(ctx);
  expect(report.status).toBe('converted');
  expect(await read('harness-claude-code.yaml', ClaudeHarnessSchema)).toEqual({
    permissionMode: 'skip',
    binary: '~/bin/claude',
    searchPaths: ['~/.local/bin'],
  });
  expect(await read('harness-codex.yaml', CodexHarnessSchema)).toEqual({
    permissionMode: 'skip',
    binary: '/opt/codex/bin/codex',
    searchPaths: ['~/.local/bin'],
  });
  // agenda wins key by key over attention, as v4 read it.
  expect(await read('agenda.yaml', AgendaConfigSchema)).toMatchObject({ agendaMode: false, deadlineWarnHours: 6 });
  expect(report.notCarried.map(item => item.what)).toContain('config/daemon.json agenda.replySettleSeconds');
});

test('a key v4 did not boot with, a wrong type, or an unknown capability fails the step by key, never by value', async () => {
  for (const [document, where] of [
    [{ grants: { telepathy: { use: true } } }, 'grants'],
    [{ grants: { terminal: { use: 'yes' } } }, 'grants.terminal.use'],
    [{ portal: 'FAKE-VALUE-NOT-ECHOED' }, 'portal'],
  ] as const) {
    const home = await fixture();
    try {
      await home.put('config/daemon.json', document);
      const report = await daemonSettingsStep.run(home.ctx());
      expect(report.status).toBe('failed');
      expect(report.note).toContain(where);
      expect(JSON.stringify(report)).not.toContain('FAKE-VALUE-NOT-ECHOED');
      expect(JSON.stringify(report)).not.toContain('"yes"');
    } finally {
      await home.clean();
    }
  }
});

test('nothing secret appears in the report: a collector address and retired files are named, never read', async () => {
  const marker = 'FAKE-SECRET-MARKER-0f3c9a';
  await daemon({
    secretEnvironment: { AUTH_HEADER: 'Bearer ${secret:FAKE_TOKEN}' },
    usage: { url: `https://user:${marker}@collector.example.com/usage` },
    corsOrigins: ['https://own-app.example.com'],
    terminals: { shell: '/bin/zsh' },
  });
  await raw('state/operator-password.json', JSON.stringify({ verifier: marker }));
  await raw('config/routing.json', JSON.stringify({ accounts: [{ accountId: marker }] }));
  const report = await daemonSettingsStep.run(f.ctx());
  // routing.json is the Packs step's (tests/unit/packs.test.ts): this step neither waits on it nor opens it.
  expect(report.status).toBe('converted');
  expect(report.note ?? '').not.toContain('routing');
  const shown = JSON.stringify(report);
  expect(shown).not.toContain(marker);
  expect(shown).not.toContain('own-app.example.com');
  const dropped = report.notCarried.map(item => item.what);
  for (const what of ['config/daemon.json usage', 'config/daemon.json terminals', 'state/operator-password.json'])
    expect(dropped).toContain(what);
  expect(dropped.some(what => what.includes('corsOrigins') && what.includes('without the hosted app'))).toBe(true);
  for (const file of await readdir(join(f.to, 'config')))
    expect(await readFile(join(f.to, 'config', file), 'utf8')).not.toContain(marker);
  // The recipe carries to vault.yaml key for key; only its count is reported.
  expect(await read('vault.yaml', VaultConfigSchema)).toEqual({
    secretEnvironment: { AUTH_HEADER: 'Bearer ${secret:FAKE_TOKEN}' },
  });
  expect(report.kept).toContainEqual({ what: 'secret environment recipes (vault.yaml)', count: 1 });
  expect(shown).not.toContain('FAKE_TOKEN');
});

test('a recipe holding a raw secret fails the step by key, never by value, and writes nothing', async () => {
  const fake = 'sk-ant-FAKEFAKEFAKEFAKE1234';
  await daemon({ secretEnvironment: { AUTH_HEADER: `Bearer ${fake}` } });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('secretEnvironment.AUTH_HEADER');
  expect(JSON.stringify(report)).not.toContain(fake);
  expect(await readdir(f.to).catch(() => [])).toEqual([]);
});

test('agenda resurfaceAfterMinutes carries into asks.yaml; absent stays absent', async () => {
  await daemon({ agenda: { resurfaceAfterMinutes: 45 } });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await read('asks.yaml', AsksConfigFile.schema as z.ZodType<{ resurfaceAfterMinutes?: number }>)).toEqual({
    resurfaceAfterMinutes: 45,
  });
  expect(report.notCarried.map(item => item.what).join('\n')).not.toContain('resurfaceAfterMinutes');
});

test('a shorter member unlock carries into gate.yaml security', async () => {
  await daemon({ catalogs: { memberUnlockDays: 7 } });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await read('gate.yaml', GateConfigSchema)).security.memberUnlockDays).toBe(7);
  expect(report.kept).toContainEqual({ what: 'member unlock days (from daemon.json catalogs)', count: 1 });
});

test('daemon.json catalogs becomes catalogs.yaml: download links off stay off, the member unlock is v4’s', async () => {
  await daemon({
    catalogs: { linkStore: { enabled: false }, memberUnlockDays: 7 },
    grants: { sharing: { use: false } },
  });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await read('catalogs.yaml', CatalogsConfigSchema)).toEqual({
    linkStore: { enabled: false },
    memberUnlockDays: 7,
  });
  expect((await read('gate.yaml', GateConfigSchema)).security.memberUnlockDays).toBe(7);
  expect((await read('gate.yaml', GateConfigSchema)).grants.sharing).toEqual({ use: false, configure: false });
  expect(report.kept).toContainEqual({ what: 'catalog settings', count: 2 });
});

test('the owner’s own link store is carried, with v4’s default member unlock written out', async () => {
  await daemon({ catalogs: { linkStore: { url: 'https://links.example.com' } } });
  expect((await daemonSettingsStep.run(f.ctx())).status).toBe('converted');
  expect(await read('catalogs.yaml', CatalogsConfigSchema)).toEqual({
    linkStore: { url: 'https://links.example.com' },
    memberUnlockDays: 30,
  });
});

test('a dry run writes nothing and still reports what it would carry', async () => {
  await daemon({ grants: { pairing: { use: false } }, webrtc: { enabled: false } });
  const report = await daemonSettingsStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.note).toContain('dry run');
  expect(report.kept.map(item => item.what)).toContain('carriers');
  expect(await readdir(f.to).catch(() => [])).toEqual([]);
});
