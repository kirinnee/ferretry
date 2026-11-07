import { describe, expect, it } from 'bun:test';
import {
  applySkillInstall,
  listSkillInstalls,
  previewSkillInstall,
  readFerretSkills,
  readFerretSkillsInventory,
  readMachineSkills,
  readSkillFile,
  removeSkillInstall,
} from '../../../app/lib/client.ts';
import { ferretInventory, installRecord, machineInventory, previewOf, scripted, skill } from './skills-support.ts';

describe('Skills’ wire, by route key', () => {
  it('reads a ferret’s inventory with its id in the path, and parses what comes back', async () => {
    const { client, calls } = scripted({
      'GET /v1/ferrets/:ferretId/skills/inventory': ferretInventory([skill('review')]),
    });
    const read = await readFerretSkillsInventory(client, 'f1');
    expect(read.skills.map(entry => entry.name)).toEqual(['review']);
    expect(calls[0]).toEqual({
      route: 'GET /v1/ferrets/:ferretId/skills/inventory',
      init: { params: { ferretId: 'f1' } },
    });
  });

  it('fails at the call, not as a blank row, when the answer is not the contract’s shape', async () => {
    const { client } = scripted({ 'GET /v1/skills': { homes: 'nope' } });
    await expect(readMachineSkills(client)).rejects.toThrow();
  });

  it('reads the names a ferret can invoke and the whole machine’s inventory', async () => {
    const { client } = scripted({
      'GET /v1/ferrets/:ferretId/skills': {
        harness: 'codex',
        skills: [{ name: 'a', description: 'd', scope: 'global', origin: 'codex' }],
      },
      'GET /v1/skills': machineInventory(),
    });
    expect((await readFerretSkills(client, 'f1')).harness).toBe('codex');
    expect((await readMachineSkills(client)).projects[0]?.name).toBe('dojo');
  });

  it('G175 reads a SKILL.md only by a listed path, with the ferret as a query when there is one', async () => {
    const { client, calls } = scripted({
      'GET /v1/skills/file': (init: unknown) => ({
        path: (init as { query: { path: string } }).query.path,
        content: '# x',
      }),
    });
    expect((await readSkillFile(client, '/a/SKILL.md')).content).toBe('# x');
    await readSkillFile(client, '/a/SKILL.md', 'f1');
    expect(calls.map(call => call.init)).toEqual([
      { query: { path: '/a/SKILL.md' } },
      { query: { path: '/a/SKILL.md', ferretId: 'f1' } },
    ]);
  });

  it('G173 previews, applies and removes on the route of the target’s scope', async () => {
    const preview = previewOf();
    const { client, calls } = scripted({
      'POST /v1/skill-installs/local/project/preview': preview,
      'POST /v1/skill-installs/local/runtime/preview': previewOf({
        target: { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
      }),
      'POST /v1/skill-installs/local/project': { install: installRecord(), notes: ['Active in a new ferret.'] },
      'DELETE /v1/skill-installs/local/runtime/:installId': {
        installId: installRecord().installId,
        name: 'review',
        destination: '/d',
      },
      'GET /v1/skill-installs/local': { installs: [installRecord()] },
    });
    const request = {
      source: { path: '/home/me/.claude/skills/review/SKILL.md' },
      target: { scope: 'project', projectRoot: '/work/dojo', harness: 'claude-code' },
    } as const;
    expect((await previewSkillInstall(client, 'project', request)).previewId).toBe(preview.previewId);
    await previewSkillInstall(client, 'runtime', {
      source: request.source,
      target: { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
    });
    expect((await applySkillInstall(client, 'project', { previewId: preview.previewId })).notes).toEqual([
      'Active in a new ferret.',
    ]);
    await removeSkillInstall(client, 'runtime', installRecord().installId);
    expect((await listSkillInstalls(client)).installs.length).toBe(1);
    expect(calls.map(call => call.route)).toEqual([
      'POST /v1/skill-installs/local/project/preview',
      'POST /v1/skill-installs/local/runtime/preview',
      'POST /v1/skill-installs/local/project',
      'DELETE /v1/skill-installs/local/runtime/:installId',
      'GET /v1/skill-installs/local',
    ]);
    expect(calls[2]?.init).toEqual({ body: { previewId: preview.previewId } });
  });

  it('G175 refuses to send a request the contract would not take, before it leaves the app', async () => {
    const { client, calls } = scripted({});
    await expect(
      previewSkillInstall(client, 'project', {
        source: { path: 'relative/SKILL.md' },
        target: { scope: 'project', projectRoot: '/w', harness: 'codex' },
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
