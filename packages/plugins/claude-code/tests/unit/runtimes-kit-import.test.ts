import { describe, expect, it } from 'bun:test';
import type {
  KitHarvestInput,
  KitHostDocumentRead,
  KitHostLogin,
  KitHostScanInput,
} from '@ferretry/plugin-runtimes/contract';
import { claudeImportKit } from '../../daemon/lib/runtimes-kit/import.ts';

const world = (configuredHome?: string) => {
  const reads: string[][] = [];
  const skills: string[][] = [];
  const projects: KitHostDocumentRead[] = [];
  let beside = 0;
  const input: KitHostScanInput = {
    userHome: '/fixture/home',
    configuredHome,
    read: async (home, path) => {
      reads.push([home, path]);
      return { kind: 'absent', source: path };
    },
    readUserMcp: async () => {
      beside += 1;
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
    projectInstructions: async mcp => {
      projects.push(mcp);
      return [{ path: '/fixture/project', file: 'CLAUDE.md', verified: false }];
    },
  };
  return { input, reads, skills, projects, beside: () => beside };
};

describe('Claude host scan kit', () => {
  it('keeps Claude own default paths, beside-home MCP document and safe scan facts', async () => {
    const w = world();
    const scan = await claudeImportKit.scanHost!(w.input);
    expect(w.reads).toEqual([
      ['/fixture/home/.claude', '/fixture/home/.claude/CLAUDE.md'],
      ['/fixture/home/.claude', '/fixture/home/.claude/settings.json'],
    ]);
    expect(w.skills).toEqual([['/fixture/home/.claude', '/fixture/home/.claude/skills']]);
    expect(w.beside()).toBe(1);
    expect(w.projects).toEqual([scan.mcp!]);
    expect(scan.login).toEqual({ state: 'unknown', reason: 'fixture status' });
    expect(scan.projectInstructions).toEqual([{ path: '/fixture/project', file: 'CLAUDE.md', verified: false }]);
    expect(scan.problems).toEqual(['skill problem']);
    expect(scan.skills[0]?.item).toBe('review');
  });

  it('uses an absolute configured home and its own MCP document after trimming', async () => {
    const w = world(' /fixture/custom ');
    const scan = await claudeImportKit.scanHost!(w.input);
    expect(w.reads).toEqual([
      ['/fixture/custom', '/fixture/custom/CLAUDE.md'],
      ['/fixture/custom', '/fixture/custom/settings.json'],
      ['/fixture/custom', '/fixture/custom/.claude.json'],
    ]);
    expect(w.beside()).toBe(0);
    expect(scan.problems).toEqual(['skill problem']);
  });

  it('keeps the exact relative-home warning and reads the default home instead', async () => {
    const w = world(' relative/home ');
    const scan = await claudeImportKit.scanHost!(w.input);
    expect(w.reads[0]).toEqual(['/fixture/home/.claude', '/fixture/home/.claude/CLAUDE.md']);
    expect(scan.problems).toEqual([
      'CLAUDE_CONFIG_DIR is the relative path "relative/home", so /fixture/home/.claude was read instead.',
      'skill problem',
    ]);
  });
});

describe('Claude host harvest kit', () => {
  const harvestWorld = (skippedEnv = false, skippedModelSet = false) => {
    const env = { ANTHROPIC_MODEL: 'claude-fixture' };
    const rest: Record<string, unknown> = {
      theme: 'dark',
      env,
      hooks: { Stop: [{ hooks: [{ command: 'never executed' }] }] },
    };
    const calls: unknown[][] = [];
    const imported = {
      env: { ANTHROPIC_MODEL: 'claude-fixture' },
      secretKeys: [],
      dropped: [],
      gated: [],
      plain: [],
      minted: [],
    };
    const input: KitHarvestInput = {
      rest,
      source: '/fixture/settings.json',
      mcpSource: '/fixture/.claude.json',
      parsedEnv: env,
      skippedEnv,
      skippedModelSet,
      countHooks: block => {
        calls.push(['hooks', block]);
        return 1;
      },
      importEnvironment: (...args) => {
        calls.push(['env', ...args]);
        return imported;
      },
    };
    return { input, env, rest, calls, imported };
  };

  it('counts and drops hooks, delegates environment handling, and keeps the raw model source', () => {
    const w = harvestWorld();
    const hooks = w.rest.hooks;
    const result = claudeImportKit.harvest!(w.input);
    expect(w.rest).toEqual({ theme: 'dark' });
    expect(w.calls).toEqual([
      ['hooks', hooks],
      ['env', w.env, 'env.', 'settings.json'],
    ]);
    expect(result.hooks).toEqual({ source: '/fixture/settings.json', count: 1 });
    expect(result.envImport).toBe(w.imported);
    expect(result.modelEnvironment).toBe(w.env);
    expect(result.mcpSource).toBe('/fixture/.claude.json');
  });

  it('does not count empty hooks and still harvests the environment', () => {
    const w = harvestWorld();
    w.rest.hooks = {};
    const result = claudeImportKit.harvest!(w.input);
    expect(result.hooks).toBeUndefined();
    expect(w.calls).toEqual([['env', w.env, 'env.', 'settings.json']]);
    expect(w.rest).toEqual({ theme: 'dark' });
  });

  for (const skip of ['env', 'model-set'] as const) {
    it(`keeps the ${skip} choice out of the model source and drops host env from settings`, () => {
      const w = harvestWorld(skip === 'env', skip === 'model-set');
      const result = claudeImportKit.harvest!({ ...w.input, mcpSource: undefined });
      expect(w.rest).toEqual({ theme: 'dark' });
      expect(result.modelEnvironment).toBeUndefined();
      expect(result.mcpSource).toBe('.claude.json');
      expect(w.calls.filter(call => call[0] === 'env')).toHaveLength(skip === 'env' ? 0 : 1);
      if (skip === 'env') expect(result.envImport).toBeUndefined();
    });
  }
});

describe('Claude host login notes', () => {
  const notes: readonly [KitHostLogin, string][] = [
    [
      { state: 'signed-in', email: 'fixture@example.invalid' },
      'Login · fixture@example.invalid. Ferretry and your own `claude` share this login: signing out in one signs out both.',
    ],
    [{ state: 'refresh-due' }, 'Login · your login · Refresh due. Ferretry renews it the first time you launch.'],
    [
      { state: 'not-signed-in' },
      "Claude Code isn't signed in on this machine. Your setup was still imported; sign in later and every runtime on this login can launch.",
    ],
    [
      { state: 'unknown' },
      'Claude Code sign-in is unknown (Logins has no host discovery fact). Your login stays shared in place.',
    ],
    [
      { state: 'unreadable', reason: 'fixture read refused' },
      "Ferretry couldn't read your Claude Code login (fixture read refused). It is still shared in place; check it on the Sign-ins tab.",
    ],
    [
      { state: 'not-shareable' },
      "Your Claude Code login can't be shared in place (it is not kept in a file), so this login needs its own sign-in.",
    ],
  ];

  for (const [login, note] of notes) {
    it(`keeps the ${login.state} message`, () => {
      expect(claudeImportKit.loginNote!(login)).toBe(note);
    });
  }
});
