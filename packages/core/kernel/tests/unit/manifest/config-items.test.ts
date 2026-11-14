import { describe, expect, it } from 'bun:test';
import {
  ConfigItems,
  type ConfigItemKind,
  ItemCommandError,
  itemFlag,
  itemFlagList,
  itemVerb,
} from '../../../manifest/config-items.ts';
import type { TerminalIo, VerbInvocation } from '../../../manifest/implement.ts';
import { fakeConfigDaemon } from '../../../testing/config-daemon.ts';

/** A kind with two fields, so every verb has something to build, keep and change. */
const KIND: ConfigItemKind = {
  collection: 'widgets',
  noun: 'widget',
  layer: 'widgets',
  command: 'widget',
  fields: (invocation, current) => ({
    ...(current ?? {}),
    ...(itemFlag(invocation, 'color') === undefined ? {} : { color: itemFlag(invocation, 'color') }),
    ...(itemFlagList(invocation, 'part').length === 0 ? {} : { parts: itemFlagList(invocation, 'part') }),
  }),
  details: document => [`Color: ${String(document.color ?? 'none')}`],
};

const PROFILE = 'contents:\n  - widgets/gear\n  - mcp/other\n';

function harness(files: Record<string, string> = {}, confirm?: (question: string) => Promise<boolean>) {
  const daemon = fakeConfigDaemon(files);
  const out: string[] = [];
  const err: string[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const items = new ConfigItems(
    { client: daemon.client, io, binary: 'fy', ...(confirm === undefined ? {} : { confirm }) },
    KIND,
  );
  const run = (body: () => Promise<number>) => itemVerb({ io }, body);
  return { daemon, items, run, out, err, say: () => out.join(''), complain: () => err.join('') };
}

const invoke = (args: string[], options: VerbInvocation['options'] = {}): VerbInvocation => ({ args, options });

describe('config items: one collection over the kernel config routes', () => {
  it('lists the items by name with how many profiles use each, and says how to add one when there are none', async () => {
    const empty = harness();
    expect(await empty.run(() => empty.items.ls({ json: false }))).toBe(0);
    expect(empty.say()).toBe('No widgets yet. Add one with `fy widget add <name>`.\n');

    const some = harness({
      'widgets/gear.yaml': 'color: red\n',
      'widgets/cog.yaml': 'color: blue\n',
      'profiles/work.yaml': PROFILE,
    });
    expect(await some.run(() => some.items.ls({ json: false }))).toBe(0);
    expect(some.say()).toBe(
      'cog  used by 0 profiles\ngear  used by 1 profile\n\nShow one with `fy widget show <name>`.\n',
    );
  });

  it('shows one item with where it is used, through a base profile and down to the runtimes', async () => {
    const world = harness({
      'widgets/gear.yaml': 'color: red\n',
      'profiles/work.yaml': PROFILE,
      'profiles/top.yaml': 'contents:\n  - profile/work\n',
      'runtimes/claude-top.yaml': 'login: a\nprofile: top\n',
      'runtimes/claude-other.yaml': 'login: a\nprofile: elsewhere\n',
    });
    expect(await world.run(() => world.items.show('gear', { json: false }))).toBe(0);
    expect(world.say()).toBe(
      [
        'widgets/gear',
        '  Color: red',
        '  Used by profiles: top, work',
        '  Used by runtimes: claude-top',
        '  Changing it changes 2 profiles and 1 runtime. Running sessions keep the old version until restarted.',
        '',
      ].join('\n'),
    );
    const json = harness({ 'widgets/gear.yaml': 'color: red\n' });
    await json.run(() => json.items.show('gear', { json: true }));
    expect(JSON.parse(json.say())).toMatchObject({ reference: 'widgets/gear', document: { color: 'red' } });
  });

  it('refuses to show what is not there, and a name that cannot be one, in words', async () => {
    const world = harness();
    expect(await world.run(() => world.items.show('gear', { json: false }))).toBe(1);
    expect(world.complain()).toBe('There is no widget gear. See them with `fy widget ls`.\n');
    const bad = harness();
    expect(await bad.run(() => bad.items.show('a/b', { json: false }))).toBe(1);
    expect(bad.complain()).toMatch(/is not a name an item can have/);
    const none = harness();
    expect(await none.run(() => none.items.show(undefined, { json: false }))).toBe(1);
    expect(none.complain()).toBe('Say which widget to show.\n');
  });

  it('adds an item as one file against the etag it read, and refuses a name already taken', async () => {
    const world = harness();
    expect(await world.run(() => world.items.add(invoke(['gear'], { color: 'red', part: ['a', 'b'] })))).toBe(0);
    expect(world.say()).toBe('Add widget gear\nAdded widget gear.\n');
    expect(world.daemon.files.get('widgets/gear.yaml')).toBe(
      '# yaml-language-server: $schema=../.schema/test.json\n\ncolor: red\nparts:\n  - a\n  - b\n',
    );
    expect(world.daemon.calls.map(call => call.route)).toEqual(['GET /v1/config/file', 'PUT /v1/config/file']);

    expect(await world.run(() => world.items.add(invoke(['gear'], { color: 'blue' })))).toBe(1);
    expect(world.complain()).toBe('gear is already a widget. Change it with `fy widget edit gear`.\n');
    expect(world.daemon.files.get('widgets/gear.yaml')).toContain('color: red');
  });

  it('a dry run writes nothing and shows the file it would write', async () => {
    const world = harness();
    expect(await world.run(() => world.items.add(invoke(['gear'], { color: 'red', 'dry-run': true })))).toBe(0);
    expect(world.daemon.files.size).toBe(0);
    expect(world.say()).toContain('Dry run: nothing was changed. The file would read:');
    expect(world.say()).toContain('color: red');
  });

  it('edits only the keys a flag names, keeping the owner’s comments, after a yes', async () => {
    const world = harness({
      'widgets/gear.yaml': '# my gear\ncolor: red # warm\nparts:\n  - a\n',
      'profiles/work.yaml': PROFILE,
    });
    // No yes and no terminal: nothing is changed, and it says why.
    expect(await world.run(() => world.items.edit(invoke(['gear'], { color: 'blue' })))).toBe(1);
    expect(world.complain()).toBe(
      'Nothing was changed: this needs a yes. Re-run with --yes to go ahead without being asked.\n',
    );
    expect(world.daemon.files.get('widgets/gear.yaml')).toContain('color: red');

    const yes = harness({
      'widgets/gear.yaml': '# my gear\ncolor: red # warm\nparts:\n  - a\n',
      'profiles/work.yaml': PROFILE,
    });
    expect(await yes.run(() => yes.items.edit(invoke(['gear'], { color: 'blue', yes: true })))).toBe(0);
    expect(yes.daemon.files.get('widgets/gear.yaml')).toBe('# my gear\ncolor: blue # warm\nparts:\n  - a\n');
    expect(yes.say()).toContain(
      'Changing it changes 1 profile. Running sessions keep the old version until restarted.',
    );
    expect(yes.say()).toContain('Changed widget gear.');
  });

  it('asks at a terminal when no --yes is given, and a no changes nothing', async () => {
    const asked: string[] = [];
    const no = harness({ 'widgets/gear.yaml': 'color: red\n' }, async question => {
      asked.push(question);
      return false;
    });
    expect(await no.run(() => no.items.edit(invoke(['gear'], { color: 'blue' })))).toBe(1);
    expect(asked).toEqual(['Go ahead? [y/N]']);
    expect(no.complain()).toBe('Nothing was changed.\n');
    expect(no.daemon.files.get('widgets/gear.yaml')).toBe('color: red\n');
  });

  it('says so when an edit changes nothing, and refuses to edit what is not there', async () => {
    const same = harness({ 'widgets/gear.yaml': 'color: red\n' });
    expect(await same.run(() => same.items.edit(invoke(['gear'], { color: 'red', yes: true })))).toBe(0);
    expect(same.say()).toBe('widget gear already says that: nothing was changed.\n');
    const missing = harness();
    expect(await missing.run(() => missing.items.edit(invoke(['gear'], { yes: true })))).toBe(1);
    expect(missing.complain()).toBe('There is no widget gear to change. Add it with `fy widget add gear`.\n');
  });

  it('removes an unused item against the etag it read, after a yes', async () => {
    const world = harness({ 'widgets/gear.yaml': 'color: red\n' });
    expect(await world.run(() => world.items.remove(invoke(['gear'])))).toBe(1);
    expect(world.daemon.files.has('widgets/gear.yaml')).toBe(true);
    expect(await world.run(() => world.items.remove(invoke(['gear'], { yes: true })))).toBe(0);
    expect(world.daemon.files.has('widgets/gear.yaml')).toBe(false);
    expect(world.say()).toContain('Removed widget gear.');
  });

  it('refuses to remove an item a profile uses, naming the profile and its runtimes, unless told to take it out first', async () => {
    const files = {
      'widgets/gear.yaml': 'color: red\n',
      'profiles/work.yaml': PROFILE,
      'runtimes/claude-work.yaml': 'login: a\nprofile: work\n',
    };
    const refused = harness(files);
    expect(await refused.run(() => refused.items.remove(invoke(['gear'], { yes: true })))).toBe(1);
    expect(refused.complain()).toBe(
      'Widget gear is a layer in work (used by claude-work). Remove it from those first, or add --remove-from-profiles.\n',
    );
    expect(refused.daemon.files.has('widgets/gear.yaml')).toBe(true);

    const taken = harness(files);
    expect(
      await taken.run(() => taken.items.remove(invoke(['gear'], { yes: true, 'remove-from-profiles': true }))),
    ).toBe(0);
    expect(taken.daemon.files.has('widgets/gear.yaml')).toBe(false);
    expect(taken.daemon.files.get('profiles/work.yaml')).toBe('contents:\n  - mcp/other\n');
    expect(taken.say()).toContain('Removes it from work, which changes 1 runtime.');
  });

  it('will not leave a profile with no layers, and changes nothing when it refuses', async () => {
    const world = harness({
      'widgets/gear.yaml': 'color: red\n',
      'profiles/solo.yaml': 'contents:\n  - widgets/gear\n',
    });
    expect(
      await world.run(() => world.items.remove(invoke(['gear'], { yes: true, 'remove-from-profiles': true }))),
    ).toBe(1);
    expect(world.complain()).toBe(
      'Removing widget gear would leave profile solo with no layers; add another layer to it first.\n',
    );
    expect(world.daemon.files.has('widgets/gear.yaml')).toBe(true);
  });

  it('says what waits for the owner when the daemon holds a write, and the located issues when it refuses one', async () => {
    const held = harness();
    held.daemon.holdWrites(['raises the limit']);
    expect(await held.run(() => held.items.add(invoke(['gear'], { color: 'red' })))).toBe(0);
    expect(held.say()).toContain('Saved, but waiting for the owner');
    expect(held.say()).toContain('  raises the limit');

    const bad = harness();
    expect(await bad.run(() => bad.items.add(invoke(['gear'], { color: 'INVALID' })))).toBe(1);
    expect(bad.complain()).toBe(
      'the file does not check (1 problem); nothing was written\n  widgets/gear.yaml:2 — is not allowed (remove it)\n',
    );
  });

  it('turns a kind’s own refusal into one plain sentence and exit 1', async () => {
    const world = harness();
    const code = await itemVerb(
      { io: { out: () => {}, err: text => world.err.push(text), isTty: false } },
      async () => {
        throw new ItemCommandError('A widget needs a colour.');
      },
    );
    expect(code).toBe(1);
    expect(world.complain()).toBe('A widget needs a colour.\n');
  });
});
