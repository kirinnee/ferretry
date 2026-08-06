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
  ])('should put the Nix GC roots and the lifecycle claim under $name', ({ input, expected }) => {
    // Act
    const actual = layout({ stateDirectory: input });

    // Assert — never under the state home. That directory is the daemon's, its layout model refuses
    // any entry it has not declared, and its filesystem port refuses symbolic links anywhere inside
    // it — and these roots are symbolic links.
    should(actual.nixGcRootDirectory).equal(`${expected}/ferretry/nix/snapshots/fyd`);
    should(actual.lifecycleLock).equal(`${expected}/ferretry/lifecycle/fyd.lock`);
    should(actual.nixGcRootDirectory.startsWith(`${actual.stateHome}/`)).be.false();
    should(actual.lifecycleLock.startsWith(`${actual.stateHome}/`)).be.false();
  });

  it('should keep the superseded single root beside the per-snapshot directory, not above it', () => {
    // Act
    const actual = layout({ stateDirectory: '/tmp/xdg-state' });

    // Assert — a symbolic link cannot also be the directory the new roots live in, so reusing that
    // name would leave an upgraded installation unable to create any root at all.
    should(actual.supersededNixGcRoot).equal('/tmp/xdg-state/ferretry/nix/fyd');
    should(actual.nixGcRootDirectory.startsWith(`${actual.supersededNixGcRoot}/`)).be.false();
  });

  it('should give every daemon its own lifecycle claim so two daemons never wait for each other', () => {
    // Act
    const first = layout({ stateDirectory: '/tmp/state', daemonName: 'one' });
    const second = layout({ stateDirectory: '/tmp/state', daemonName: 'two' });

    // Assert
    should(first.lifecycleLock).not.equal(second.lifecycleLock);
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
