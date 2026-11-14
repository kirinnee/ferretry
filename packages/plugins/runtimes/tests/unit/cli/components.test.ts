import { describe, expect, it } from 'bun:test';
import type { CliContext, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { fakeConfigDaemon } from '@ferretry/kernel/testing';
import cli from '../../../cli/index.ts';
import { InstructionsFileSchema } from '../../../contract/config.ts';
import manifest from '../../../manifest.ts';

/** The Runtimes cli half over a scripted daemon holding the kernel's config files and local files. */
function world(files: Record<string, string> = {}, local: Record<string, string> = {}) {
  const daemon = fakeConfigDaemon(files);
  const out: string[] = [];
  const err: string[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const readText = async (path: string): Promise<string> => {
    const text = local[path];
    if (text === undefined) throw new Error('no such file');
    return text;
  };
  const ctx = {
    manifest,
    client: { ...daemon.client, subscribe: () => () => undefined },
    io,
    readText,
  } as unknown as CliContext<typeof manifest>;
  const verbs = cli.build?.(ctx)?.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const run = async (verb: string, args: string[], options: VerbInvocation['options'] = {}) =>
    await verbs[verb]!({ args, options });
  return { daemon, run, say: () => out.join(''), complain: () => err.join('') };
}

const MACHINE = {
  'instructions/house.yaml': 'text: Be kind.\n',
  'mcp/github.yaml': 'command: npx\n',
  'mcp/docs.yaml': 'url: https://docs.example.com/mcp\nharness: codex\n',
  'skills/review.yaml': 'items:\n  - review\n',
  'claude-code/settings/strict.yaml': 'settings:\n  model: opus\n',
  'codex/settings/strict.yaml': 'settings:\n  model: gpt\n',
  'claude-code/hooks/guard.yaml': 'hooks:\n  Stop: []\n',
  'model-sets/heavy.yaml': 'models:\n  - opus\ndefault: opus\n',
  'profiles/work.yaml': 'contents:\n  - mcp/github\n  - settings/strict\n',
  'profiles/top.yaml': 'contents:\n  - profile/work\n',
};

describe('fy components [kind] and fy instruction …: the component verbs Runtimes owns (V-0182…V-0188)', () => {
  it('V-0188 fy components lists every kind, in v4’s order and words, with scope and how many profiles use each', async () => {
    const { run, say } = world(MACHINE);
    expect(await run('components', [])).toBe(0);
    expect(say()).toBe(
      [
        'Instructions — Guidance every session reads first.',
        '  house  (Generic)  used by 0 profile(s)',
        'MCP servers — Tools a session can call.',
        '  docs  (Codex only)  used by 0 profile(s)',
        '  github  (Generic)  used by 2 profile(s)',
        'Skills — Named abilities a session can use.',
        '  review  (Generic)  used by 0 profile(s)',
        'Settings — Flags, environment and options for one tool.',
        '  strict  (Claude only)  used by 2 profile(s)',
        '  strict  (Codex only)  used by 2 profile(s)',
        'Hooks — Commands that run at points in a session, for one tool.',
        '  guard  (Claude only)  used by 0 profile(s)',
        'Model sets — The models a runtime offers, and its default.',
        '  heavy  (Generic)  used by 0 profile(s)',
        '',
        'Show one with the verb of its kind: fy instruction|mcp|skill|model-set show <name>, or fy harness claude-code|codex settings|hooks show <name>.',
        '',
      ].join('\n'),
    );
  });

  it('fy components <kind> lists one kind, --json says the same as data, and an unknown kind is refused naming the kinds', async () => {
    const one = world(MACHINE);
    expect(await one.run('components', ['mcp'])).toBe(0);
    expect(one.say()).toContain('MCP servers — Tools a session can call.');
    expect(one.say()).not.toContain('Skills');
    expect(one.say()).toContain('Show one with `fy mcp show <name>`.');
    const json = world(MACHINE);
    expect(await json.run('components', ['skills'], { json: true })).toBe(0);
    expect(JSON.parse(json.say()).kinds[0].components[0].reference).toBe('skills/review');
    const bad = world(MACHINE);
    expect(await bad.run('components', ['widgets'])).toBe(1);
    expect(bad.complain()).toBe(
      '"widgets" is not a kind of component: use one of instructions, mcp, skills, settings, hooks, modelSets.\n',
    );
  });

  it('says "none yet" for a kind with nothing in it', async () => {
    const { run, say } = world({});
    expect(await run('components', [])).toBe(0);
    expect(say()).toContain('Instructions — Guidance every session reads first.\n  none yet\n');
  });

  it('fy instruction add writes text from a file or from words, and the schema accepts it', async () => {
    const file = world({}, { '/rules.md': 'Always run the tests.\nThen commit.\n' });
    expect(
      await file.run('instruction add', ['house'], {
        file: '/rules.md',
        description: 'house rules',
        harness: 'claude',
      }),
    ).toBe(0);
    expect(InstructionsFileSchema.parse(Bun.YAML.parse(file.daemon.files.get('instructions/house.yaml')!))).toEqual({
      description: 'house rules',
      text: 'Always run the tests.\nThen commit.\n',
      harness: 'claude-code',
    });
    const words = world();
    expect(await words.run('instruction add', ['short'], { text: 'Be kind.' })).toBe(0);
    expect(Bun.YAML.parse(words.daemon.files.get('instructions/short.yaml')!)).toEqual({ text: 'Be kind.' });
  });

  it('refuses instructions with no text, with both sources and an unreadable file, in words', async () => {
    const none = world();
    expect(await none.run('instruction add', ['x'], {})).toBe(1);
    expect(none.complain()).toBe('An instructions item needs its text: add --file <path> or --text <words>.\n');
    const both = world();
    expect(await both.run('instruction add', ['x'], { file: '/a', text: 'b' })).toBe(1);
    expect(both.complain()).toBe('Give the text with --text or --file, not both.\n');
    const missing = world();
    expect(await missing.run('instruction add', ['x'], { file: '/nope' })).toBe(1);
    expect(missing.complain()).toBe('Could not read /nope.\n');
  });

  it('fy instruction ls | show | edit | rm work over the files, keeping the text an edit does not replace', async () => {
    const files = { ...MACHINE, 'profiles/solo.yaml': 'contents:\n  - instructions/house\n  - mcp/github\n' };
    const ls = world(files);
    expect(await ls.run('instruction ls', [])).toBe(0);
    expect(ls.say()).toContain('house  used by 1 profile');
    const show = world(files);
    expect(await show.run('instruction show', ['house'])).toBe(0);
    expect(show.say()).toContain('Text: 8 characters, starting "Be kind."');
    expect(show.say()).toContain('Used by profiles: solo');
    const edit = world(files);
    expect(await edit.run('instruction edit', ['house'], { description: 'about', yes: true })).toBe(0);
    expect(Bun.YAML.parse(edit.daemon.files.get('instructions/house.yaml')!)).toEqual({
      description: 'about',
      text: 'Be kind.',
    });
    const rm = world(files);
    expect(await rm.run('instruction rm', ['house'], { yes: true, 'remove-from-profiles': true })).toBe(0);
    expect(rm.daemon.files.has('instructions/house.yaml')).toBe(false);
    expect(rm.daemon.files.get('profiles/solo.yaml')).toBe('contents:\n  - mcp/github\n');
  });
});
