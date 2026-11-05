/**
 * The content digest of one copied item: what it ignores (provenance, a folder's name, an item's own name)
 * and what it cannot ignore (anything that could make the target run something else).
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLONE_PROVENANCE_FIELDS,
  type CloneDigestItem,
  type CloneIdentityOf,
  cloneItemDigest,
} from '../../src/lib/fleet-clone-digest.ts';
import type { FleetCloneFile } from '../../src/lib/fleet-setup.ts';

const NONE: readonly FleetCloneFile[] = [];

const file = (path: string, content: string): FleetCloneFile => ({ path, content });

const skills = (value: Record<string, unknown>): CloneDigestItem => ({ kind: 'skills', value });
const mcp = (value: Record<string, unknown>): CloneDigestItem => ({ kind: 'mcp', value });

describe('cloneItemDigest', () => {
  it('should be 64 lower-case hex digits, and the same for the same item', () => {
    const item = mcp({ command: 'npx', args: ['-y', 'server'] });
    should(cloneItemDigest(item, NONE)).match(/^[0-9a-f]{64}$/u);
    should(cloneItemDigest(item, NONE)).equal(cloneItemDigest({ ...item }, NONE));
  });

  it('should not depend on the order a document spells its keys in', () => {
    should(cloneItemDigest(mcp({ command: 'npx', args: ['a'] }), NONE)).equal(
      cloneItemDigest(mcp({ args: ['a'], command: 'npx' }), NONE),
    );
  });

  it('should ignore every provenance field', () => {
    const plain = mcp({ command: 'npx' });
    const stamped = mcp({
      command: 'npx',
      clonedFrom: 'studio',
      clonedFromDaemon: 'daemon-1',
      clonedFromKey: 'abcdefghijklmnopqrstuvwxyz',
      installedFrom: { publisher: 'p', itemId: 'i' },
    });
    should([...CLONE_PROVENANCE_FIELDS].toSorted()).deepEqual([
      'clonedFrom',
      'clonedFromDaemon',
      'clonedFromKey',
      'installedFrom',
    ]);
    should(cloneItemDigest(stamped, NONE)).equal(cloneItemDigest(plain, NONE));
  });

  it('should change on any runnable field of a component', () => {
    const base = { command: 'npx', args: ['-y', 'server'], env: { MODE: 'a' }, enabled: true };
    const digest = cloneItemDigest(mcp(base), NONE);
    const changed: Record<string, unknown>[] = [
      { ...base, command: 'bunx' },
      { ...base, args: ['-y', 'server', '--flag'] },
      { ...base, args: ['server', '-y'] },
      { ...base, env: { MODE: 'b' } },
      { ...base, env: { MODE: 'a', EXTRA: '1' } },
      { ...base, enabled: false },
      { ...base, extra: 1 },
    ];
    for (const value of changed) should(cloneItemDigest(mcp(value), NONE)).not.equal(digest);
  });

  it('should tell kinds apart', () => {
    const value = { items: [] };
    should(cloneItemDigest({ kind: 'skills', value }, NONE)).not.equal(cloneItemDigest({ kind: 'hooks', value }, NONE));
  });

  describe('documents', () => {
    const instructions = (path: string): CloneDigestItem => ({ kind: 'instructions', value: { file: path } });

    it('should read a file by what it holds, so a moved or renamed document compares equal', () => {
      should(
        cloneItemDigest(instructions('components/instructions/main.md'), [
          file('components/instructions/main.md', 'Hi.\n'),
        ]),
      ).equal(
        cloneItemDigest(instructions('components/instructions/main-2.md'), [
          file('components/instructions/main-2.md', 'Hi.\n'),
        ]),
      );
    });

    it('should change on a single changed byte', () => {
      const path = 'components/instructions/main.md';
      should(cloneItemDigest(instructions(path), [file(path, 'Hi.\n')])).not.equal(
        cloneItemDigest(instructions(path), [file(path, 'Hi!\n')]),
      );
    });

    it('should tell a document the bundle did not carry from an empty one', () => {
      const path = 'components/instructions/main.md';
      should(cloneItemDigest(instructions(path), NONE)).not.equal(
        cloneItemDigest(instructions(path), [file(path, '')]),
      );
    });

    it('should keep the path of a file the bundle did not carry, so a re-pointed script is a change', () => {
      should(cloneItemDigest(instructions('/usr/local/bin/guard.sh'), NONE)).not.equal(
        cloneItemDigest(instructions('/usr/local/bin/evil.sh'), NONE),
      );
      should(cloneItemDigest(instructions('~/scripts/a.sh'), NONE)).not.equal(
        cloneItemDigest(instructions('~/scripts/b.sh'), NONE),
      );
      should(cloneItemDigest(instructions('/usr/local/bin/guard.sh'), NONE)).equal(
        cloneItemDigest(instructions('/usr/local/bin/guard.sh'), NONE),
      );
    });

    it('should not read an absolute path as the asset-relative file that spells the same', () => {
      const store = [file('usr/local/bin/guard.sh', 'echo hi')];
      should(cloneItemDigest(instructions('/usr/local/bin/guard.sh'), store)).not.equal(
        cloneItemDigest(instructions('usr/local/bin/guard.sh'), store),
      );
    });

    it('should keep the path of a folder the bundle did not carry', () => {
      const hooks = (directory: string): CloneDigestItem => ({ kind: 'hooks', value: { directory } });
      should(cloneItemDigest(hooks('/opt/a'), NONE)).not.equal(cloneItemDigest(hooks('/opt/b'), NONE));
      should(cloneItemDigest(hooks('hooks/guard'), NONE)).not.equal(cloneItemDigest(hooks('hooks/other'), NONE));
      should(cloneItemDigest(hooks('/opt/a'), NONE)).equal(cloneItemDigest(hooks('/opt/a'), NONE));
    });

    it('should read a directory as its sorted relative paths and hashes, whatever the folder is called', () => {
      const hooks = (directory: string): CloneDigestItem => ({ kind: 'hooks', value: { directory } });
      const files = (root: string, order: readonly string[]): FleetCloneFile[] =>
        order.map(name => file(`${root}/${name}`, `content of ${name}`));
      const first = cloneItemDigest(hooks('hooks/guard'), files('hooks/guard', ['b.sh', 'sub/a.sh', 'a.sh']));
      should(cloneItemDigest(hooks('hooks/guard-2'), files('hooks/guard-2', ['a.sh', 'b.sh', 'sub/a.sh']))).equal(
        first,
      );
      should(cloneItemDigest(hooks('hooks/guard'), files('hooks/guard', ['a.sh', 'b.sh']))).not.equal(first);
      should(
        cloneItemDigest(hooks('hooks/guard'), [
          ...files('hooks/guard', ['a.sh', 'sub/a.sh']),
          file('hooks/guard/b.sh', 'tampered'),
        ]),
      ).not.equal(first);
      should(
        cloneItemDigest(hooks('hooks/guard'), [
          ...files('hooks/guard', ['b.sh', 'sub/a.sh']),
          file('hooks/guard/renamed.sh', 'content of a.sh'),
        ]),
      ).not.equal(first);
    });

    it('should not read a sibling folder that merely shares a name prefix', () => {
      const hooks: CloneDigestItem = { kind: 'hooks', value: { directory: 'hooks/guard' } };
      should(cloneItemDigest(hooks, [file('hooks/guard/a.sh', 'x')])).equal(
        cloneItemDigest(hooks, [file('hooks/guard/a.sh', 'x'), file('hooks/guard-2/a.sh', 'other')]),
      );
    });

    it('should read the same path spelled two ways as one', () => {
      should(cloneItemDigest(instructions('./components/main.md'), [file('components/main.md', 'x')])).equal(
        cloneItemDigest(instructions('components/main.md'), [file('./components//main.md', 'x')]),
      );
    });

    it('should hash each skill item by its files, whatever its component is called', () => {
      const store = [file('skills/review/SKILL.md', 'one'), file('skills/review/run.sh', 'two')];
      const digest = cloneItemDigest(skills({ items: ['review'] }), store);
      should(cloneItemDigest(skills({ items: ['review'], clonedFrom: 'studio' }), store)).equal(digest);
      should(cloneItemDigest(skills({ items: ['review'] }), [store[0] as FleetCloneFile])).not.equal(digest);
      should(
        cloneItemDigest(skills({ items: ['review'] }), [
          store[0] as FleetCloneFile,
          file('skills/review/run.sh', 'three'),
        ]),
      ).not.equal(digest);
      should(cloneItemDigest(skills({ items: ['review', 'other'] }), store)).not.equal(digest);
    });
  });

  describe('profiles and runtimes', () => {
    const keys: Record<string, string> = {
      'instructions/main': 'key-main',
      'instructions/renamed': 'key-main',
      'skills/mine': 'key-skills',
      'profile/default': 'key-profile',
      'profile/renamed': 'key-profile',
      'login/one': 'key-login',
      'login/two': 'key-login-two',
    };
    const identityOf: CloneIdentityOf = reference => keys[reference] ?? reference;
    const profile = (layers: readonly string[]): CloneDigestItem => ({ kind: 'profile', value: { layers } });
    const runtime = (value: Record<string, unknown>): CloneDigestItem => ({
      kind: 'runtime',
      value: { credential: 'one', profile: 'default', agent: true, ...value },
    });

    it('should hold a profile as the identities of its layers, so renaming one is no change', () => {
      should(cloneItemDigest(profile(['instructions/renamed', 'skills/mine']), NONE, identityOf)).equal(
        cloneItemDigest(profile(['instructions/main', 'skills/mine']), NONE, identityOf),
      );
    });

    it('should change when a layer is swapped, added, dropped or reordered', () => {
      const digest = cloneItemDigest(profile(['instructions/main', 'skills/mine']), NONE, identityOf);
      for (const layers of [
        ['skills/mine', 'instructions/main'],
        ['instructions/main'],
        ['instructions/main', 'skills/mine', 'modelSets/claude'],
        ['instructions/main', 'skills/other'],
      ]) {
        should(cloneItemDigest(profile(layers), NONE, identityOf)).not.equal(digest);
      }
    });

    it('should name a layer with no key by its reference', () => {
      should(cloneItemDigest(profile(['mcp/a']), NONE)).not.equal(cloneItemDigest(profile(['mcp/b']), NONE));
    });

    it('should hold a runtime as its login, profile, agent and harness — and nothing else', () => {
      const digest = cloneItemDigest(runtime({ harness: 'claude' }), NONE, identityOf);
      should(cloneItemDigest(runtime({ harness: 'claude', clonedFrom: 'studio' }), NONE, identityOf)).equal(digest);
      should(cloneItemDigest(runtime({ harness: 'claude', profile: 'renamed' }), NONE, identityOf)).equal(digest);
      should(cloneItemDigest(runtime({ harness: 'codex' }), NONE, identityOf)).not.equal(digest);
      should(cloneItemDigest(runtime({ harness: 'claude', agent: false }), NONE, identityOf)).not.equal(digest);
      should(cloneItemDigest(runtime({ harness: 'claude', credential: 'two' }), NONE, identityOf)).not.equal(digest);
      should(cloneItemDigest(runtime({ harness: 'claude', profile: 'other' }), NONE, identityOf)).not.equal(digest);
      should(cloneItemDigest(runtime({}), NONE, identityOf)).not.equal(digest);
    });

    it('should hold where a runtime or profile compacts, but not whether a runtime is switched off here', () => {
      const digest = cloneItemDigest(runtime({ harness: 'claude' }), NONE, identityOf);
      should(cloneItemDigest(runtime({ harness: 'claude', compactAt: 250000 }), NONE, identityOf)).not.equal(digest);
      should(cloneItemDigest(runtime({ harness: 'claude', compactAt: 'auto' }), NONE, identityOf)).not.equal(digest);
      should(cloneItemDigest(runtime({ harness: 'claude', compactAt: undefined }), NONE, identityOf)).equal(digest);
      should(
        cloneItemDigest(runtime({ harness: 'claude', disabled: { reason: 'spend limit' } }), NONE, identityOf),
      ).equal(digest);
      const layered: CloneDigestItem = { kind: 'profile', value: { layers: ['mcp/a'], compactAt: 200000 } };
      should(cloneItemDigest(layered, NONE)).not.equal(cloneItemDigest(profile(['mcp/a']), NONE));
    });

    it('should hold a login as what it signs in with, not the id this machine files it under', () => {
      const login = (value: Record<string, unknown>): CloneDigestItem => ({ kind: 'login', value });
      const base = { id: 'one', harness: 'claude', label: 'work', store: 'environment', env: { A: '1' } };
      const digest = cloneItemDigest(login(base), NONE);
      should(cloneItemDigest(login({ ...base, id: 'two' }), NONE)).equal(digest);
      should(cloneItemDigest(login({ ...base, env: { A: '2' } }), NONE)).not.equal(digest);
      should(cloneItemDigest(login({ ...base, harness: 'codex' }), NONE)).not.equal(digest);
      should(cloneItemDigest(login({ ...base, cloudCredential: 'aws:prod' }), NONE)).not.equal(digest);
    });
  });

  it('should digest an item the canonical writer refuses, apart from one it accepts', () => {
    const lone = mcp({ command: '\ud800' });
    should(cloneItemDigest(lone, NONE)).match(/^[0-9a-f]{64}$/u);
    should(cloneItemDigest(lone, NONE)).not.equal(cloneItemDigest(mcp({ command: '\ud801' }), NONE));
  });
});
