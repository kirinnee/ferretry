import { describe, it } from 'bun:test';
import should from 'should';
import { nixStorePathOf } from '../../../src/lib/daemon/nix-store';

const HASH = 'q1w2e3r4t5y6u7i8o9p0asdfghjklzxc';

describe('nix store path detection', () => {
  it.each([
    { name: 'an executable inside a store output', input: `/nix/store/${HASH}-ferretry-0.125.0/bin/fyd` },
    { name: 'the store output itself', input: `/nix/store/${HASH}-ferretry-0.125.0` },
    { name: 'a deeply nested executable', input: `/nix/store/${HASH}-ferretry-0.125.0/libexec/a/b/fyd` },
    { name: 'a path with a redundant segment', input: `/nix/store/${HASH}-ferretry-0.125.0/bin/../bin/fyd` },
  ])('should root $name at its store output', ({ input }) => {
    // Act
    const actual = nixStorePathOf(input);

    // Assert
    should(actual).equal(`/nix/store/${HASH}-ferretry-0.125.0`);
  });

  it.each([
    { name: 'a Homebrew install', input: '/opt/homebrew/bin/fyd' },
    { name: 'a GoReleaser install', input: '/home/operator/.local/bin/fyd' },
    { name: 'a system path', input: '/usr/bin/fyd' },
    { name: 'a relative path', input: `nix/store/${HASH}-ferretry/bin/fyd` },
    // Nothing below is a store output, and handing any of them to `nix-store` would only earn an
    // error: the store root itself holds no derivation, and a directory that merely starts with the
    // same letters is somebody else's.
    { name: 'the store root', input: '/nix/store' },
    { name: 'the store root with a separator', input: '/nix/store/' },
    { name: 'a lookalike directory', input: '/nix/storefront/bin/fyd' },
    { name: 'a store entry with no hash', input: '/nix/store/ferretry/bin/fyd' },
    { name: 'a store entry with a short hash', input: '/nix/store/abc-ferretry/bin/fyd' },
    { name: 'a store entry with no name', input: `/nix/store/${HASH}/bin/fyd` },
    { name: 'a store entry with an uppercase hash', input: `/nix/store/${HASH.toUpperCase()}-ferretry/bin/fyd` },
  ])('should leave $name alone', ({ input }) => {
    // Act
    const actual = nixStorePathOf(input);

    // Assert
    should(actual).be.undefined();
  });
});
