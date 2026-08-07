import { describe, it } from 'bun:test';
import should from 'should';
import {
  daemonSnapshotGcRoot,
  InvalidDaemonEnvironmentError,
  managerForPlatform,
  resolveDaemonLayout,
} from '../../../src/lib/daemon/layout';
import { environment, HOME, layout } from './fixtures';

describe('manager for platform', () => {
  it('should map each platform to the manager that actually exists there', () => {
    // Act + Assert
    should(managerForPlatform('linux')).equal('systemd');
    should(managerForPlatform('darwin')).equal('launchd');
    should(managerForPlatform('win32')).equal('direct');
    should(managerForPlatform('freebsd')).equal('direct');
  });
});

describe('daemon layout', () => {
  it('should default the state home beside the user home', () => {
    // Act
    const actual = layout();

    // Assert
    should(actual.stateHome).equal(`${HOME}/.ferretry`);
    should(actual.logDirectory).equal(`${HOME}/.ferretry/logs`);
    should(actual.logFile).equal(`${HOME}/.ferretry/logs/fyd.log`);
  });

  it('should honour a pinned state home', () => {
    // Act
    const actual = layout({ stateHome: '/tmp/pinned' });

    // Assert
    should(actual.stateHome).equal('/tmp/pinned');
    should(actual.logFile).equal('/tmp/pinned/logs/fyd.log');
  });

  it('should treat a blank state home as unset rather than as the filesystem root', () => {
    // Act
    const actual = layout({ stateHome: '   ' });

    // Assert
    should(actual.stateHome).equal(`${HOME}/.ferretry`);
  });

  it('should place the systemd unit under the config home', () => {
    // Act
    const actual = layout();

    // Assert
    should(actual.systemdUnitName).equal('fyd.service');
    should(actual.systemdUnitFile).equal(`${HOME}/.config/systemd/user/fyd.service`);
  });

  it('should honour XDG_CONFIG_HOME uniformly, whether or not the state home was pinned', () => {
    // Act — kteam consulted XDG_CONFIG_HOME only when the home was NOT pinned, so its tests
    // exercised a different code path from production.
    const pinned = layout({ configHome: '/tmp/xdg', stateHome: '/tmp/pinned' });
    const unpinned = layout({ configHome: '/tmp/xdg' });

    // Assert
    should(pinned.systemdUnitFile).equal('/tmp/xdg/systemd/user/fyd.service');
    should(unpinned.systemdUnitFile).equal('/tmp/xdg/systemd/user/fyd.service');
  });

  it('should fall back to ~/.config when XDG_CONFIG_HOME is blank', () => {
    // Act
    const actual = layout({ configHome: '  ' });

    // Assert
    should(actual.systemdUnitFile).equal(`${HOME}/.config/systemd/user/fyd.service`);
  });

  it('should derive the launchd label, domain and service target from the uid', () => {
    // Act
    const actual = layout({ platform: 'darwin', userId: 501 });

    // Assert — kteam built the domain by string-surgery on the target; both are derived here.
    should(actual.launchdLabel).equal('com.ferretry.fyd');
    should(actual.launchdDomain).equal('gui/501');
    should(actual.launchdServiceTarget).equal('gui/501/com.ferretry.fyd');
    should(actual.launchAgentFile).equal(`${HOME}/Library/LaunchAgents/com.ferretry.fyd.plist`);
  });

  it('should derive the daemon-keyed snapshot store without resolving a live executable', () => {
    // Act
    const actual = layout({ searchPath: '/only/here' });

    // Assert
    should(actual.daemonName).equal('fyd');
    should(actual.product).equal('ferretry');
    should(actual.snapshotRoot).equal(`${HOME}/.local/state/ferretry/daemon-snapshots/fyd`);
    should(actual.searchPath).equal('/only/here');
  });

  it.each([
    { name: 'XDG_STATE_HOME when the operator set one', input: '/tmp/xdg-state', expected: '/tmp/xdg-state' },
    { name: '~/.local/state when it is unset', input: undefined, expected: `${HOME}/.local/state` },
    { name: '~/.local/state when it is blank', input: '  ', expected: `${HOME}/.local/state` },
  ])('should put the Nix GC roots under $name', ({ input, expected }) => {
    // Act
    const actual = layout({ stateDirectory: input });

    // Assert — never under the state home. That directory is the daemon's, its layout model refuses
    // any entry it has not declared, and its filesystem port refuses symbolic links anywhere inside
    // it — and these roots are symbolic links.
    should(actual.nixGcRootDirectory).equal(`${expected}/ferretry/nix/snapshots/fyd`);
    should(actual.nixGcRootDirectory.startsWith(`${actual.stateHome}/`)).be.false();
  });

  describe('lifecycle claim', () => {
    it.each([
      {
        name: 'systemd keys on every ownership target in semantic order',
        platform: 'linux',
        expected: [
          '/tmp/.1000.systemd.fyd.service.target.lifecycle.lock',
          `${HOME}/.local/state/ferretry/daemon-snapshots/.3-fyd.14-snapshot-store.lifecycle.lock`,
          `${HOME}/.config/systemd/user/.11-fyd.service.10-definition.lifecycle.lock`,
          `${HOME}/.9-.ferretry.10-fyd.direct.lifecycle.lock`,
        ],
      },
      {
        name: 'launchd keys on every ownership target in semantic order',
        platform: 'darwin',
        expected: [
          '/tmp/.1000.launchd.com.ferretry.fyd.target.lifecycle.lock',
          `${HOME}/.local/state/ferretry/daemon-snapshots/.3-fyd.14-snapshot-store.lifecycle.lock`,
          `${HOME}/Library/LaunchAgents/.22-com.ferretry.fyd.plist.10-definition.lifecycle.lock`,
          `${HOME}/.9-.ferretry.10-fyd.direct.lifecycle.lock`,
        ],
      },
      {
        name: 'a direct host keys on its snapshot ownership and served state home',
        platform: 'win32',
        expected: [
          `${HOME}/.local/state/ferretry/daemon-snapshots/.3-fyd.14-snapshot-store.lifecycle.lock`,
          `${HOME}/.9-.ferretry.10-fyd.direct.lifecycle.lock`,
        ],
      },
    ])('should key the claims where $name', ({ platform, expected }) => {
      // Act
      const actual = layout({ platform });

      // Assert — beside every target the mutating verbs may own, in one stable acquisition order.
      should(actual.lifecycleLocks).deepEqual(expected);
    });

    it.each([
      {
        name: 'systemd',
        platform: 'linux',
        shared: [
          '/tmp/.1000.systemd.fyd.service.target.lifecycle.lock',
          `${HOME}/.config/systemd/user/.11-fyd.service.10-definition.lifecycle.lock`,
          `${HOME}/.9-.ferretry.10-fyd.direct.lifecycle.lock`,
        ],
      },
      {
        name: 'launchd',
        platform: 'darwin',
        shared: [
          '/tmp/.1000.launchd.com.ferretry.fyd.target.lifecycle.lock',
          `${HOME}/Library/LaunchAgents/.22-com.ferretry.fyd.plist.10-definition.lifecycle.lock`,
          `${HOME}/.9-.ferretry.10-fyd.direct.lifecycle.lock`,
        ],
      },
    ])(
      'should give two $name invocations shared claims across different XDG_STATE_HOME values',
      ({ platform, shared }) => {
        // Arrange — one shell exports XDG_STATE_HOME and another takes the default. Both write the SAME
        // definition and manage the same daemon.
        const exported = layout({ platform, stateDirectory: '/tmp/exported-state' });
        const defaulted = layout({ platform, stateDirectory: undefined });

        // Assert — changing the snapshot/root ownership changes only that claim. The definition,
        // logical manager target and direct daemon still serialize the transaction.
        should(exported.lifecycleLocks.filter(lock => defaulted.lifecycleLocks.includes(lock))).deepEqual(shared);
        should(exported.nixGcRootDirectory).not.equal(defaulted.nixGcRootDirectory);
      },
    );

    it('should keep the direct claim across different XDG_STATE_HOME values on a host with no manager', () => {
      // Arrange — snapshot/root ownership changes, but the daemon these verbs launch and stop serves
      // the same state home.
      const exported = layout({ platform: 'win32', stateDirectory: '/tmp/exported-state' });
      const defaulted = layout({ platform: 'win32', stateDirectory: undefined });

      // Assert
      should(exported.lifecycleLocks.filter(lock => defaulted.lifecycleLocks.includes(lock))).deepEqual([
        `${HOME}/.9-.ferretry.10-fyd.direct.lifecycle.lock`,
      ]);
    });

    it('should keep one direct-fallback claim when Linux invocations use different config homes', () => {
      // Arrange — whether a unit is installed is checked only inside the transaction. When neither
      // config home contains one, both invocations launch and stop the daemon serving the same FY_HOME.
      const first = layout({ platform: 'linux', configHome: '/tmp/config-one', stateHome: '/tmp/shared-fy' });
      const second = layout({ platform: 'linux', configHome: '/tmp/config-two', stateHome: '/tmp/shared-fy' });

      // Assert — the definition claims differ, but logical-manager, snapshot and direct claims remain.
      should(first.lifecycleLocks).not.deepEqual(second.lifecycleLocks);
      should(first.lifecycleLocks.filter(lock => second.lifecycleLocks.includes(lock))).deepEqual([
        '/tmp/.1000.systemd.fyd.service.target.lifecycle.lock',
        `${HOME}/.local/state/ferretry/daemon-snapshots/.3-fyd.14-snapshot-store.lifecycle.lock`,
        '/tmp/.9-shared-fy.10-fyd.direct.lifecycle.lock',
      ]);
    });

    it('should keep one direct-fallback claim when macOS invocations resolve different plists', () => {
      // Arrange — pinning FY_HOME while HOME differs gives the direct child one identity but gives
      // launchd two plist paths. The state-home claim covers the absent-plist fallback.
      const first = layout({ platform: 'darwin', homeDirectory: '/tmp/home-one', stateHome: '/tmp/shared-fy' });
      const second = layout({ platform: 'darwin', homeDirectory: '/tmp/home-two', stateHome: '/tmp/shared-fy' });

      // Assert
      should(first.lifecycleLocks).not.deepEqual(second.lifecycleLocks);
      should(first.lifecycleLocks.filter(lock => second.lifecycleLocks.includes(lock))).deepEqual([
        '/tmp/.1000.launchd.com.ferretry.fyd.target.lifecycle.lock',
        '/tmp/.9-shared-fy.10-fyd.direct.lifecycle.lock',
      ]);
    });

    it('should claim shared snapshots and roots across different FY_HOME and config homes', () => {
      // Arrange — these invocations have different definitions and direct daemons, but mutate the
      // SAME snapshot store and root directory through their shared XDG_STATE_HOME.
      const first = layout({
        platform: 'linux',
        configHome: '/tmp/config-one',
        stateHome: '/tmp/fy-one',
        stateDirectory: '/tmp/shared-state',
      });
      const second = layout({
        platform: 'linux',
        configHome: '/tmp/config-two',
        stateHome: '/tmp/fy-two',
        stateDirectory: '/tmp/shared-state',
      });

      // Assert — manager targeting is shared too, but this exact second claim owns the store/root pair.
      should(first.lifecycleLocks.filter(lock => second.lifecycleLocks.includes(lock))).deepEqual([
        '/tmp/.1000.systemd.fyd.service.target.lifecycle.lock',
        '/tmp/shared-state/ferretry/daemon-snapshots/.3-fyd.14-snapshot-store.lifecycle.lock',
      ]);
    });

    it.each([
      {
        name: 'systemd unit name',
        platform: 'linux',
        first: {
          homeDirectory: '/tmp/linux-one',
          configHome: '/tmp/linux-config-one',
          stateHome: '/tmp/linux-fy-one',
          stateDirectory: '/tmp/linux-state-one',
        },
        second: {
          homeDirectory: '/tmp/linux-two',
          configHome: '/tmp/linux-config-two',
          stateHome: '/tmp/linux-fy-two',
          stateDirectory: '/tmp/linux-state-two',
        },
        expected: '/tmp/.1000.systemd.fyd.service.target.lifecycle.lock',
      },
      {
        name: 'launchd domain and label',
        platform: 'darwin',
        first: {
          homeDirectory: '/tmp/mac-one',
          configHome: '/tmp/mac-config-one',
          stateHome: '/tmp/mac-fy-one',
          stateDirectory: '/tmp/mac-state-one',
        },
        second: {
          homeDirectory: '/tmp/mac-two',
          configHome: '/tmp/mac-config-two',
          stateHome: '/tmp/mac-fy-two',
          stateDirectory: '/tmp/mac-state-two',
        },
        expected: '/tmp/.1000.launchd.com.ferretry.fyd.target.lifecycle.lock',
      },
    ])(
      'should retain one logical $name claim when every path-bearing environment value differs',
      ({ platform, first, second, expected }) => {
        // Act
        const firstLayout = layout({ platform, ...first });
        const secondLayout = layout({ platform, ...second });

        // Assert
        should(firstLayout.lifecycleLocks.filter(lock => secondLayout.lifecycleLocks.includes(lock))).deepEqual([
          expected,
        ]);
      },
    );

    it('should order claims by semantic role rather than unresolved path spelling', () => {
      // Arrange — symlink aliases can make the same physical directories compare in opposite lexical
      // orders. Roles must stay fixed without doing filesystem I/O in this pure layout decision.
      const first = layout({ configHome: '/tmp/z-config', stateHome: '/tmp/a-fy', stateDirectory: '/tmp/m-state' });
      const second = layout({ configHome: '/tmp/a-config', stateHome: '/tmp/z-fy', stateDirectory: '/tmp/b-state' });

      // Assert — target, snapshot/root, definition, direct; spelling never reorders those categories.
      for (const actual of [first, second]) {
        should(actual.lifecycleLocks[0]).equal('/tmp/.1000.systemd.fyd.service.target.lifecycle.lock');
        should(actual.lifecycleLocks[1]).endWith('/daemon-snapshots/.3-fyd.14-snapshot-store.lifecycle.lock');
        should(actual.lifecycleLocks[2]).endWith('/systemd/user/.11-fyd.service.10-definition.lifecycle.lock');
        should(actual.lifecycleLocks[3]).endWith('.10-fyd.direct.lifecycle.lock');
      }
    });

    it('should keep leading-dot artifacts distinct from their plain-name neighbours', () => {
      // Arrange — prefixing a hidden dot without encoding collapses `/tmp/foo` and `/tmp/.foo` onto
      // one filename, so a residue from one direct daemon can block the other.
      const plain = layout({ platform: 'win32', stateHome: '/tmp/foo', stateDirectory: '/tmp/state-one' });
      const hidden = layout({ platform: 'win32', stateHome: '/tmp/.foo', stateDirectory: '/tmp/state-two' });

      // Assert
      should(plain.lifecycleLocks.at(-1)).equal('/tmp/.3-foo.10-fyd.direct.lifecycle.lock');
      should(hidden.lifecycleLocks.at(-1)).equal('/tmp/.4-.foo.10-fyd.direct.lifecycle.lock');
      should(plain.lifecycleLocks.some(lock => hidden.lifecycleLocks.includes(lock))).be.false();
    });

    it('should keep dotted artifact and qualifier boundaries distinct', () => {
      // Arrange — punctuation joining collapses `(a, b.c)` and `(a.b, c)`. Length-prefixed components
      // preserve which bytes belong to the state-home artifact and which belong to the daemon role.
      const first = layout({
        platform: 'win32',
        daemonName: 'b.c',
        stateHome: '/tmp/a',
        stateDirectory: '/tmp/state-one',
      });
      const second = layout({
        platform: 'win32',
        daemonName: 'c',
        stateHome: '/tmp/a.b',
        stateDirectory: '/tmp/state-two',
      });

      // Assert
      should(first.lifecycleLocks.at(-1)).equal('/tmp/.1-a.10-b.c.direct.lifecycle.lock');
      should(second.lifecycleLocks.at(-1)).equal('/tmp/.3-a.b.8-c.direct.lifecycle.lock');
      should(first.lifecycleLocks.some(lock => second.lifecycleLocks.includes(lock))).be.false();
    });

    it.each([
      { name: 'systemd', platform: 'linux' },
      { name: 'launchd', platform: 'darwin' },
      { name: 'direct mode', platform: 'win32' },
    ])('should still give two $name daemons two claims', ({ platform }) => {
      // Act
      const first = layout({ platform, daemonName: 'one' });
      const second = layout({ platform, daemonName: 'two' });

      // Assert — over-serializing one daemon costs a wait; under-serializing it costs a unit file
      // that names a snapshot nothing is holding.
      should(first.lifecycleLocks.some(lock => second.lifecycleLocks.includes(lock))).be.false();
    });

    it.each([
      { name: 'a systemd unit', platform: 'linux', suffix: '.service' },
      { name: 'a launchd job', platform: 'darwin', suffix: '.plist' },
    ])('should not leave a name $name manager could load as a definition', ({ platform, suffix }) => {
      // Act
      const actual = layout({ platform });

      // Assert — the definition claim lives in the manager's own directory, so its hidden name has to
      // be one the manager skips.
      const managerLock = actual.lifecycleLocks.find(lock =>
        platform === 'linux' ? lock.includes('/systemd/user/') : lock.includes('/LaunchAgents/'),
      );
      should(managerLock).not.be.undefined();
      should(managerLock?.split('/').pop()?.startsWith('.')).be.true();
      should(managerLock?.endsWith(suffix)).be.false();
    });
  });

  it('should keep the superseded single root beside the per-snapshot directory, not above it', () => {
    // Act
    const actual = layout({ stateDirectory: '/tmp/xdg-state' });

    // Assert — a symbolic link cannot also be the directory the new roots live in, so reusing that
    // name would leave an upgraded installation unable to create any root at all.
    should(actual.supersededNixGcRoot).equal('/tmp/xdg-state/ferretry/nix/fyd');
    should(actual.nixGcRootDirectory.startsWith(`${actual.supersededNixGcRoot}/`)).be.false();
  });

  describe('snapshot garbage-collection root', () => {
    it('should name the root after the snapshot it protects, and nothing else', () => {
      // Act — the ONE mapping from a snapshot identity to a root path, so the writer and the reader
      // of a root can never disagree about where it is.
      const actual = daemonSnapshotGcRoot('/tmp/state/ferretry/nix/snapshots/fyd', `sha256-${'a'.repeat(64)}`);

      // Assert
      should(actual).equal(`/tmp/state/ferretry/nix/snapshots/fyd/sha256-${'a'.repeat(64)}`);
    });

    it.each([
      { name: 'a path separator', id: '../../../etc/fyd' },
      { name: 'an empty identity', id: '' },
    ])('should refuse $name rather than let it retarget the write', ({ id }) => {
      // Act + Assert — a root path is a filename, and a filename that can be steered is a write that
      // can be steered.
      should(() => daemonSnapshotGcRoot('/tmp/state/ferretry/nix/snapshots/fyd', id)).throw(
        InvalidDaemonEnvironmentError,
      );
    });

    it('should refuse a relative root directory rather than resolve it against the cwd', () => {
      // Act + Assert
      should(() => daemonSnapshotGcRoot('nix/snapshots/fyd', `sha256-${'a'.repeat(64)}`)).throw(
        /nix root directory must be an absolute path/,
      );
    });
  });

  it('should reject a relative XDG_STATE_HOME rather than resolve it against the cwd', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ stateDirectory: 'state' }))).throw(
      /XDG_STATE_HOME must be an absolute path/,
    );
  });

  it('should key snapshots by product and daemon under XDG_STATE_HOME', () => {
    // Act
    const first = layout({ stateDirectory: '/tmp/state', product: 'alpha', daemonName: 'one' });
    const second = layout({ stateDirectory: '/tmp/state', product: 'alpha', daemonName: 'two' });

    // Assert
    should(first.snapshotRoot).equal('/tmp/state/alpha/daemon-snapshots/one');
    should(second.snapshotRoot).equal('/tmp/state/alpha/daemon-snapshots/two');
    should(first.snapshotRoot).not.equal(second.snapshotRoot);
  });

  it('should treat a blank XDG_STATE_HOME as unset', () => {
    // Act
    const actual = layout({ stateDirectory: '   ' });

    // Assert
    should(actual.snapshotRoot).equal(`${HOME}/.local/state/ferretry/daemon-snapshots/fyd`);
  });

  it('should normalise a path with redundant segments', () => {
    // Act
    const actual = layout({ stateHome: '/tmp/a/../b' });

    // Assert
    should(actual.stateHome).equal('/tmp/b');
  });
});

