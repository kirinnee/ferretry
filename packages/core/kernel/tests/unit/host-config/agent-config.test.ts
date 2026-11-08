import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AGENT_CONFIG_TOOLS, AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import {
  AGENT_CONTROL_KINDS,
  type AgentControlKind,
  type AgentControlReader,
  agentControlRefusal,
} from '../../../contract/bound.ts';
import { ApiError } from '../../../contract/http.ts';
import { defineConfig } from '../../../contract/index.ts';
import { agentConfig, configStatusView, ferretOfStanding } from '../../../host/config/agent.ts';
import { agentMayName } from '../../../host/config/agent-reach.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import kernelManifest from '../../../plugin.ts';
import { captureLog, HOME, loginsDef, manualClock, updatesDef } from './support.ts';

/** Fake only: shaped like a key, never one. */
const FAKE_SECRET =
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const UPDATES = `${HOME}/config/voice.yaml`;

/** A file today's agent could name (`voice.yaml`), with the shape `updatesDef` has. */
const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({
    limit: z.number().int().default(10),
    note: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  axis: 'configure',
  loosens: (before, after) =>
    after.limit > (before?.limit ?? 10) ? [`raises the limit from ${before?.limit ?? 10} to ${after.limit}`] : [],
});
/** Files today's agent could NOT name: one the 5.0 plugins added, and the two person-only ones. */
const gateDef = defineConfig({
  file: 'gate.yaml',
  schema: z.strictObject({ unlockOnOpen: z.boolean().default(true) }),
  axis: 'configure',
  personOnly: true,
  loosens: () => [],
});
const pluginsDef = defineConfig({
  file: 'plugins.yaml',
  schema: z.strictObject({ plugins: z.record(z.string(), z.enum(['on', 'off'])).default({}) }),
  axis: 'configure',
  personOnly: true,
  loosens: (before, after) =>
    Object.entries(after.plugins)
      .filter(([id, state]) => state === 'on' && before?.plugins[id] === 'off')
      .map(([id]) => `turns ${id} on`),
});

const ferretStanding = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };

/** The switches the owner has on, by kind. Fake: no `limits.yaml`. */
function switches(on: readonly AgentControlKind[]): AgentControlReader & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    allows: async (ferret, kind) => {
      asked.push(`${ferret}:${kind}`);
      return on.includes(kind);
    },
  };
}

function world(
  control: AgentControlReader | 'unbound' = switches(['settings']),
  extraDefs: readonly { readonly plugin: string; readonly def: typeof voiceDef | typeof gateDef }[] = [],
) {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'voice', def: voiceDef },
      { plugin: 'logins', def: loginsDef },
      { plugin: 'updates', def: updatesDef },
      { plugin: 'gate', def: gateDef },
      { plugin: 'kernel', def: pluginsDef },
      ...extraDefs,
    ],
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => (control === 'unbound' ? undefined : control),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { fs, files, agent };
}

const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);

async function refusal(act: () => Promise<unknown>): Promise<ApiError> {
  try {
    await act();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the descriptors are today’s', () => {
  const route = (key: string) => kernelManifest.actions?.routes.find(declared => declared.key === key);
  const tool = (name: string) => kernelManifest.actions?.agentTools.find(declared => declared.name === name);

  test('R-0073 GET /v1/config/status: operator, any caller, fleet.use, noStore', () => {
    expect(route('GET /v1/config/status')).toMatchObject({
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
    });
  });

  test('R-0244 POST /v1/agent/config: no minimum, any caller, privileged carriers only, no capability, noStore', () => {
    const declared = route('POST /v1/agent/config');
    expect(declared).toMatchObject({ minimum: 'none', caller: 'any', privilegedOnly: true, noStore: true });
    expect(declared?.capability).toBeUndefined();
  });

  test('T-0032 T-0033 T-0034 the three config tools carry today’s names and words', () => {
    expect(tool('config_read')?.summary).toBe(AGENT_CONFIG_TOOLS.config_read);
    expect(AGENT_CONFIG_TOOLS.config_read).toBe(
      'Read this machine’s Ferretry configuration: no path: every file and problem; a path: that file’s text and etag (pass it to config_write).',
    );
    expect(AGENT_CONFIG_TOOLS.config_validate).toBe(
      'Check a config file’s text as if it were written, without writing it. Answers each problem with its line and the fix.',
    );
    expect(AGENT_CONFIG_TOOLS.config_write).toBe(
      'Write a config file. Refused unless it checks. A change that loosens spending or what agents may do waits for the owner to confirm; tell them.',
    );
    for (const name of ['config_read', 'config_validate', 'config_write'])
      expect(tool(name)).toMatchObject({ minimum: 'authenticated', caller: 'any' });
  });

  test('T-0032 T-0033 T-0034 the inputs are today’s: read takes an optional path, validate path+text, write adds an optional etag', () => {
    const input = (name: string) => tool(name)?.input;
    expect(input('config_read')?.safeParse({}).success).toBe(true);
    expect(input('config_read')?.safeParse({ path: 'machine.yaml' }).success).toBe(true);
    expect(input('config_validate')?.safeParse({ path: 'machine.yaml' }).success).toBe(false);
    expect(input('config_validate')?.safeParse({ path: 'machine.yaml', text: 'a: 1' }).success).toBe(true);
    expect(input('config_write')?.safeParse({ path: 'machine.yaml', text: 'a: 1', etag: 'e' }).success).toBe(true);
    // No field names a ferret or a credential.
    expect(input('config_write')?.safeParse({ path: 'machine.yaml', text: 'a: 1', ferret: 'wren' }).success).toBe(
      false,
    );
  });
});

