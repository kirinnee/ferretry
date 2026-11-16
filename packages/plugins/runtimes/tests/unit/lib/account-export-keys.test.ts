/**
 * Origin keys: minted once, remembered, kept through a rename, never taken from a file that cannot be read.
 */
import { describe, it } from 'bun:test';
import {
  CLONE_SKILLS_DIRECTORY,
  type CloneBundle,
  CloneBundleSchema,
  ORIGIN_KEY_PATTERN,
} from '../../../contract/index.ts';
import { cloneItemDigest } from '../../../daemon/lib/clone-digest.ts';
import should from 'should';
import { SKILLS_STORE_DIRECTORY } from '../../../daemon/lib/account/adapt.ts';
import {
  assignOriginKeys,
  base32,
  EMPTY_EXPORT_KEYS,
  type ExportKeys,
  originKeyOfId,
  parseExportKeys,
  serializeExportKeys,
} from '../../../daemon/lib/account/export-keys.ts';

const bundle = (patch: Record<string, unknown> = {}): CloneBundle =>
  CloneBundleSchema.parse({
    format: 'ferretry-clone',
    version: 1,
    machine: 'studio',
    daemon: 'daemon-source',
    keys: {},
    exportedAt: '2026-10-13T09:00:00Z',
    credentials: [{ id: 'claude-you', harness: 'claude-code', label: 'you' }],
    components: {
      instructions: { main: { file: 'components/instructions/main.md' } },
      skills: { mine: { items: ['review'] } },
    },
    profiles: { default: { layers: ['instructions/main', 'skills/mine'] } },
    runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } },
    files: [
      { path: 'components/instructions/main.md', content: 'Main.\n' },
      { path: 'skills/review/SKILL.md', content: 'review\n' },
    ],
    notCopied: [],
    ...patch,
  });

const RUNTIME_ID = '12345678-1234-4234-8234-123456789abc';

/** Distinct bytes per draw across the whole file, so two minted keys never collide in a test. */
let drawn = 0;
const randomBytes = (length: number): Uint8Array => {
  drawn += 1;
  return Uint8Array.from({ length }, (_, index) => (drawn * 37 + index * 11) % 256);
};

const run = (input: Partial<Parameters<typeof assignOriginKeys>[0]> & { bundle: CloneBundle }) =>
  assignOriginKeys({
    previous: EMPTY_EXPORT_KEYS,
    runtimeIds: { 'claude-default': RUNTIME_ID },
    randomBytes,
    ...input,
  });

/** `bundle()` with `instructions/main` renamed, its document moved, its profile following. */
const renamed = (to: string, content = 'Main.\n'): CloneBundle =>
  bundle({
    components: {
      instructions: { [to]: { file: `components/instructions/${to}.md` } },
      skills: { mine: { items: ['review'] } },
    },
    profiles: { default: { layers: [`instructions/${to}`, 'skills/mine'] } },
    files: [
      { path: `components/instructions/${to}.md`, content },
      { path: 'skills/review/SKILL.md', content: 'review\n' },
    ],
  });

describe('base32 and originKeyOfId', () => {
  it('should write 16 bytes as 26 lower-case base32 characters', () => {
    should(base32(new Uint8Array(16))).equal('a'.repeat(26));
    should(base32(new Uint8Array(16).fill(255))).match(ORIGIN_KEY_PATTERN);
    should(base32(Uint8Array.from([0xff]))).equal('74');
  });

  it('should write a runtime id as the key of the same 16 bytes, and refuse what is not an id', () => {
    should(originKeyOfId(RUNTIME_ID)).match(ORIGIN_KEY_PATTERN);
    should(originKeyOfId(RUNTIME_ID)).equal(originKeyOfId(RUNTIME_ID.toUpperCase()));
    should(originKeyOfId('not-an-id')).be.undefined();
    should(originKeyOfId('')).be.undefined();
  });
});

describe('parseExportKeys', () => {
  const stored: ExportKeys = {
    version: 1,
    items: { 'instructions/main': { key: 'abcdefghijklmnopqrstuvwxyz', digest: 'a'.repeat(64) } },
  };

  it('should read what serializeExportKeys wrote, byte for byte on a second write', () => {
    const text = serializeExportKeys(stored);
    should(parseExportKeys(text)).deepEqual(stored);
    should(serializeExportKeys(parseExportKeys(text))).equal(text);
  });

  it('should read nothing from a file that is absent, damaged, of another version or carrying a bad key', () => {
    for (const text of [
      undefined,
      '',
      'not json',
      '[]',
      '{"version":2,"items":{}}',
      '{"version":1}',
      '{"version":1,"items":{"a/b":{"key":"short","digest":"x"}}}',
      JSON.stringify({ ...stored, extra: true }),
    ]) {
      should(parseExportKeys(text)).deepEqual(EMPTY_EXPORT_KEYS);
    }
  });
});