describe('daemon layout refusals', () => {
  it('should refuse a relative home directory', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ homeDirectory: 'relative' }))).throw(
      /home directory must be an absolute path/u,
    );
  });

  it('should refuse an empty home directory', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ homeDirectory: '  ' }))).throw(/must not be empty/u);
  });

  it('should refuse the filesystem root as a state home', () => {
    // Act + Assert — an installer that writes under `/` is a mistake we can catch here.
    should(() => resolveDaemonLayout(environment({ stateHome: '/' }))).throw(/FY_HOME must not be a filesystem root/u);
  });

  it('should refuse a relative XDG_CONFIG_HOME', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ configHome: 'config' }))).throw(
      /XDG_CONFIG_HOME must be an absolute path/u,
    );
  });

  it('should refuse an unsafe XDG_STATE_HOME', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ stateDirectory: 'state' }))).throw(
      /XDG_STATE_HOME must be an absolute path/u,
    );
    should(() => resolveDaemonLayout(environment({ stateDirectory: '/' }))).throw(
      /XDG_STATE_HOME must not be a filesystem root/u,
    );
  });

  it('should refuse a daemon name that would retarget the unit file', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ daemonName: '../evil' }))).throw(
      /daemon name must be a plain name/u,
    );
    should(() => resolveDaemonLayout(environment({ daemonName: 'has space' }))).throw(/daemon name must be a plain/u);
    should(() => resolveDaemonLayout(environment({ daemonName: '' }))).throw(/daemon name must be a plain/u);
  });

  it('should refuse a product name that would retarget the launchd label', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ product: 'a/b' }))).throw(/product name must be a plain name/u);
  });

  it('should refuse a user id that is not a whole non-negative number', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ userId: -1 }))).throw(/user id must be a non-negative integer/u);
    should(() => resolveDaemonLayout(environment({ userId: 1.5 }))).throw(/user id must be a non-negative integer/u);
  });

  it('should name the offending field on the error it throws', () => {
    // Act
    let caught: unknown;
    try {
      resolveDaemonLayout(environment({ userId: -3 }));
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(InvalidDaemonEnvironmentError);
    should((caught as InvalidDaemonEnvironmentError).field).equal('user id');
  });
});