describe('who is calling comes from the call’s standing', () => {
  test('R-0244 only a ferret’s own token names a ferret; the admin token, a device and no credential name none', () => {
    expect(String(ferretOfStanding(ferretStanding))).toBe('wren');
    expect(ferretOfStanding({ credential: { kind: 'authenticated', tokenClass: 'admin' } })).toBeUndefined();
    expect(ferretOfStanding({ credential: { kind: 'authenticated', tokenClass: 'device' } })).toBeUndefined();
    expect(ferretOfStanding({ credential: { tokenClass: 'ferret', ferret: '' } })).toBeUndefined();
    // A crafted credential that carries a `ferret` but is not a ferret's own token class names none.
    expect(ferretOfStanding({ credential: { tokenClass: 'admin', ferret: 'x' } })).toBeUndefined();
    expect(ferretOfStanding({ credential: { tokenClass: 'device', ferret: 'x' } })).toBeUndefined();
    expect(ferretOfStanding({})).toBeUndefined();
    expect(ferretOfStanding(undefined)).toBeUndefined();
  });

  test('R-0244 a caller that is not a ferret is refused, and the body cannot name one', async () => {
    const { agent } = world();
    const refused = await refusal(() =>
      agent.run(call({ tool: 'config.read' }), { credential: { tokenClass: 'admin' } }),
    );
    expect(refused.status).toBe(403);
    expect(AgentConfigCallSchema.safeParse({ tool: 'config.read', ferret: 'wren' }).success).toBe(false);
    expect(AgentConfigCallSchema.safeParse({ tool: 'config.read', sessionId: 'wren' }).success).toBe(false);
  });
});

