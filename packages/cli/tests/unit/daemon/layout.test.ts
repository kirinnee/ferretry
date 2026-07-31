import { describe, it } from 'bun:test';
import should from 'should';
import { InvalidDaemonEnvironmentError, managerForPlatform, resolveDaemonLayout } from '../../../src/lib/daemon/layout';
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

  it('should carry the daemon name, binary and search path through untouched', () => {
    // Act
    const actual = layout({ daemonBinary: '/opt/other/fyd', searchPath: '/only/here' });

    // Assert
    should(actual.daemonName).equal('fyd');
    should(actual.daemonBinary).equal('/opt/other/fyd');
    should(actual.searchPath).equal('/only/here');
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

  it('should refuse a relative daemon binary, because systemd needs an absolute ExecStart', () => {
    // Act + Assert
    should(() => resolveDaemonLayout(environment({ daemonBinary: 'fyd' }))).throw(
      /daemon binary must be an absolute path/u,
    );
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
