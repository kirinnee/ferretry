import { describe, expect, it } from 'bun:test';
import type { CliContext, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { fakeConfigDaemon } from '@ferretry/kernel/testing';
import cli from '../../cli/index.ts';
import { HooksItemSchema, SettingsItemSchema } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

/** The Codex cli half over a scripted daemon holding the kernel's config files and local files. */
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

describe('fy harness codex settings | hooks: the ten item verbs (V-0182…V-0187)', () => {
  it('none of the ten answers the not-served sentence or exit 69', async () => {
    const { run, complain } = world();
    for (const kind of ['settings', 'hooks'])
      for (const verb of ['ls', 'show', 'add', 'edit', 'rm']) {
        const code = await run(`harness codex ${kind} ${verb}`, []);
        expect(code).not.toBe(69);
      }
    expect(complain()).not.toMatch(/not served/);
  });

  it('lists the settings items, each with how many profiles use it', async () => {
    const { run, say } = world({
      'codex/settings/strict.yaml': 'settings:\n  model: opus\n',
      'codex/settings/other.yaml': 'settings:\n  model: x\n',
      'profiles/work.yaml': 'contents:\n  - settings/strict\n',
    });
    expect(await run('harness codex settings ls', [])).toBe(0);
    expect(say()).toBe(
      'other  used by 0 profiles\nstrict  used by 1 profile\n\nShow one with `fy harness codex settings show <name>`.\n',
    );
  });

  it('adds a settings item from a JSON file, and the schema accepts what was written', async () => {
    const { run, daemon, say } = world({}, { '/s.json': '{"model":"opus","permissions":{"allow":["Bash(ls)"]}}' });
    expect(await run('harness codex settings add', ['strict'], { file: '/s.json', description: 'strict mode' })).toBe(
      0,
    );
    expect(say()).toContain('Added Codex settings item strict.');
    expect(SettingsItemSchema.parse(Bun.YAML.parse(daemon.files.get('codex/settings/strict.yaml')!))).toEqual({
      description: 'strict mode',
      settings: { model: 'opus', permissions: { allow: ['Bash(ls)'] } },
    });
  });

  it('refuses a settings item with no file, an unreadable file and a file that is not a mapping, in words', async () => {
    const none = world();
    expect(await none.run('harness codex settings add', ['x'], {})).toBe(1);
    expect(none.complain()).toBe(
      'A Codex settings item needs its settings from a file: add --file <path> (JSON or YAML).\n',
    );
    const missing = world();
    expect(await missing.run('harness codex settings add', ['x'], { file: '/nope' })).toBe(1);
    expect(missing.complain()).toBe('Could not read /nope.\n');
    const list = world({}, { '/l.json': '[1,2]' });
    expect(await list.run('harness codex settings add', ['x'], { file: '/l.json' })).toBe(1);
    expect(list.complain()).toBe('/l.json must hold a mapping of keys, so nothing was changed.\n');
  });

  it('adds a hooks item from the harness’s own `hooks:` file or from bare events', async () => {
    const wrapped = world(
      {},
      { '/h.json': '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo"}]}]}}' },
    );
    expect(await wrapped.run('harness codex hooks add', ['guard'], { file: '/h.json' })).toBe(0);
    const document = HooksItemSchema.parse(Bun.YAML.parse(wrapped.daemon.files.get('codex/hooks/guard.yaml')!));
    expect(Object.keys(document.hooks)).toEqual(['PreToolUse']);
    const bare = world({}, { '/b.json': '{"Stop":[{"hooks":[{"type":"command","command":"echo"}]}]}' });
    expect(await bare.run('harness codex hooks add', ['stop'], { file: '/b.json' })).toBe(0);
    expect(
      Object.keys(HooksItemSchema.parse(Bun.YAML.parse(bare.daemon.files.get('codex/hooks/stop.yaml')!)).hooks),
    ).toEqual(['Stop']);
  });

  it('shows one item (events or keys, where it is used), edits its description, and removes it', async () => {
    const files = {
      'codex/hooks/guard.yaml': 'hooks:\n  Stop: []\n',
      'profiles/work.yaml': 'contents:\n  - hooks/guard\n  - mcp/x\n',
    };
    const shown = world(files);
    expect(await shown.run('harness codex hooks show', ['guard'])).toBe(0);
    expect(shown.say()).toContain('Events: Stop');
    expect(shown.say()).toContain('Used by profiles: work');
    const edited = world(files);
    expect(await edited.run('harness codex hooks edit', ['guard'], { description: 'stop guard', yes: true })).toBe(0);
    expect(Bun.YAML.parse(edited.daemon.files.get('codex/hooks/guard.yaml')!)).toEqual({
      description: 'stop guard',
      hooks: { Stop: [] },
    });
    const removed = world(files);
    expect(await removed.run('harness codex hooks rm', ['guard'], { yes: true })).toBe(1);
    expect(removed.complain()).toContain('is a layer in work');
  });
});