describe('the owner’s switch', () => {
  test('R-0244 Ferretry settings off → 403 agent_control_off with today’s sentence, for all three tools, and nothing is written', async () => {
    const { agent, fs } = world(switches([]));
    for (const body of [
      { tool: 'config.read' },
      { tool: 'config.validate', path: 'voice.yaml', text: 'limit: 5\n' },
      { tool: 'config.write', path: 'voice.yaml', text: 'limit: 5\n' },
    ]) {
      const refused = await refusal(() => agent.run(call(body), ferretStanding));
      expect(refused.status).toBe(403);
      expect(refused.code).toBe('agent_control_off');
      expect(refused.message).toBe(
        'This machine does not let agents control Ferretry settings: "What agents may control › Ferretry settings" is off in this machine\'s settings. Ask the person to turn it on if you need it.',
      );
    }
    expect(await fs.readText(UPDATES).catch(() => undefined)).toBeUndefined();
  });

  test('R-0244 the switch asked is Ferretry settings, for the ferret the credential names', async () => {
    const control = switches(['settings']);
    const { agent } = world(control);
    await agent.run(call({ tool: 'config.read' }), ferretStanding);
    expect(control.asked).toEqual(['wren:settings']);
  });

  test('R-0244 only the settings switch opens the config tools: every other kind on, settings off, is refused', async () => {
    const others = AGENT_CONTROL_KINDS.filter(kind => kind !== 'settings');
    const { agent } = world(switches(others));
    expect((await refusal(() => agent.run(call({ tool: 'config.read' }), ferretStanding))).code).toBe(
      'agent_control_off',
    );
  });

  test('R-0244 the port unbound → every config act is refused (fail closed)', async () => {
    const { agent } = world('unbound');
    const refused = await refusal(() => agent.run(call({ tool: 'config.read' }), ferretStanding));
    expect(refused).toMatchObject({ status: 403, code: 'agent_control_off' });
  });

  test('R-0244 Ferrets failing (the reader throws, or never answers true) → refused, never allowed', async () => {
    const throws: AgentControlReader = {
      allows: async () => {
        throw new Error('ferrets is down');
      },
    };
    const { agent } = world(throws);
    expect((await refusal(() => agent.run(call({ tool: 'config.read' }), ferretStanding))).code).toBe(
      'agent_control_off',
    );
  });

  test('R-0244 the refusal sentence names every kind in today’s words', () => {
    expect(agentControlRefusal('terminal')).toContain('control terminals: "What agents may control › Terminals"');
    expect(agentControlRefusal('browser')).toContain('control browsers: "What agents may control › Browsers"');
    expect(agentControlRefusal('files')).toContain('control files: "What agents may control › Files"');
    expect(agentControlRefusal('settings')).toContain(
      'control Ferretry settings: "What agents may control › Ferretry settings"',
    );
    expect(agentControlRefusal('scripts')).toContain('control page scripts: "What agents may control › Page scripts"');
    expect(AGENT_CONTROL_KINDS).toEqual(['terminal', 'browser', 'files', 'settings', 'scripts']);
  });
});

