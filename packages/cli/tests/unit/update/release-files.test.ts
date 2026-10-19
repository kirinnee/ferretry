import { describe, it } from 'bun:test';
import should from 'should';
import {
  checksumFor,
  installerCommand,
  parseReleaseSignature,
  releaseArchiveName,
  signedReleaseMessage,
} from '../../../src/lib/update/release-files';
import { DAEMON_RELEASE_KEYS } from '../../../src/lib/update/release-keys';

const HASH = 'a'.repeat(64);

describe('release files', () => {
  it('names the GoReleaser archive for each shipped platform only', () => {
    should(releaseArchiveName('fy', 'linux', 'x64')).equal('fy_linux_amd64.tar.gz');
    should(releaseArchiveName('fy', 'darwin', 'arm64')).equal('fy_darwin_arm64.tar.gz');
    should(releaseArchiveName('fy', 'win32', 'x64')).be.undefined();
    should(releaseArchiveName('fy', 'linux', 'ia32')).be.undefined();
  });

  it('finds an archive’s checksum, in text or binary mode, and nothing else', () => {
    const list = `${'b'.repeat(64)}  other.tar.gz\n${HASH} *fy_linux_amd64.tar.gz\n\nnot a line\n`;
    should(checksumFor(list, 'fy_linux_amd64.tar.gz')).equal(HASH);
    should(checksumFor(list, 'missing.tar.gz')).be.undefined();
  });

  it('parses the fingerprint.signature form and refuses anything else', () => {
    should(parseReleaseSignature('abc_-.def\n')).deepEqual({ fingerprint: 'abc_-', signature: 'def' });
    should(parseReleaseSignature('unsigned')).be.undefined();
    should(parseReleaseSignature('a.b.c')).be.undefined();
    should(parseReleaseSignature('a+.b')).be.undefined();
  });

  it('signs the context line and then the exact bytes', () => {
    const message = new TextDecoder().decode(signedReleaseMessage(new TextEncoder().encode('sums')));
    should(message).equal('ferretry-daemon-release-v1\nsums');
  });

  it('names the installer, and ships with no trusted key until the owner adds one', () => {
    should(installerCommand('ferretry')).equal(
      'curl -fsSL https://github.com/kirinnee/ferretry/releases/latest/download/install.sh | bash',
    );
    should(DAEMON_RELEASE_KEYS).deepEqual([]);
  });
});
