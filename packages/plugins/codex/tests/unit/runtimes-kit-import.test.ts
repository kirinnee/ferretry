import { describe, expect, it } from 'bun:test';
import type { KitHostScanInput } from '@ferretry/plugin-runtimes/contract';
import { codexImportKit } from '../../daemon/lib/runtimes-kit/import.ts';

const world = (configuredHome?: string) => {
  const reads: string[][] = [];
  const skills: string[][] = [];
  let userMcp = 0;
  const input: KitHostScanInput = {
    userHome: '/fixture/home',
    configuredHome,
    read: async (home, path) => {
      reads.push([home, path]);
      return { kind: 'absent', source: path };
    },
    readUserMcp: async () => {
      userMcp += 1;
      return { kind: 'absent', source: '/fixture/home/.claude.json' };
    },
    skills: async (home, directory) => {
      skills.push([home, directory]);
      return {
        found: [{ item: 'review', source: `${directory}/review`, digest: 'fixture' }],
        problems: ['skill problem'],
      };
    },
    login: async () => ({ state: 'unknown', reason: 'fixture status' }),
    projectInstructions: async () => [],
  };
  return { input, reads, skills, userMcp: () => userMcp };
};

describe('Codex host scan kit', () => {
  it('reads its default home: instructions, config.toml, hooks.json and skills, and never Claude documents', async () => {
    const w = world();
    const scan = await codexImportKit.scanHost!(w.input);
    expect(w.reads).toEqual([
      ['/fixture/home/.codex', '/fixture/home/.codex/AGENTS.md'],
      ['/fixture/home/.codex', '/fixture/home/.codex/config.toml'],
      ['/fixture/home/.codex', '/fixture/home/.codex/hooks.json'],
    ]);
    expect(w.skills).toEqual([['/fixture/home/.codex', '/fixture/home/.codex/skills']]);
    expect(w.userMcp()).toBe(0);
    expect(scan.hooks).toEqual({ kind: 'absent', source: '/fixture/home/.codex/hooks.json' });
    expect(scan.mcp).toBeUndefined();
    expect(scan.projectInstructions).toBeUndefined();
    expect(scan.login).toEqual({ state: 'unknown', reason: 'fixture status' });
    expect(scan.problems).toEqual(['skill problem']);
    expect(scan.skills[0]?.item).toBe('review');
  });

  it('reads an absolute configured home after trimming, and an empty one as the default', async () => {
    const custom = world(' /fixture/custom ');
    await codexImportKit.scanHost!(custom.input);
    expect(custom.reads[0]).toEqual(['/fixture/custom', '/fixture/custom/AGENTS.md']);
    const blank = world('   ');
    await codexImportKit.scanHost!(blank.input);
    expect(blank.reads[0]).toEqual(['/fixture/home/.codex', '/fixture/home/.codex/AGENTS.md']);
  });

  it('reads nothing for a relative CODEX_HOME and says why, as before', async () => {
    const w = world(' relative/home ');
    const scan = await codexImportKit.scanHost!(w.input);
    const reason = 'CODEX_HOME is set to a relative path, so your Codex setup could not be found';
    expect(w.reads).toEqual([]);
    expect(w.skills).toEqual([]);
    expect(scan).toEqual({
      login: { state: 'not-shareable', reason },
      instructions: { kind: 'unreadable', source: ' relative/home ', reason },
      settings: { kind: 'unreadable', source: ' relative/home ', reason },
      hooks: { kind: 'absent', source: ' relative/home ' },
      skills: [],
      problems: [],
    });
  });
});