describe('config_read / config_validate / config_write', () => {
  test('T-0032 no path lists every file and problem, in today’s words', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    const answer = await agent.run(call({ tool: 'config.read' }), ferretStanding);
    expect(answer.summary).toBe(
      `1 configuration files in ${HOME}/config; 0 with errors; 0 waiting for the owner's confirmation.`,
    );
    expect(answer.files).toEqual([{ path: 'voice.yaml', kind: 'voice', schema: 'voice.json', state: 'ok' }]);
  });

  test('T-0032 a path returns the file’s text and etag (the etag to pass to config_write)', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    const answer = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    expect(answer).toMatchObject({ summary: 'voice.yaml (ok).', text: 'limit: 5\n', issues: [] });
    expect(answer.etag).toMatch(/^[0-9a-f]{64}$/);
  });

  test('T-0032 config_read never returns a secret value: a file with a raw secret in it is shown by its located issue, not its text', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    fs.seed(UPDATES, `limit: 5\napiKey: ${FAKE_SECRET}\n`);
    await files.reload();
    const answer = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    expect(JSON.stringify(answer)).not.toContain(FAKE_SECRET);
    expect(answer.text).toBe('');
    expect(answer.issues?.[0]).toMatchObject({ severity: 'error' });
    const listing = await agent.run(call({ tool: 'config.read' }), ferretStanding);
    expect(JSON.stringify(listing)).not.toContain(FAKE_SECRET);
  });

  test('T-0032 a ${secret:NAME} reference is read as written', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\napiKey: ${secret:WORK_KEY}\n');
    await files.reload();
    const answer = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    expect(answer.text).toBe('limit: 5\napiKey: ${secret:WORK_KEY}\n');
  });

  test('T-0032 a name no plugin declares is a 400, not a file', async () => {
    const { agent } = world();
    expect(
      (await refusal(() => agent.run(call({ tool: 'config.read', path: 'nothing.yaml' }), ferretStanding))).status,
    ).toBe(400);
  });

  test('T-0033 validate checks as if written and writes nothing; each problem is located with its fix', async () => {
    const { agent, fs } = world();
    const ok = await agent.run(
      call({ tool: 'config.validate', path: 'voice.yaml', text: 'limit: 5\n' }),
      ferretStanding,
    );
    expect(ok).toEqual({ summary: 'voice.yaml checks.', issues: [] });
    const bad = await agent.run(
      call({ tool: 'config.validate', path: 'voice.yaml', text: 'limit: many\n' }),
      ferretStanding,
    );
    expect(bad.summary).toBe('voice.yaml does not check: 1 problem. Fix each and validate again.');
    expect(bad.issues?.[0]).toMatchObject({ severity: 'error', line: 1 });
    expect(await fs.readText(UPDATES).catch(() => undefined)).toBeUndefined();
  });

  test('T-0033 validate refuses a raw secret and never repeats the value', async () => {
    const { agent } = world();
    const answer = await agent.run(
      call({ tool: 'config.validate', path: 'voice.yaml', text: `limit: 5\napiKey: ${FAKE_SECRET}\n` }),
      ferretStanding,
    );
    expect(answer.summary).toContain('does not check');
    expect(JSON.stringify(answer)).not.toContain(FAKE_SECRET);
  });

  test('T-0034 a write that does not loosen is in effect', async () => {
    const { agent, fs } = world();
    const answer = await agent.run(
      call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 5\n' }),
      ferretStanding,
    );
    expect(answer.summary).toBe('Wrote voice.yaml; it is in effect.');
    expect(await fs.readText(UPDATES)).toBe('limit: 5\n');
  });

  test('T-0034 a LOOSENING write is HELD for the owner and NOT applied: the earlier version stays in effect', async () => {
    const { agent, fs, files } = world();
    await agent.run(call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 5\n' }), ferretStanding);
    await files.reload();
    const answer = await agent.run(
      call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 50\n' }),
      ferretStanding,
    );
    expect(answer.summary).toContain('but it loosens what this machine allows (raises the limit from 5 to 50)');
    expect(answer.summary).toContain(
      'waits for the owner to confirm it; the earlier version stays in effect until then',
    );
    expect(answer.summary).toContain('fy agenda add');
    expect(answer.summary).toContain('--confirms voice.yaml');
    expect(files.held()).toHaveLength(1);
    // The version in effect is still 5.
    expect(files.port('voice').file(voiceDef)).toMatchObject({ limit: 5 });
    // The held text is on disk, held; the status says so.
    expect(fs).toBeDefined();
    const status = configStatusView({
      writer: () => files.writer(),
      control: () => undefined,
      status: () => files.status(),
      home: HOME,
      binary: 'fy',
      now: () => 'now',
    });
    expect(status.pending).toEqual([
      { path: 'voice.yaml', etag: answer.etag as string, changes: ['raises the limit from 5 to 50'] },
    ]);
  });

  test('T-0034 the agent can never confirm its own held edit: writing it again stays held, and no call confirms', async () => {
    const { agent, files } = world();
    await agent.run(call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 5\n' }), ferretStanding);
    await files.reload();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await agent.run(call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 50\n' }), ferretStanding);
      await files.reload();
      expect(files.port('voice').file(voiceDef)).toMatchObject({ limit: 5 });
    }
    // The wire has no confirm or discard call at all.
    expect(AgentConfigCallSchema.safeParse({ tool: 'config.confirm', path: 'voice.yaml', etag: 'x' }).success).toBe(
      false,
    );
    expect(
      AgentConfigCallSchema.safeParse({
        tool: 'config.write',
        path: 'voice.yaml',
        text: 'limit: 50\n',
        confirmedLoosening: true,
      }).success,
    ).toBe(false);
    expect(files.held()).toHaveLength(1);
  });

  test('T-0034 a raw secret is refused by the writer, nothing is written, and the value is never repeated', async () => {
    const { agent, fs } = world();
    const answer = await agent.run(
      call({ tool: 'config.write', path: 'voice.yaml', text: `limit: 5\napiKey: ${FAKE_SECRET}\n` }),
      ferretStanding,
    );
    expect(answer.summary).toBe('Nothing was written: voice.yaml does not check. Fix each issue and try again.');
    expect(JSON.stringify(answer)).not.toContain(FAKE_SECRET);
    expect(await fs.readText(UPDATES).catch(() => undefined)).toBeUndefined();
  });

  test('T-0034 a file that does not check is refused with its located issues', async () => {
    const { agent } = world();
    const answer = await agent.run(
      call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: many\n' }),
      ferretStanding,
    );
    expect(answer.summary).toBe('Nothing was written: voice.yaml does not check. Fix each issue and try again.');
    expect(answer.issues?.length).toBeGreaterThan(0);
  });

  test('T-0034 a stale etag never overwrites a newer edit', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    const read = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    fs.seed(UPDATES, 'limit: 6\n');
    await files.reload();
    const answer = await agent.run(
      call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 4\n', etag: read.etag as string }),
      ferretStanding,
    );
    expect(answer.summary).toBe(
      'Nothing was written: voice.yaml changed since it was read; read it again and redo the edit.',
    );
    expect(await fs.readText(UPDATES)).toBe('limit: 6\n');
  });
});

