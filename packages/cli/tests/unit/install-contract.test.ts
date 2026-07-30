import { describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';

interface InstallerResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

// The installer hardcodes its binary name (rewritten by scripts/local/rename.sh); read it back so
// this contract survives a product rename without edits.
async function installerBinaryName(): Promise<string> {
  const script = await Bun.file('scripts/release/install.sh').text();
  const match = /^BINARY="([^"]+)"$/m.exec(script);
  should(match).not.be.null();
  return (match as RegExpExecArray)[1] as string;
}

class InstallerHarness {
  readonly fakeBin: string;
  readonly fixtureDir: string;
  readonly installDir: string;

  constructor(
    readonly root: string,
    readonly binary: string,
  ) {
    this.fakeBin = join(root, 'fake-bin');
    this.fixtureDir = join(root, 'fixture');
    this.installDir = join(root, 'installed');
  }

  get archive(): string {
    return `${this.binary}_linux_amd64.tar.gz`;
  }

  async setup(): Promise<void> {
    await mkdir(this.fakeBin, { recursive: true });
    await mkdir(this.fixtureDir, { recursive: true });
    await Bun.write(
      join(this.fakeBin, 'uname'),
      String.raw`#!/usr/bin/env bash
case "${'$'}{1:-}" in
-s) printf "%s\n" "${'$'}{FAKE_OS:-Linux}" ;;
-m) printf "%s\n" "${'$'}{FAKE_ARCH:-x86_64}" ;;
esac
`,
    );
    await Bun.write(
      join(this.fakeBin, 'curl'),
      String.raw`#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
case "${'$'}{out}" in
*checksums.txt) cp "${'$'}{FIXTURE_DIR}/checksums.txt" "${'$'}{out}" ;;
*) cp "${'$'}{FIXTURE_DIR}/${'$'}{FIXTURE_ARCHIVE}" "${'$'}{out}" ;;
esac
`,
    );
    await chmod(join(this.fakeBin, 'uname'), 0o755);
    await chmod(join(this.fakeBin, 'curl'), 0o755);
  }

  async prepareArchive(validChecksum: boolean): Promise<void> {
    const payload = join(this.root, 'payload');
    const archive = join(this.fixtureDir, this.archive);
    await mkdir(payload, { recursive: true });
    await Bun.write(join(payload, this.binary), `#!/usr/bin/env bash\necho ${this.binary} fixture\n`);
    await chmod(join(payload, this.binary), 0o755);
    const tar = Bun.spawn(['tar', '-czf', archive, '-C', payload, this.binary]);
    should(await tar.exited).equal(0);
    const digestProc = Bun.spawn(['sha256sum', archive], { stdout: 'pipe' });
    const digest = (await new Response(digestProc.stdout).text()).split(' ')[0];
    should(await digestProc.exited).equal(0);
    await Bun.write(
      join(this.fixtureDir, 'checksums.txt'),
      `${validChecksum ? digest : '0'.repeat(64)}  ${this.archive}\n`,
    );
  }

  async run(env: Record<string, string> = {}): Promise<InstallerResult> {
    const process = Bun.spawn(['bash', 'scripts/release/install.sh'], {
      env: {
        ...globalThis.process.env,
        PATH: `${this.fakeBin}:${globalThis.process.env.PATH ?? ''}`,
        BIN_DIR: this.installDir,
        FIXTURE_DIR: this.fixtureDir,
        FIXTURE_ARCHIVE: this.archive,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { code, out, err };
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function harness(): Promise<InstallerHarness> {
  const binary = await installerBinaryName();
  const subject = new InstallerHarness(await mkdtemp(join(tmpdir(), 'cli-installer-')), binary);
  await subject.setup();
  return subject;
}

describe('release installer contract', () => {
  it('should reject an unsupported operating system before downloading', async () => {
    // Arrange
    const subject = await harness();

    try {
      // Act
      const actual = await subject.run({ FAKE_OS: 'Plan9' });

      // Assert
      should(actual.code).not.equal(0);
      should(actual.err).containEql('unsupported OS');
    } finally {
      await subject.cleanup();
    }
  });

  it('should reject an archive whose checksum does not match', async () => {
    // Arrange
    const subject = await harness();
    await subject.prepareArchive(false);

    try {
      // Act
      const actual = await subject.run();

      // Assert
      should(actual.code).not.equal(0);
      should(actual.out + actual.err).containEql('FAILED');
    } finally {
      await subject.cleanup();
    }
  });

  it('should complete the supported installation path after verifying its checksum', async () => {
    // Arrange
    const subject = await harness();
    await subject.prepareArchive(true);

    try {
      // Act
      const actual = await subject.run();

      // Assert
      should(actual.code).equal(0);
      should(actual.out).containEql('checksum verified');
      should(await readFile(join(subject.installDir, subject.binary), 'utf8')).containEql(`${subject.binary} fixture`);
    } finally {
      await subject.cleanup();
    }
  });
});
