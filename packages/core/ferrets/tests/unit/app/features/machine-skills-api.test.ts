import { describe, expect, it } from 'bun:test';
import type { SkillEntry } from '@ferretry/protocol';

import { fetchMachineSkillEntries } from '../../../src/features/skills/machine-skills-api.ts';
import { daemonConnection } from '../../../../app/lib/daemon-connection.ts';
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

const inventory = {
  homes: [{ runtime: 'claude', harness: 'claude', home: '/h', skills: [entry({ name: 'b' })] }],
  projects: [{ name: 'app', root: '/p', skills: [entry({ name: 'a', scope: 'project', path: '/p/a/SKILL.md' })] }],
  truncated: false,
};

describe('fetchMachineSkillEntries', () => {
  it('reads the machine inventory, homes first then projects, with every SKILL.md path', async () => {
    const seen: string[] = [];
    const entries = await fetchMachineSkillEntries(connection, async url => {
      seen.push(String(url));
      return json(inventory);
    });
    expect(seen).toEqual(['https://a.example.test/v1/skills']);
    expect(entries.map(skill => [skill.name, skill.path])).toEqual([
      ['b', '/skills/b/SKILL.md'],
      ['a', '/p/a/SKILL.md'],
    ]);
  });

  it('forwards an abort signal', async () => {
    const controller = new AbortController();
    let forwarded: AbortSignal | null | undefined;
    await fetchMachineSkillEntries(
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
    const failure = fetchMachineSkillEntries(connection, async () => json({ error: 'No.', code: 'nope' }, 403));
    await expect(failure).rejects.toBeInstanceOf(DaemonResponseError);
    await expect(failure).rejects.toMatchObject({ status: 403, message: 'No.' });
  });

  it('falls back to the status when the body says nothing', async () => {
    const failure = fetchMachineSkillEntries(connection, async () => new Response('not json', { status: 500 }));
    await expect(failure).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });
});