describe('an agent write is as untrusted as a plugin’s own (C1, NN2)', () => {
  const OWNER_SENTENCE = 'names the secret OWNER_KEY, which only the owner may add to a configuration';

  test('T-0034 an agent adding ${secret:X} to a file in effect is HELD with the owner-only sentence, and the plugin does not gain the name', async () => {
    const { agent, files } = world();
    await agent.run(call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 5\n' }), ferretStanding);
    await files.reload();
    const answer = await agent.run(
      call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 5\napiKey: ${secret:OWNER_KEY}\n' }),
      ferretStanding,
    );
    expect(answer.summary).toContain('but it loosens what this machine allows');
    expect(answer.summary).toContain(OWNER_SENTENCE);
    expect(answer.summary).toContain(
      'waits for the owner to confirm it; the earlier version stays in effect until then',
    );
    expect(files.held()).toHaveLength(1);
    await files.reload();
    expect([...files.secretReferences('voice')]).not.toContain('OWNER_KEY');
    expect(files.port('voice').file(voiceDef)).toMatchObject({ limit: 5 });
  });

  test('T-0034 the first write of a file that names ${secret:X} is held too, and writing it again does not confirm it', async () => {
    const { agent, files } = world();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = await agent.run(
        call({ tool: 'config.write', path: 'voice.yaml', text: 'apiKey: ${secret:OWNER_KEY}\n' }),
        ferretStanding,
      );
      expect(answer.summary).toContain(OWNER_SENTENCE);
      await files.reload();
      expect([...files.secretReferences('voice')]).not.toContain('OWNER_KEY');
    }
  });

  test('T-0034 a name already in effect is not "added": rewriting around it is an ordinary write', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\napiKey: ${secret:OWNER_KEY}\n');
    await files.reload();
    // A hand-written reference is held for the owner (NN2) until they confirm it; only then is it in effect.
    const held = files.held();
    expect(held).toHaveLength(1);
    expect(await files.writer().confirm(held[0]?.id as string)).toBe(true);
    await files.reload();
    expect([...files.secretReferences('voice')]).toContain('OWNER_KEY');
    const answer = await agent.run(
      call({ tool: 'config.write', path: 'voice.yaml', text: 'limit: 4\napiKey: ${secret:OWNER_KEY}\n' }),
      ferretStanding,
    );
    expect(answer.summary).toBe('Wrote voice.yaml; it is in effect.');
    expect([...files.secretReferences('voice')]).toContain('OWNER_KEY');
  });
});

