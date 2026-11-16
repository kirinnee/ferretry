import { describe, it } from 'bun:test';
import should from 'should';
import { resolveDaemonBinaryPath } from '../../src/lib/daemon/binary.ts';
import { resolveDaemonLayout } from '../../src/lib/daemon/layout.ts';
import { daemonLocale } from '../../src/lib/daemon/locale.ts';
import { nixStorePathOf } from '../../src/lib/daemon/nix-store.ts';
import { isBinaryPlist, parsePlist, plistString } from '../../src/lib/daemon/plist.ts';
import {
  launchAgentProcessType,
  launchAgentStateHome,
  renderLaunchAgentPlist,
  renderSystemdUnit,
  type ServiceDefinitionSpec,
  systemdUnitStateHome,
} from '../../src/lib/daemon/unit-file.ts';

const input = {
  platform: 'linux',
  homeDirectory: '/home/ada',
  userId: 1000,
  daemonName: 'fyd',
  product: 'ferretry',
  searchPath: '/usr/bin',
};

describe('where the daemon lives on this host', () => {
  it('defaults the state home to a dot-folder named for the product, and the manager to the platform’s own', () => {
    const linux = resolveDaemonLayout(input);
    should(linux.stateHome).equal('/home/ada/.ferretry');
    should(linux.manager).equal('systemd');
    should(resolveDaemonLayout({ ...input, platform: 'darwin' }).manager).equal('launchd');
    should(resolveDaemonLayout({ ...input, platform: 'freebsd' }).manager).equal('direct');
  });

  it('refuses a directory that is empty, relative, or the filesystem root, naming the field', () => {
    should(() => resolveDaemonLayout({ ...input, homeDirectory: ' ' })).throw(
      'invalid daemon environment: home directory must not be empty',
    );
    should(() => resolveDaemonLayout({ ...input, homeDirectory: 'home/ada' })).throw(
      'invalid daemon environment: home directory must be an absolute path',
    );
    should(() => resolveDaemonLayout({ ...input, stateHome: '/' })).throw(
      'invalid daemon environment: FY_HOME must not be a filesystem root',
    );
  });

  it('refuses a name that could retarget a write, and a user id that is not a whole number', () => {
    should(() => resolveDaemonLayout({ ...input, daemonName: '../fyd' })).throw(
      'invalid daemon environment: daemon name must be a plain name of letters, digits, dot, dash or underscore',
    );
    should(() => resolveDaemonLayout({ ...input, product: 'a b' })).throw(/product name must be a plain name/u);
    should(() => resolveDaemonLayout({ ...input, userId: -1 })).throw(
      'invalid daemon environment: user id must be a non-negative integer',
    );
    should(() => resolveDaemonLayout({ ...input, userId: 1.5 })).throw(/user id must be a non-negative integer/u);
  });
});

describe('the locale the daemon runs under', () => {
  it('forwards the caller’s own variables when the one in effect is UTF-8', () => {
    should(daemonLocale('linux', { LC_ALL: 'fr_FR.UTF-8', LANG: 'en_GB.utf8', LC_CTYPE: '' })).deepEqual({
      LC_ALL: 'fr_FR.UTF-8',
      LANG: 'en_GB.utf8',
    });
  });

  it('uses the platform’s UTF-8 locale alone when the one in effect is not UTF-8, or none is set', () => {
    should(daemonLocale('linux', { LC_ALL: 'C', LANG: 'en_GB.UTF-8' })).deepEqual({ LANG: 'C.UTF-8' });
    should(daemonLocale('darwin', {})).deepEqual({ LANG: 'en_US.UTF-8' });
  });
});

