import { describe, expect, it } from 'bun:test';
import type { CliContext, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { fakeConfigDaemon } from '@ferretry/kernel/testing';
import cli from '../../cli/index.ts';
import { SkillsItemSchema } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

/** The Skills cli half over a scripted daemon: the kernel's config files, plus the inventory routes. */
function world(
  files: Record<string, string> = {},
  answers: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const daemon = fakeConfigDaemon(files);
  const out: string[] = [];
  const err: string[] = [];
  const asked: { route: string; params?: unknown }[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const client = {
    call: async (route: string, init?: { params?: unknown }) => {
      if (route in answers) {
        asked.push({ route, params: init?.params });
        return answers[route];
      }
      return await (daemon.client.call as (route: string, init?: unknown) => Promise<unknown>)(route, init);
    },
    subscribe: () => () => undefined,
  };
  const ctx = { manifest, client, io, env } as unknown as CliContext<typeof manifest>;
  const verbs = cli.build?.(ctx)?.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const run = async (verb: string, args: string[], options: VerbInvocation['options'] = {}) =>
    await verbs[verb]!({ args, options });
  return { daemon, run, asked, say: () => out.join(''), complain: () => err.join('') };
}

const ENTRY = {
  name: 'review',
  description: 'Review a change',
  harness: 'claude-code',
  scope: 'ferretry',
  path: '/home/x/skills/review/SKILL.md',
  runtimes: ['claude-work'],
};

describe('fy skill ls | show | add | edit | rm (V-0182…V-0187)', () => {
  it('lists the machine’s skills by runtime home and project, and a ferret’s own when asked', async () => {
    const machine = world(
      {},
      {
        'GET /v1/skills': {
          homes: [{ runtime: 'claude-work', harness: 'claude-code', home: '/h', skills: [ENTRY] }],
          projects: [{ name: 'app', root: '/p/app', skills: [] }],
          truncated: false,
        },
      },
    );
    expect(await machine.run('skill ls', [])).toBe(0);
    expect(machine.say()).toBe(
      'Runtime claude-work (claude-code)\n  review · Ferretry — Review a change\nProject app (/p/app)\n  none\n',
    );

    const ferret = world(
      {},
      {
        'GET /v1/ferrets/:ferretId/skills/inventory': {
          ferretId: 'F1',
          harness: 'claude-code',
          folder: '/p/app',
          runtime: 'claude-work',
          skills: [{ ...ENTRY, shadowedBy: 'project' }],
          truncated: false,
        },
      },
      { FY_SESSION_ID: 'F1' },
    );
    expect(await ferret.run('skill ls', [])).toBe(0);
    expect(ferret.asked[0]).toEqual({
      route: 'GET /v1/ferrets/:ferretId/skills/inventory',
      params: { ferretId: 'F1' },
    });
    expect(ferret.say()).toContain('Skills F1 sees (claude-code, runtime claude-work) in /p/app');
    expect(ferret.say()).toContain('review · Ferretry · hidden by the Project one — Review a change');
  });

  it('inside a ferret --machine still reads the whole machine', async () => {
    const w = world({}, { 'GET /v1/skills': { homes: [], projects: [], truncated: false } }, { FY_SESSION_ID: 'F1' });
    expect(await w.run('skill ls', [], { machine: true })).toBe(0);
    expect(w.asked[0]?.route).toBe('GET /v1/skills');
    expect(w.say()).toBe('No skills on this machine yet.\n');
  });

  it('adds a skills item the plugin’s own schema accepts, and refuses one with no skill', async () => {
    const w = world();
    expect(await w.run('skill add', ['review'], { item: ['review', 'deploy'], harness: 'codex' })).toBe(0);
    expect(SkillsItemSchema.parse(Bun.YAML.parse(w.daemon.files.get('skills/review.yaml')!))).toEqual({
      items: ['review', 'deploy'],
      harness: 'codex',
    });
    const none = world();
    expect(await none.run('skill add', ['review'], {})).toBe(1);
    expect(none.complain()).toBe('A skills item needs at least one --item <skill>.\n');
  });

  it('shows, changes and removes a skills item against the files, with where it is used', async () => {
    const files = {
      'skills/review.yaml': 'items:\n  - review\n',
      'profiles/work.yaml': 'contents:\n  - skills/review\n  - mcp/x\n',
    };
    const shown = world(files);
    expect(await shown.run('skill show', ['review'])).toBe(0);
    expect(shown.say()).toContain('Skills: review');
    expect(shown.say()).toContain('Used by profiles: work');

    const edited = world(files);
    expect(await edited.run('skill edit', ['review'], { item: ['review', 'lint'], yes: true })).toBe(0);
    expect(Bun.YAML.parse(edited.daemon.files.get('skills/review.yaml')!)).toEqual({ items: ['review', 'lint'] });

    const removed = world(files);
    expect(await removed.run('skill rm', ['review'], { yes: true, 'remove-from-profiles': true })).toBe(0);
    expect(removed.daemon.files.has('skills/review.yaml')).toBe(false);
    expect(removed.daemon.files.get('profiles/work.yaml')).toBe('contents:\n  - mcp/x\n');
  });
});