describe('the files an agent may name are today’s and no more (C2)', () => {
  const REACH_WORDS =
    'not a Ferretry configuration file — use machine.yaml, warden.yaml, learning.yaml, voice.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml';

  for (const path of ['gate.yaml', 'plugins.yaml', 'updates.yaml']) {
    test(`T-0032 T-0033 T-0034 ${path} is refused on read, validate AND write with today’s words, and nothing is written`, async () => {
      const { agent, fs } = world();
      const calls = [
        { tool: 'config.read', path },
        { tool: 'config.validate', path, text: 'plugins:\n  warden: off\n' },
        { tool: 'config.write', path, text: 'plugins:\n  warden: off\n' },
      ];
      for (const body of calls) {
        const refused = await refusal(() => agent.run(call(body), ferretStanding));
        expect(refused.status).toBe(400);
        expect(refused.code).toBe('invalid_request');
        expect(refused.message).toBe(`the request body is invalid — path: ${REACH_WORDS}`);
      }
      expect(await fs.readText(`${HOME}/config/${path}`).catch(() => undefined)).toBeUndefined();
    });
  }

  test('T-0034 a person-only def is refused even at a path today’s agent could name', async () => {
    const personOnlyWarden = defineConfig({
      file: 'warden.yaml',
      schema: z.strictObject({ on: z.boolean().default(true) }),
      axis: 'configure',
      personOnly: true,
      loosens: () => [],
    });
    const { agent, fs } = world(undefined, [{ plugin: 'warden', def: personOnlyWarden as unknown as typeof voiceDef }]);
    for (const body of [
      { tool: 'config.read', path: 'warden.yaml' },
      { tool: 'config.validate', path: 'warden.yaml', text: 'on: false\n' },
      { tool: 'config.write', path: 'warden.yaml', text: 'on: false\n' },
    ]) {
      const refused = await refusal(() => agent.run(call(body), ferretStanding));
      expect(refused.status).toBe(400);
      expect(refused.message).toBe(`the request body is invalid — path: ${REACH_WORDS}`);
    }
    expect(await fs.readText(`${HOME}/config/warden.yaml`).catch(() => undefined)).toBeUndefined();
  });

  test('T-0032 the listing names only the files the calls would accept', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    fs.seed(`${HOME}/config/gate.yaml`, 'unlockOnOpen: true\n');
    fs.seed(`${HOME}/config/plugins.yaml`, 'plugins: {}\n');
    fs.seed(`${HOME}/config/updates.yaml`, 'limit: 5\n');
    await files.reload();
    const listing = await agent.run(call({ tool: 'config.read' }), ferretStanding);
    expect(listing.files?.map(file => file.path)).toEqual(['voice.yaml']);
    expect(listing.summary).toStartWith('1 configuration files in');
  });

  test('R-0073 today’s reach, path by path', () => {
    for (const path of [
      'machine.yaml',
      'warden.yaml',
      'learning.yaml',
      'voice.yaml',
      'pack.yaml',
      'limits.yaml',
      'models-guide.yaml',
      'account-defaults.yaml',
      'logins/work.yaml',
      'profiles/p.yaml',
      'runtimes/r.yaml',
      'presets/x.yaml',
      'models/m.yaml',
      'components/mcp/github.yaml',
      'components/modelSets/fast.yaml',
    ])
      expect(agentMayName(path)).toBe(true);
    for (const path of [
      'gate.yaml',
      'plugins.yaml',
      'updates.yaml',
      'lessons.yaml',
      'logins/.hidden.yaml',
      'logins/a/b.yaml',
      'logins/x.yml',
      'components/other/x.yaml',
      'components/mcp/a/b.yaml',
      '../machine.yaml',
      'machine.yaml/x.yaml',
      'voice',
    ])
      expect(agentMayName(path)).toBe(false);
  });
});

describe('a file that does not parse is scanned on its raw text (M1)', () => {
  test('T-0032 broken YAML that also holds a key is shown by its issues only, never its text', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    fs.seed(UPDATES, `limit: 5\napiKey: ${FAKE_SECRET}\nbad: [\n`);
    await files.reload();
    const answer = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    expect(JSON.stringify(answer)).not.toContain(FAKE_SECRET);
    expect(answer.text).toBe('');
    expect(answer.summary).toContain('its text is not shown because it holds a raw secret');
    expect(answer.issues?.length).toBeGreaterThan(0);
  });

  test('T-0032 a key under a credential-named key, broken YAML, is withheld too (the entropy test, not only a known shape)', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    fs.seed(UPDATES, 'limit: 5\nauth_token: "q8Zx3LmN7vB2kR9wT4yP6sD1fG5hJ0aE"\nbad: [\n');
    await files.reload();
    const answer = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    expect(answer.text).toBe('');
    expect(JSON.stringify(answer)).not.toContain('q8Zx3LmN7vB2kR9wT4yP6sD1fG5hJ0aE');
  });

  test('T-0032 broken YAML with NO secret in it is still shown, so the agent can fix it', async () => {
    const { agent, fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    fs.seed(UPDATES, 'limit: 5\napiKey: ${secret:WORK_KEY}\nbad: [\n');
    await files.reload();
    const answer = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    expect(answer.text).toBe('limit: 5\napiKey: ${secret:WORK_KEY}\nbad: [\n');
  });
});

describe('GET /v1/config/status', () => {
  test('R-0073 answers today’s view: the directory, files, issues, pending and when it was checked', async () => {
    const { fs, files } = world();
    fs.seed(UPDATES, 'limit: 5\n');
    await files.reload();
    const view = configStatusView({
      writer: () => files.writer(),
      control: () => undefined,
      status: () => files.status(),
      home: HOME,
      binary: 'fy',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(view).toEqual({
      directory: `${HOME}/config`,
      files: [{ path: 'voice.yaml', kind: 'voice', schema: 'voice.json', state: 'ok' }],
      issues: [],
      pending: [],
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('R-0073 with no status source the answer is a 503, never an empty list', () => {
    expect(() =>
      configStatusView({
        writer: () => undefined,
        control: () => undefined,
        status: () => undefined,
        home: HOME,
        binary: 'fy',
        now: () => 'now',
      }),
    ).toThrow(ApiError);
  });
});
