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
import type { RootsPort } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { harnessMounts, rootHostFiles } from '../../../daemon/adapters/root-host-files.ts';
import { HostHarnessScanner } from '../../../daemon/adapters/host-harness-scan.ts';

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

  it('serves nothing outside its mounts', async () => {
    const files = rootHostFiles(harnessMounts(roots(), [join(user, '.claude')], join(user, '.claude.json')));

    await expect(files.readText(join(user, '.codex/config.toml'))).rejects.toThrow('outside the folders');
    await expect(files.readText('/etc/hostname')).rejects.toThrow('outside the folders');
    await expect(files.list(join(user, '.claude.json'))).rejects.toThrow('not listable');
    // A sibling of the declared file is not served, whatever its name.
    await expect(files.readText(join(user, '.other.json'))).rejects.toThrow('outside the folders');
  });
});
