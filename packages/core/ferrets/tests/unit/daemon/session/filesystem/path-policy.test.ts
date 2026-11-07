import { describe, it } from 'bun:test';
import should from 'should';
import {
  BINARY_SNIFF_BYTES,
  type FsError,
  gateCandidates,
  isDeniedPath,
  looksBinary,
  normalizeRelativePath,
  rootIsDenied,
} from '../../../../src/lib/session/filesystem/index.ts';

const NUL = String.fromCharCode(0);

const refusal = (input: string): FsError => {
  try {
    normalizeRelativePath(input);
  } catch (error) {
    return error as FsError;
  }
  throw new Error(`expected "${input}" to be refused`);
};

describe('normalizeRelativePath', () => {
  it('should treat every spelling of the root as the empty path', () => {
    // Arrange / Act / Assert
    should(normalizeRelativePath(undefined)).eql('');
    should(normalizeRelativePath(null)).eql('');
    should(normalizeRelativePath('')).eql('');
    should(normalizeRelativePath('.')).eql('');
    should(normalizeRelativePath('./')).eql('');
  });

  it('should keep an ordinary nested path and drop one trailing slash', () => {
    // Arrange / Act / Assert
    should(normalizeRelativePath('src/lib/index.ts')).eql('src/lib/index.ts');
    should(normalizeRelativePath('src/lib/')).eql('src/lib');
  });

  it('should refuse a NUL byte before the filesystem can truncate the name at it', () => {
    // Arrange / Act
    const error = refusal(`safe${NUL}/../../etc/passwd`);

    // Assert
    should(error.code).eql('invalid_path');
    should(error.message).match(/NUL/);
    should(error.name).eql('FsError');
  });

  it('should refuse a backslash, which POSIX would treat as a legal filename character', () => {
    // Arrange / Act
    const error = refusal('src\\..\\..\\etc');

    // Assert
    should(error.code).eql('invalid_path');
    should(error.message).match(/backslash/);
  });

  it('should refuse a control character anywhere in the path', () => {
    // Arrange / Act
    const withEscape = refusal(`src/${String.fromCharCode(0x1b)}[2Kfile`);
    const withDelete = refusal(`src/${String.fromCharCode(0x7f)}file`);

    // Assert
    should(withEscape.code).eql('invalid_path');
    should(withDelete.code).eql('invalid_path');
    should(withDelete.message).match(/control characters/);
  });

  it('should refuse an absolute path even when it shares a prefix with the root', () => {
    // Arrange / Act
    const error = refusal('/etc/passwd');

    // Assert
    should(error.code).eql('invalid_path');
    should(error.message).match(/relative to the session root/);
  });

  it('should refuse a ".." segment however deeply it is buried', () => {
    // Arrange / Act
    const leading = refusal('../outside');
    const interior = refusal('src/../../outside');

    // Assert
    should(leading.message).match(/".." segments/);
    should(interior.message).match(/".." segments/);
  });

  it('should refuse an empty or "." segment rather than silently collapsing it', () => {
    // Arrange / Act
    const empty = refusal('src//lib');
    const dot = refusal('src/./lib');
    const leadingSlashOnly = refusal('/');

    // Assert
    should(empty.message).match(/empty segment/);
    should(dot.message).match(/empty segment/);
    // A bare "/" is absolute first, so it is refused for that reason rather than as an empty segment.
    should(leadingSlashOnly.message).match(/relative to the session root/);
  });
});

describe('isDeniedPath', () => {
  it('should never deny the root itself', () => {
    // Arrange / Act / Assert
    should(isDeniedPath('')).be.false();
  });

  it('should deny the object store and the dependency tree at any depth, case-insensitively', () => {
    // Arrange / Act / Assert
    should(isDeniedPath('.git')).be.true();
    should(isDeniedPath('.git/config')).be.true();
    should(isDeniedPath('.GIT/config')).be.true();
    should(isDeniedPath('packages/cli/node_modules/left-pad/index.js')).be.true();
  });

  it('should deny a secret by basename pattern wherever it sits', () => {
    // Arrange / Act / Assert
    should(isDeniedPath('.env')).be.true();
    should(isDeniedPath('config/.env.production')).be.true();
    should(isDeniedPath('deploy/secrets.yaml')).be.true();
    should(isDeniedPath('deploy/secret.enc.yml')).be.true();
    should(isDeniedPath('certs/server.PEM')).be.true();
    should(isDeniedPath('keys/id_ed25519')).be.true();
    should(isDeniedPath('vault/store.kdbx')).be.true();
    should(isDeniedPath('gcp-credentials-prod.json')).be.true();
  });

  it('should deny a DIRECTORY that matches a secret pattern, not just a leaf file', () => {
    // Arrange / Act / Assert
    should(isDeniedPath('foo.key/readme.md')).be.true();
  });

  it('should allow ordinary source paths that merely resemble a secret name', () => {
    // Arrange / Act / Assert
    should(isDeniedPath('src/environment.ts')).be.false();
    should(isDeniedPath('docs/secrets-policy.md')).be.false();
    should(isDeniedPath('src/keyboard.ts')).be.false();
  });
});

describe('rootIsDenied', () => {
  it('should refuse a session root that is itself inside a denied directory', () => {
    // Arrange / Act / Assert
    should(rootIsDenied('/home/kirin/repo/.git')).be.true();
    should(rootIsDenied('/home/kirin/repo/node_modules/pkg')).be.true();
  });

  it('should refuse a session root whose own basename matches a secret pattern', () => {
    // Arrange / Act / Assert
    should(rootIsDenied('/home/kirin/repo/.env')).be.true();
  });

  it('should accept an ordinary worktree root', () => {
    // Arrange / Act / Assert
    should(rootIsDenied('/home/kirin/repo')).be.false();
    should(rootIsDenied('/')).be.false();
  });
});

describe('looksBinary', () => {
  it('should call a NUL inside the sniff window binary', () => {
    // Arrange
    const bytes = new Uint8Array([104, 105, 0, 33]);

    // Act / Assert
    should(looksBinary(bytes)).be.true();
  });

  it('should call text without a NUL text', () => {
    // Arrange / Act / Assert
    should(looksBinary(new TextEncoder().encode('hello world'))).be.false();
  });

  it('should ignore a NUL beyond the sniff window', () => {
    // Arrange: text long enough that the NUL sits outside the window entirely.
    const bytes = new Uint8Array(BINARY_SNIFF_BYTES + 8).fill(97);
    bytes[BINARY_SNIFF_BYTES + 2] = 0;

    // Act / Assert
    should(looksBinary(bytes)).be.false();
  });
});

describe('gateCandidates', () => {
  it('should keep the order given, drop the root and empties, and deduplicate', () => {
    // Arrange / Act
    const candidates = gateCandidates('alias/config', undefined, '', '.git/config', 'alias/config');

    // Assert
    should(candidates).eql(['alias/config', '.git/config']);
  });

  it('should return nothing when every path names the root', () => {
    // Arrange / Act / Assert
    should(gateCandidates('', undefined)).eql([]);
  });
});