describe('which Nix store output an executable belongs to', () => {
  const hash = 'a'.repeat(32);

  it('names the store output below a real store path', () => {
    should(nixStorePathOf(`/nix/store/${hash}-ferretry/bin/fyd`)).equal(`/nix/store/${hash}-ferretry`);
  });

  it('answers nothing for a relative path, a path outside the store, or a name that is not a store output', () => {
    should(nixStorePathOf('nix/store/x')).equal(undefined);
    should(nixStorePathOf('/usr/local/bin/fyd')).equal(undefined);
    should(nixStorePathOf('/nix/storefront/bin/fyd')).equal(undefined);
    should(nixStorePathOf('/nix/store/short-name/bin/fyd')).equal(undefined);
    should(nixStorePathOf('/nix/store/')).equal(undefined);
  });
});

describe('which daemon executable this host launches', () => {
  const executable = () => true;

  it('takes a pinned path over the PATH search, and the PATH search otherwise', () => {
    should(
      resolveDaemonBinaryPath({ daemonName: 'fyd', pinned: ' /opt/fyd ', found: '/usr/bin/fyd', executable }),
    ).deepEqual({ path: '/opt/fyd', source: 'FY_DAEMON_BIN' });
    should(
      resolveDaemonBinaryPath({ daemonName: 'fyd', pinned: undefined, found: '/usr/bin/fyd', executable }),
    ).deepEqual({ path: '/usr/bin/fyd', source: 'PATH' });
  });

  it('says the daemon cannot be found when nothing is pinned and the PATH search found nothing', () => {
    should(() => resolveDaemonBinaryPath({ daemonName: 'fyd', pinned: '', found: undefined, executable })).throw(
      'cannot find fyd on PATH — install it or point FY_DAEMON_BIN at the executable',
    );
  });

  it('refuses a relative path, naming where it came from', () => {
    should(() => resolveDaemonBinaryPath({ daemonName: 'fyd', pinned: 'bin/fyd', found: undefined, executable })).throw(
      /fyd must be an absolute path for a user service to launch it, but FY_DAEMON_BIN is bin\/fyd/u,
    );
  });

  it('refuses a path that is not an executable file', () => {
    should(() =>
      resolveDaemonBinaryPath({ daemonName: 'fyd', pinned: '/gone/fyd', found: undefined, executable: () => false }),
    ).throw(
      'FY_DAEMON_BIN names /gone/fyd, which is not an executable file — install fyd or point FY_DAEMON_BIN at one',
    );
  });
});

describe('reading a launchd property list', () => {
  it('knows a binary property list by its magic', () => {
    should(isBinaryPlist('bplist00\u0001')).equal(true);
    should(isBinaryPlist('<?xml version="1.0"?>')).equal(false);
  });

  it('reads strings, numbers, booleans, arrays and dictionaries, decoding the entities in text', () => {
    const value = parsePlist(`<?xml version="1.0"?><!DOCTYPE plist><!-- note --><plist><dict>
      <key>A</key><string>x &amp; y &#65; &#x42; &bogus; &#xFFFFFFFF;</string>
      <key>N</key><integer>3</integer><key>R</key><real>1.5</real>
      <key>T</key><true/><key>F</key><false/>
      <key>E</key><string/><key>L</key><array><string>one</string><string><![CDATA[<two>]]></string></array>
      <key>D</key><dict/><key>Z</key><array/><key>Q</key><data>abc</data><key>W</key><date/>
    </dict></plist>`);

    if (value?.kind !== 'dict') throw new Error('expected a dictionary');
    should(plistString(value, 'A')).equal('x & y A B &bogus; &#xFFFFFFFF;');
    should(value.entries.get('N')).deepEqual({ kind: 'number', value: 3 });
    should(value.entries.get('R')).deepEqual({ kind: 'number', value: 1.5 });
    should(value.entries.get('T')).deepEqual({ kind: 'boolean', value: true });
    should(value.entries.get('F')).deepEqual({ kind: 'boolean', value: false });
    should(plistString(value, 'E')).equal('');
    should(value.entries.get('L')).deepEqual({
      kind: 'array',
      items: [
        { kind: 'string', value: 'one' },
        { kind: 'string', value: '<two>' },
      ],
    });
    should(value.entries.get('D')).deepEqual({ kind: 'dict', entries: new Map() });
    should(value.entries.get('Z')).deepEqual({ kind: 'array', items: [] });
    should(plistString(value, 'Q')).equal('abc');
    should(plistString(value, 'W')).equal('');
  });

  it('reads a bare value without the plist wrapper, tolerating a CRLF checkout and a byte-order mark', () => {
    should(parsePlist('\uFEFF<string>hi</string>\r\n')).deepEqual({ kind: 'string', value: 'hi' });
  });

  it('answers nothing for anything that is not a well-formed XML plist', () => {
    for (const broken of [
      '',
      'text only',
      '<plist><dict><key>A</key></dict></plist>',
      '<plist><dict><string>x</string></dict></plist>',
      '<plist><dict><key>A</key><bogus/></dict></plist>',
      '<plist><dict><key>A</key><integer>x</integer></dict></plist>',
      '<plist><dict><key>A</key><integer></integer></dict></plist>',
      '<plist><array><string>a</string></dict></plist>',
      '<plist><dict></array></plist>',
      '<plist><dict/>',
      '<string>a<b/></string>',
      '<string>a',
      '<unknown>a</unknown>',
      '</string>',
      '<string>a</string> stray',
      '<![bad',
    ])
      should(parsePlist(broken)).equal(undefined);
  });

  it('answers no string where the path leaves the dictionaries or ends on another shape', () => {
    const value = parsePlist('<dict><key>A</key><dict><key>B</key><integer>1</integer></dict></dict>');
    should(plistString(value, 'A', 'B')).equal(undefined);
    should(plistString(value, 'A', 'B', 'C')).equal(undefined);
    should(plistString(value, 'Z')).equal(undefined);
    should(plistString(undefined, 'A')).equal(undefined);
  });
});

