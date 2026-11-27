/**
 * The first-run scan over the kernel's REAL roots (a mkdtemp fixture standing in for a person's home; the harness-home
 * root and the one `harnessFile` beside it): documents and skills are read through the root handles, a link or a sign-in
 * file is refused, and a path no mount names is never opened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import { claudeRuntimesKit } from '../../../../claude-code/daemon/lib/runtimes-kit/index.ts';
import { codexRuntimesKit } from '../../../../codex/daemon/lib/runtimes-kit/index.ts';
import type { RootsPort } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { harnessMounts, rootHostFiles } from '../../../daemon/adapters/root-host-files.ts';
import { HostHarnessScanner } from '../../../daemon/adapters/host-harness-scan.ts';

const IMPORT_KITS = new Map([
  ['claude', claudeRuntimesKit],
  ['codex', codexRuntimesKit],
] as const);

const INERT = 'INERT_SIGN_IN_FIXTURE';
let parent: string;
let user: string;

beforeEach(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'fy-scan-roots-')));
  user = join(parent, 'user');
  await mkdir(join(parent, 'fy-home'), { recursive: true });
  await mkdir(join(user, '.claude/skills/helper'), { recursive: true });
  await mkdir(join(user, '.codex'), { recursive: true });
  await writeFile(join(user, '.claude/CLAUDE.md'), '# Rules\n');
  await writeFile(join(user, '.claude/settings.json'), '{"model":"x"}');
  await writeFile(join(user, '.claude/skills/helper/SKILL.md'), 'helps');
  await writeFile(join(user, '.claude.json'), '{"mcpServers":{}}');
  await writeFile(join(user, '.codex/auth.json'), INERT);
  await writeFile(join(user, '.codex/config.toml'), 'model = "gpt"\n');
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

const roots = (): RootsPort =>
  rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: join(parent, 'fy-home'), plugin: 'runtimes', worktrees: join(parent, 'worktrees') },
    ['harness-home'],
    () => undefined,
    { harnessFiles: ['.claude.json'] },
  );

const scanner = (port: RootsPort = roots()) =>
  new HostHarnessScanner({
    kits: () => IMPORT_KITS,
    files: rootHostFiles(
      harnessMounts(port, [join(user, '.claude'), join(user, '.codex')], join(user, '.claude.json')),
    ),
    userHome: user,
    commands: { resolve: () => undefined },
    logins: fakeLogins([]),
    maxDocumentBytes: 4096,
  });

describe('HostHarnessScanner over the kernel roots', () => {
  it('reads the documents, the file beside the home, and a skill with a content digest', async () => {
    const [claude, codex] = await scanner().scan();

    expect(claude?.instructions).toMatchObject({ kind: 'text', text: '# Rules\n' });
    expect(claude?.settings).toMatchObject({ kind: 'text', text: '{"model":"x"}' });
    expect(claude?.mcp).toMatchObject({ kind: 'text', text: '{"mcpServers":{}}' });
    expect(claude?.skills.map(skill => skill.item)).toEqual(['helper']);
    expect(codex?.settings).toMatchObject({ kind: 'text', text: 'model = "gpt"\n' });
  });

  it('changes a skill’s digest when any byte of it changes', async () => {
    const before = (await scanner().scan())[0]?.skills[0]?.digest;
    await writeFile(join(user, '.claude/skills/helper/SKILL.md'), 'helps!');

    const after = (await scanner().scan())[0]?.skills[0]?.digest;

    expect(before).toBeString();
    expect(after).not.toBe(before);
  });

  it('S144 never returns or opens a sign-in file, even one named inside a skill folder', async () => {
    await writeFile(join(user, '.claude/skills/helper/auth.json'), INERT);

    const scans = await scanner().scan();

    expect(JSON.stringify(scans)).not.toContain(INERT);
    // The digest cannot have covered the sign-in file's bytes: changing them leaves the digest unchanged.
    const withFile = scans[0]?.skills[0]?.digest;
    await writeFile(join(user, '.claude/skills/helper/auth.json'), `${INERT}-changed`);
    expect((await scanner().scan())[0]?.skills[0]?.digest).toBe(withFile);
  });

  it('refuses a document that is a link, never following it to the file it names', async () => {
    await rm(join(user, '.claude/CLAUDE.md'));
    await symlink(join(user, '.codex/auth.json'), join(user, '.claude/CLAUDE.md'));

    const claude = (await scanner().scan())[0];

    expect(claude?.instructions).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('links') });
    expect(JSON.stringify(claude)).not.toContain(INERT);
  });

  it('serves the one declared file beside the home as bytes and as an entry, and a stat as a file', async () => {
    const files = rootHostFiles(harnessMounts(roots(), [join(user, '.claude')], join(user, '.claude.json')));
    const text = '{"mcpServers":{}}';

    expect(new TextDecoder().decode(await files.readBytes(join(user, '.claude.json')))).toBe(text);
    expect(await files.stat(join(user, '.claude.json'))).toEqual({ kind: 'file', size: text.length });
    expect(await files.lstat(join(user, '.claude.json'))).toEqual({ kind: 'file', size: text.length });
    // A document inside a home is a stat of the root it is in.
    expect(await files.stat(join(user, '.claude/CLAUDE.md'))).toEqual({ kind: 'file', size: '# Rules\n'.length });
    // A link inside a home is reported as a link, never followed.
    await symlink(join(user, '.claude/CLAUDE.md'), join(user, '.claude/linked.md'));
    expect(await files.lstat(join(user, '.claude/linked.md'))).toMatchObject({ kind: 'link' });
  });

  it('serves nothing outside its mounts', async () => {
    const files = rootHostFiles(harnessMounts(roots(), [join(user, '.claude')], join(user, '.claude.json')));

    await expect(files.readText(join(user, '.codex/config.toml'))).rejects.toThrow('outside the folders');
    await expect(files.readText('/etc/hostname')).rejects.toThrow('outside the folders');
    await expect(files.list(join(user, '.claude.json'))).rejects.toThrow('not listable');
    // A sibling of the declared file is not served, whatever its name.
    await expect(files.readText(join(user, '.other.json'))).rejects.toThrow('outside the folders');
  });
});

describe('O8-4 HostHarnessScanner hashes a deep skill in a bounded number of looks', () => {
  const FILES = 24;
  const deepSkill = async (): Promise<string> => {
    const skill = join(user, '.claude/skills/deep');
    for (let index = 0; index < FILES; index += 1) {
      const folder = join(skill, 'a/b/c/d/e', `f${String(index % 4)}`);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, `file-${String(index)}.md`), `content ${String(index)}`);
    }
    return skill;
  };
  /** The kernel-backed files with every call inside `under` counted by name. */
  const counted = (under: string) => {
    const files = rootHostFiles(
      harnessMounts(roots(), [join(user, '.claude'), join(user, '.codex')], join(user, '.claude.json')),
    );
    const calls: Record<string, number> = {};
    const count =
      <A extends unknown[], R>(name: string, call: (path: string, ...rest: A) => Promise<R>) =>
      async (path: string, ...rest: A): Promise<R> => {
        if (path.startsWith(under)) calls[name] = (calls[name] ?? 0) + 1;
        return await call(path, ...rest);
      };
    const entries = files.entries;
    return {
      calls,
      scanner: new HostHarnessScanner({
        kits: () => IMPORT_KITS,
        files: {
          readText: count('readText', files.readText),
          readBytes: count('readBytes', files.readBytes),
          stat: count('stat', files.stat),
          lstat: count('lstat', files.lstat),
          list: count('list', files.list),
          ...(entries === undefined ? {} : { entries: count('entries', entries) }),
        },
        userHome: user,
        commands: { resolve: () => undefined },
        logins: fakeLogins([]),
        maxDocumentBytes: 4096,
      }),
    };
  };

  it('looks at each folder once and each file twice (a look, then the read) — never every ancestor of every file', async () => {
    const skill = await deepSkill();
    const { scanner: subject, calls } = counted(skill);

    const deep = (await subject.scan())[0]?.skills.find(found => found.item === 'deep');

    expect(deep?.digest).toBeString();
    // 1 + 5 + 4 folders: one listing each. The old walk re-checked every ancestor of every file, twice (~16 looks a file here).
    expect(calls.entries).toBe(10);
    expect(calls.readBytes).toBe(FILES);
    // One look per file before its read, plus the skill folder's own guard walk (its home-relative components).
    expect(calls.lstat ?? 0).toBeLessThanOrEqual(FILES + 3);
  });

  it('answers an unchanged skill from the digest it holds without reading a byte, and reads again once a file changes', async () => {
    const skill = await deepSkill();
    const { scanner: subject, calls } = counted(skill);
    const digestOf = async () => (await subject.scan())[0]?.skills.find(found => found.item === 'deep')?.digest;

    const first = await digestOf();
    const readsAfterFirst = calls.readBytes;
    const second = await digestOf();

    expect(second).toBe(first);
    expect(calls.readBytes).toBe(readsAfterFirst);

    await writeFile(join(skill, 'a/b/c/d/e/f0/file-0.md'), 'content 0, longer now');
    const third = await digestOf();

    expect(third).not.toBe(first);
    expect(calls.readBytes).toBe((readsAfterFirst ?? 0) + FILES);
  });

  it('gives the same digest as hashing one file at a time: each relative path and its bytes, in sorted order', async () => {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update('SKILL.md\0helps\0');

    const helper = (await scanner().scan())[0]?.skills.find(found => found.item === 'helper');

    expect(helper?.digest).toBe(hasher.digest('hex'));
  });
});