describe('assignOriginKeys', () => {
  it('should key every item of the bundle, runtimes by their id', () => {
    const { keys, stored } = run({ bundle: bundle() });
    should(Object.keys(keys).toSorted()).deepEqual([
      'instructions/main',
      'login/claude-you',
      'profile/default',
      'runtime/claude-default',
      'skills/mine',
    ]);
    for (const key of Object.values(keys)) should(key).match(ORIGIN_KEY_PATTERN);
    should(new Set(Object.values(keys)).size).equal(5);
    should(keys['runtime/claude-default']).equal(originKeyOfId(RUNTIME_ID));
    should(Object.keys(stored.items).toSorted()).deepEqual([
      'instructions/main',
      'login/claude-you',
      'profile/default',
      'skills/mine',
    ]);
  });

  it('should remember the digest each item held, as the target will take it', () => {
    const { stored } = run({ bundle: bundle() });
    const main = bundle().components.instructions?.main as Record<string, unknown>;
    should(stored.items['instructions/main']?.digest).equal(
      cloneItemDigest({ kind: 'instructions', value: main }, bundle().files),
    );
  });

  it('should keep every key on the next run, and refresh the digest of an edited item', () => {
    const first = run({ bundle: bundle() });
    const second = run({ bundle: renamed('main', 'Main, edited.\n'), previous: first.stored });
    should(second.keys).deepEqual(first.keys);
    should(second.stored.items['instructions/main']?.digest).not.equal(first.stored.items['instructions/main']?.digest);
    should(second.stored.items['instructions/main']?.key).equal(first.stored.items['instructions/main']?.key);
  });

  it('should keep a key through a pure rename, and the profile that names it', () => {
    const first = run({ bundle: bundle() });
    const second = run({ bundle: renamed('primary'), previous: first.stored });
    should(second.keys['instructions/primary']).equal(first.keys['instructions/main']);
    should(second.keys['profile/default']).equal(first.keys['profile/default']);
    should(second.stored.items['profile/default']?.digest).equal(first.stored.items['profile/default']?.digest);
  });

  it('should give a renamed AND edited item a new key', () => {
    const first = run({ bundle: bundle() });
    const second = run({ bundle: renamed('primary', 'Something else.\n'), previous: first.stored });
    should(second.keys['instructions/primary']).not.equal(first.keys['instructions/main']);
    should(Object.values(second.keys)).not.containEql(first.keys['instructions/main']);
  });

  it('should drop the entries of items that are gone', () => {
    const first = run({ bundle: bundle() });
    const second = run({ bundle: renamed('primary', 'Else.\n'), previous: first.stored });
    should(Object.keys(second.stored.items)).not.containEql('instructions/main');
  });

  it('should not let one vanished item be inherited twice', () => {
    const twin = (names: readonly string[]): CloneBundle =>
      bundle({
        components: {
          instructions: Object.fromEntries(names.map(name => [name, { file: `components/instructions/${name}.md` }])),
        },
        profiles: {},
        runtimes: {},
        credentials: [],
        files: names.map(name => ({ path: `components/instructions/${name}.md`, content: 'Same.\n' })),
      });
    const first = run({ bundle: twin(['one']) });
    const second = run({ bundle: twin(['two', 'three']), previous: first.stored });
    const keys = [second.keys['instructions/two'], second.keys['instructions/three']];
    should(keys).containEql(first.keys['instructions/one']);
    should(new Set(keys).size).equal(2);
  });

  it('should not inherit across kinds', () => {
    const asMcp = (name: string): CloneBundle =>
      bundle({
        components: { mcp: { [name]: { command: 'npx' } } },
        profiles: {},
        runtimes: {},
        credentials: [],
        files: [],
      });
    const asSkills = bundle({
      components: { hooks: { guard: { harness: 'claude', flags: [] } } },
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [],
    });
    const first = run({ bundle: asMcp('a') });
    const second = run({ bundle: asSkills, previous: first.stored });
    should(second.keys['hooks/guard']).not.equal(first.keys['mcp/a']);
  });

  it('should mint again for everything when the stored keys were unreadable', () => {
    const first = run({ bundle: bundle() });
    const again = run({ bundle: bundle(), previous: parseExportKeys('not json') });
    should(again.keys['instructions/main']).match(ORIGIN_KEY_PATTERN);
    should(again.keys['runtime/claude-default']).equal(first.keys['runtime/claude-default']);
  });

  it('should key a profile that names itself without looping', () => {
    const looped = bundle({
      profiles: { a: { layers: ['profile/b'] }, b: { layers: ['profile/a'] } },
      runtimes: {},
    });
    const { keys } = run({ bundle: looped });
    should(keys['profile/a']).match(ORIGIN_KEY_PATTERN);
    should(keys['profile/b']).match(ORIGIN_KEY_PATTERN);
    should(keys['profile/a']).not.equal(keys['profile/b']);
  });

  it('should give a runtime with no id a key that is not remembered', () => {
    const { keys, stored } = run({ bundle: bundle(), runtimeIds: {} });
    should(keys['runtime/claude-default']).match(ORIGIN_KEY_PATTERN);
    should(Object.keys(stored.items)).not.containEql('runtime/claude-default');
  });
});

describe('the skills directory', () => {
  it('should be the one place the protocol digest and the fleet store agree skill items live', () => {
    should(CLONE_SKILLS_DIRECTORY).equal(SKILLS_STORE_DIRECTORY);
  });
});
