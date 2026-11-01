import { describe, expect, it } from 'bun:test';
import type { SkillEntry } from '@ferretry/protocol';

import {
  fetchMachineSkills,
  machineSkillsCatalog,
  machineSkillsLoader,
} from '../../../src/features/skills/machine-skills-api.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://a.example.test',
  deviceId: 'token-a',
});

const entry = (overrides: Partial<SkillEntry> & Pick<SkillEntry, 'name'>): SkillEntry => ({
  description: 'Does a useful thing.',
  harness: 'claude',
  scope: 'user',
  path: `/skills/${overrides.name}/SKILL.md`,
  runtimes: ['claude'],
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('machineSkillsCatalog', () => {
  it('sorts by name, maps project scope, and calls every other scope global', () => {
    const catalog = machineSkillsCatalog([
      entry({ name: 'zeta' }),
      entry({ name: 'Alpha', scope: 'ferretry' }),
      entry({ name: 'mid', scope: 'project' }),
    ]);
    expect(catalog.harness).toBe('claude');
    expect(catalog.skills.map(skill => [skill.name, skill.scope, skill.origin])).toEqual([
      ['Alpha', 'global', 'claude'],
      ['mid', 'project', 'claude'],
      ['zeta', 'global', 'claude'],
    ]);
  });

  it('leaves out a skill another one hides', () => {
    const catalog = machineSkillsCatalog([entry({ name: 'kept' }), entry({ name: 'hidden', shadowedBy: 'project' })]);
    expect(catalog.skills.map(skill => skill.name)).toEqual(['kept']);
  });

  it('shows one row marked both when two harnesses carry the same skill, and keeps one for the same harness', () => {
    const catalog = machineSkillsCatalog([
      entry({ name: 'run', harness: 'claude' }),
      entry({ name: 'run', harness: 'codex' }),
      entry({ name: 'run', harness: 'codex' }),
      entry({ name: 'solo', harness: 'codex' }),
      entry({ name: 'solo', harness: 'codex' }),
    ]);
    expect(catalog.skills.map(skill => [skill.name, skill.origin])).toEqual([
      ['run', 'both'],
      ['solo', 'codex'],
    ]);
  });

  it('keeps a global and a project skill of the same name as two rows', () => {
    const catalog = machineSkillsCatalog([entry({ name: 'x' }), entry({ name: 'x', scope: 'project' })]);
    expect(catalog.skills.map(skill => skill.scope)).toEqual(['global', 'project']);
  });
});

const inventory = {
  homes: [{ runtime: 'claude', harness: 'claude', home: '/h', skills: [entry({ name: 'b' })] }],
  projects: [{ name: 'app', root: '/p', skills: [entry({ name: 'a', scope: 'project' })] }],
  truncated: false,
};

describe('fetchMachineSkills', () => {
  it('reads the machine inventory and folds homes and projects together', async () => {
    const seen: string[] = [];
    const catalog = await fetchMachineSkills(connection, async url => {
      seen.push(String(url));
      return json(inventory);
    });
    expect(seen).toEqual(['https://a.example.test/v1/skills']);
    expect(catalog.skills.map(skill => skill.name)).toEqual(['a', 'b']);
  });

  it('forwards an abort signal', async () => {
    const controller = new AbortController();
    let forwarded: AbortSignal | null | undefined;
    await fetchMachineSkills(
      connection,
      async (_url, init) => {
        forwarded = init?.signal;
        return json(inventory);
      },
      controller.signal,
    );
    expect(forwarded).toBeDefined();
  });

  it('throws the daemon’s own sentence and code on a refusal', async () => {
    const failure = fetchMachineSkills(connection, async () => json({ error: 'No.', code: 'nope' }, 403));
    await expect(failure).rejects.toBeInstanceOf(DaemonResponseError);
    await expect(failure).rejects.toMatchObject({ status: 403, message: 'No.' });
  });

  it('falls back to the status when the body says nothing', async () => {
    const failure = fetchMachineSkills(connection, async () => new Response('not json', { status: 500 }));
    await expect(failure).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });
});

describe('machineSkillsLoader', () => {
  it('binds one machine and ignores the scope it is handed', async () => {
    const load = machineSkillsLoader(connection, async () => json(inventory));
    const catalog = await load(daemonSessionScope(connection, 'machine'), new AbortController().signal);
    expect(catalog.skills).toHaveLength(2);
  });
});
