import { describe, expect, it } from 'bun:test';
import {
  readFerretSkills,
  readFerretSkillsInventory,
  readMachineSkills,
  readSkillFile,
} from '../../../app/lib/client.ts';
import { ferretInventory, machineInventory, scripted, skill } from './skills-support.ts';

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
});
