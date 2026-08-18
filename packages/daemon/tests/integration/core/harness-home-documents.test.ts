import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { harnessHomeLayouts, NodeHarnessHomeDocuments } from '../../../src/adapters/core/index.ts';
import { readHarnessDiscovery } from '../../../src/lib/fleet/harness-discovery.ts';

/**
 * The read that leaves the state home, against a real filesystem.
 *
 * This is the half no unit test can prove: whether a bound applied before the bytes are taken actually
 * holds, what a directory named `CLAUDE.md` does, and whether the two real harness layouts point where
 * the harnesses keep their files. Every path here is inside a temporary directory — no test ever reads
 * a developer's own home, which is exactly why the layout is a value rather than a constant.
 */

const temporaryDirectories: string[] = [];

async function harnessHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'fy-harness-home-'));
  temporaryDirectories.push(home);
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  return home;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('the harness home document reader', () => {
  it('should name the settings and instructions document each harness actually reads', async () => {
    // Arrange — the layout is the only place the real homes are spelled, so this is the test that pins
    // them. A wrong path here is a discovery that silently finds nothing on every host.
    const home = '/home/pilot';

    // Act
    const layouts = harnessHomeLayouts(home);

    // Assert
    should(layouts).deepEqual([
      {
        kind: 'claude',
        settingsPath: '/home/pilot/.claude/settings.json',
        settingsFormat: 'json',
        instructionsPath: '/home/pilot/.claude/CLAUDE.md',
        instructionsName: 'CLAUDE.md',
      },
      {
        kind: 'codex',
        settingsPath: '/home/pilot/.codex/config.toml',
        settingsFormat: 'toml',
        instructionsPath: '/home/pilot/.codex/AGENTS.md',
        instructionsName: 'AGENTS.md',
      },
    ]);
  });

  it('should read a document that is there and report the byte length of the text it hands back', async () => {
    // Arrange
    const home = await harnessHome();
    const body = '# Rules\n\nBe précise.\n';
    await writeFile(join(home, '.claude', 'CLAUDE.md'), body, 'utf8');

    // Act
    const read = await new NodeHarnessHomeDocuments().read(join(home, '.claude', 'CLAUDE.md'), 64 * 1024);

    // Assert — the byte count is of the TEXT, so a multi-byte character is counted the way the asset
    // ceiling counts it rather than as one character per byte.
    should(read).deepEqual({ kind: 'text', text: body, bytes: Buffer.byteLength(body, 'utf8') });
  });

  it('should report an absent document as absent rather than as a failure', async () => {
    // Arrange — the ordinary case on a host that has never written one, and the one a form must not
    // present as something being wrong.
    const home = await harnessHome();

    // Act
    const read = await new NodeHarnessHomeDocuments().read(join(home, '.codex', 'AGENTS.md'), 1_024);

    // Assert
    should(read).deepEqual({ kind: 'absent' });
  });

  it('should refuse a document larger than the bound WITHOUT reading it', async () => {
    // Arrange — 40 bytes against a 16-byte ceiling. The bound is checked from the file's size, so the
    // bytes are never allocated; a ceiling applied after the read is not a ceiling.
    const home = await harnessHome();
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(40), 'utf8');

    // Act
    const read = await new NodeHarnessHomeDocuments().read(join(home, '.claude', 'CLAUDE.md'), 16);

    // Assert
    should(read).deepEqual({ kind: 'too-large', bytes: 40 });
  });

  it('should call a path that is not a regular file unreadable rather than absent', async () => {
    // Arrange — a DIRECTORY named CLAUDE.md. Reporting "not found" would send somebody looking for a
    // file that is sitting right there.
    const home = await harnessHome();
    await mkdir(join(home, '.claude', 'CLAUDE.md'));

    // Act
    const read = await new NodeHarnessHomeDocuments().read(join(home, '.claude', 'CLAUDE.md'), 1_024);

    // Assert
    should(read).deepEqual({ kind: 'unreadable', reason: 'that path is not a regular file' });
  });

  it('should follow a symlinked document, because a harness home is not Ferretry state', async () => {
    // Arrange — keeping `~/.claude/CLAUDE.md` as a link into a dotfiles repository is completely
    // ordinary. The state home bans links for a reason that does not apply here: nothing is written,
    // and the caller already governs this file.
    const home = await harnessHome();
    const real = join(home, 'dotfiles-instructions.md');
    await writeFile(real, '# Linked\n', 'utf8');
    await symlink(real, join(home, '.claude', 'CLAUDE.md'));

    // Act
    const read = await new NodeHarnessHomeDocuments().read(join(home, '.claude', 'CLAUDE.md'), 1_024);

    // Assert
    should(read).deepEqual({ kind: 'text', text: '# Linked\n', bytes: 9 });
  });

  it('should report a document it may not open as unreadable, carrying the reason', async () => {
    // Arrange — mode 0 on the file itself. Skipped when the test happens to run as root, for whom no
    // mode denies anything: a test that passed only because everything is permitted proves nothing.
    const home = await harnessHome();
    const path = join(home, '.claude', 'settings.json');
    await writeFile(path, '{}', 'utf8');
    await chmod(path, 0o000);

    // Act
    const read = await new NodeHarnessHomeDocuments().read(path, 1_024);

    // Assert
    if (process.getuid?.() === 0) {
      should(read.kind).equal('text');
      return;
    }
    should(read.kind).equal('unreadable');
    should(read.kind === 'unreadable' && read.reason).match(/EACCES|permission/iu);
  });

  it('should discover a real host layout end to end, detecting one harness and falling back for the other', async () => {
    // Arrange — the whole assembly over a real directory: the reader, the real layouts, and the pure
    // discovery. Claude has a settings model and an instructions file; Codex home is empty.
    const home = await harnessHome();
    await writeFile(join(home, '.claude', 'settings.json'), '{"model":"claude-opus-4-5"}', 'utf8');
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# Imported\n', 'utf8');

    // Act
    const report = await readHarnessDiscovery({
      layouts: harnessHomeLayouts(home),
      // Nothing is on this fixture's PATH, and that is a separate fact from what is in the home: an
      // uninstalled harness can still have configuration lying around from before.
      executables: { resolve: () => undefined },
      documents: new NodeHarnessHomeDocuments(),
      maxDocumentBytes: 64 * 1024,
    });

    // Assert
    should(report.noneInstalled).be.true();
    should(report.harnesses[0]?.models).deepEqual({
      origin: 'detected',
      ids: ['claude-opus-4-5'],
      defaultModel: 'claude-opus-4-5',
      source: join(home, '.claude', 'settings.json'),
    });
    should(report.harnesses[0]?.instructions.found).be.true();
    should(report.harnesses[1]?.models.origin).equal('fallback');
    should(report.harnesses[1]?.instructions.found).be.false();
  });
});