describe('the service definitions this CLI writes and reads back', () => {
  const spec: ServiceDefinitionSpec = {
    daemonBinary: '/opt/fyd',
    stateHome: '/home/ada/.ferretry',
    userHome: '/home/ada',
    logFile: '/home/ada/.ferretry/logs/fyd.log',
    searchPath: '/usr/bin',
    locale: { LANG: 'C.UTF-8' },
    runtime: {},
    description: 'fyd — per-host agent daemon',
  };

  it('reads the state home back out of the unit it wrote, whatever the characters in it', () => {
    const odd = '/home/a "b"\\c%d\te';
    should(systemdUnitStateHome(renderSystemdUnit({ ...spec, stateHome: odd }))).equal(odd);
    should(launchAgentStateHome(renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd', stateHome: odd }))).equal(
      odd,
    );
  });

  it('names no state home for a unit that has none, or one it could not have written', () => {
    should(systemdUnitStateHome('[Service]\nEnvironment="PATH=/usr/bin"\nRestart=always')).equal(undefined);
    should(systemdUnitStateHome('Environment=FY_HOME=/unquoted')).equal(undefined);
    should(systemdUnitStateHome('Environment="FY_HOME=/a\\q"')).equal(undefined);
    should(systemdUnitStateHome('Environment="FY_HOME=/a"b"')).equal(undefined);
    should(systemdUnitStateHome('Environment="FY_HOME=/a%b"')).equal(undefined);
    should(systemdUnitStateHome('Environment="FY_HOME=/a%%b\\n"')).equal('/a%b\n');
  });

  it('reads the process type a plist declares, or none', () => {
    should(launchAgentProcessType(renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd' }))).equal('Interactive');
    should(launchAgentProcessType('<plist><dict><key>Label</key><string>x</string></dict></plist>')).equal(undefined);
  });

  it('refuses a newline in the log path and a control character in a plist value, saying which field', () => {
    should(() => renderSystemdUnit({ ...spec, logFile: '/a\n/b' })).throw(
      'cannot write the service definition: the log path may not contain a newline',
    );
    should(() => renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd', searchPath: '/a\u0001b' })).throw(
      /cannot write the service definition: .* may not contain a control character/u,
    );
  });
});
