import { describe, it } from 'bun:test';
import should from 'should';
import {
  EXIT_ALREADY_RUNNING,
  InvalidUnitValueError,
  renderLaunchAgentPlist,
  renderSystemdUnit,
  systemdFileSpecifier,
  systemdQuote,
  xmlText,
} from '../../../src/lib/daemon/unit-file';

const spec = {
  daemonBinary: '/opt/fy/bin/fyd',
  stateHome: '/tmp/fy-home/.ferretry',
  logFile: '/tmp/fy-home/.ferretry/logs/fyd.log',
  searchPath: '/usr/bin:/bin',
  description: 'fyd — per-host agent daemon',
};

describe('systemd file specifier', () => {
  it('should double a percent so systemd does not expand it as a specifier', () => {
    // Act + Assert — an unexpanded `%h` would silently retarget the log at the manager's home.
    should(systemdFileSpecifier('/tmp/100%/log', 'the log path')).equal('/tmp/100%%/log');
  });

  it('should leave an ordinary path untouched', () => {
    // Act + Assert
    should(systemdFileSpecifier('/var/log/fyd.log', 'the log path')).equal('/var/log/fyd.log');
  });

  it('should refuse a newline, which cannot be escaped in an unquoted setting', () => {
    // Act + Assert
    should(() => systemdFileSpecifier('/tmp/a\nb', 'the log path')).throw(/the log path may not contain a newline/u);
    should(() => systemdFileSpecifier('/tmp/a\rb', 'the log path')).throw(/may not contain a newline/u);
  });

  it('should name the field on the error it throws', () => {
    // Act
    let caught: unknown;
    try {
      systemdFileSpecifier('a\nb', 'the description');
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(InvalidUnitValueError);
    should((caught as InvalidUnitValueError).field).equal('the description');
  });
});

describe('systemd quoting', () => {
  it('should escape every character systemd treats specially inside a quoted value', () => {
    // Act
    const actual = systemdQuote('a"b\\c\nd\re\tf%g');

    // Assert
    should(actual).equal('"a\\"b\\\\c\\nd\\re\\tf%%g"');
  });

  it('should wrap a plain value in quotes so a space cannot split it into two arguments', () => {
    // Act + Assert
    should(systemdQuote('/opt/my daemon/fyd')).equal('"/opt/my daemon/fyd"');
  });
});

describe('xml text', () => {
  it('should escape all five predefined entities', () => {
    // Act + Assert
    should(xmlText(`&<>"'`, 'the label')).equal('&amp;&lt;&gt;&quot;&apos;');
  });

  it('should permit the three control characters XML 1.0 can represent', () => {
    // Act + Assert
    should(xmlText('a\tb\nc\rd', 'the label')).equal('a\tb\nc\rd');
  });

  it('should refuse a control character no XML escape can express', () => {
    // Act + Assert — kteam escaped only the entities, so this produced a plist launchctl could not parse.
    should(() => xmlText('a\u0000b', 'PATH')).throw(/PATH may not contain a control character/u);
    should(() => xmlText('a\u001fb', 'PATH')).throw(/may not contain a control character/u);
    should(() => xmlText('a\u000bb', 'PATH')).throw(/may not contain a control character/u);
  });
});

describe('systemd unit rendering', () => {
  it('should write the log specifier unquoted, so systemd can parse it structurally', () => {
    // Act
    const actual = renderSystemdUnit(spec);

    // Assert — quoting this is what silently froze kteam's daemon log at a five-day-old fossil.
    should(actual).match(/^StandardOutput=append:\/tmp\/fy-home\/\.ferretry\/logs\/fyd\.log$/mu);
    should(actual).match(/^StandardError=append:\/tmp\/fy-home\/\.ferretry\/logs\/fyd\.log$/mu);
  });

  it('should quote the executable and both environment assignments', () => {
    // Act
    const actual = renderSystemdUnit(spec);

    // Assert
    should(actual).match(/^ExecStart="\/opt\/fy\/bin\/fyd"$/mu);
    should(actual).match(/^Environment="FY_HOME=\/tmp\/fy-home\/\.ferretry"$/mu);
    should(actual).match(/^Environment="PATH=\/usr\/bin:\/bin"$/mu);
  });

  it('should refuse to restart on either address-is-taken exit code', () => {
    // Act
    const actual = renderSystemdUnit(spec);

    // Assert — BOTH codes, because respawning fixes neither. 78 is another of these daemons already
    // serving; 69 is a different program holding the address, which no restart can take from it.
    should(actual).match(new RegExp(`^RestartPreventExitStatus=${String(EXIT_ALREADY_RUNNING)} 69$`, 'mu'));
    should(EXIT_ALREADY_RUNNING).equal(78);
  });

  it('should signal only the daemon, so the multiplexer server survives a restart', () => {
    // Act
    const actual = renderSystemdUnit(spec);

    // Assert — the default control-group kill erased the whole fleet on every restart.
    should(actual).match(/^KillMode=process$/mu);
  });

  it('should declare the install target so `enable` has something to link', () => {
    // Act
    const actual = renderSystemdUnit(spec);

    // Assert
    should(actual).match(/^\[Install\]\nWantedBy=default\.target$/mu);
  });

  it('should refuse a log path containing a newline rather than emit a corrupt unit', () => {
    // Act + Assert
    should(() => renderSystemdUnit({ ...spec, logFile: '/tmp/a\nb' })).throw(/may not contain a newline/u);
  });

  it('should run the daemon EXECUTABLE, so a supervised start can never reach an interactive prompt', () => {
    // WHY THIS IS ASSERTED AND NOT ASSUMED. `fy daemon start` offers to set the machine's first operator
    // password when a person is there to answer. A unit whose `ExecStart` ran that command instead of the
    // daemon would put that offer inside a systemd start — with no terminal, and nobody to answer — and
    // the machine would silently stop running the daemon at login. Both service managers launch the
    // executable and nothing else, which is what makes that structurally impossible rather than careful.
    // Act
    const unit = renderSystemdUnit(spec);
    const plist = renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd' });

    // Assert — one argument, and it is the daemon.
    should(unit).match(/^ExecStart="\/opt\/fy\/bin\/fyd"$/mu);
    should(plist).containEql('<array><string>/opt/fy/bin/fyd</string></array>');
    // No CLI verb anywhere in either definition: not as the program, not as an argument to it.
    should(unit).not.match(/daemon start/u);
    should(plist).not.match(/daemon start/u);
  });
});

describe('launch agent rendering', () => {
  it('should name the job and its executable', () => {
    // Act
    const actual = renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd' });

    // Assert
    should(actual).containEql('<key>Label</key><string>com.ferretry.fyd</string>');
    should(actual).containEql('<array><string>/opt/fy/bin/fyd</string></array>');
  });

  it('should abandon the process group, mirroring KillMode=process on Linux', () => {
    // Act
    const actual = renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd' });

    // Assert
    should(actual).containEql('<key>AbandonProcessGroup</key><true/>');
  });

  it('should throttle respawns, because launchd has no RestartPreventExitStatus', () => {
    // Act
    const actual = renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd' });

    // Assert
    should(actual).containEql('<key>ThrottleInterval</key><integer>10</integer>');
  });

  it('should pass the state home and PATH as environment variables', () => {
    // Act
    const actual = renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd' });

    // Assert
    should(actual).containEql('<key>FY_HOME</key><string>/tmp/fy-home/.ferretry</string>');
    should(actual).containEql('<key>PATH</key><string>/usr/bin:/bin</string>');
  });

  it('should escape a path that would otherwise break the XML', () => {
    // Act
    const actual = renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd', daemonBinary: '/opt/a&b/fyd' });

    // Assert
    should(actual).containEql('<array><string>/opt/a&amp;b/fyd</string></array>');
  });

  it('should refuse a control character anywhere in the definition', () => {
    // Act + Assert
    should(() => renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd', searchPath: '/a\u0001b' })).throw(
      /PATH may not contain a control character/u,
    );
    should(() => renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd', stateHome: '/a\u0001b' })).throw(
      /the state home may not contain a control character/u,
    );
    should(() => renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd', logFile: '/a\u0001b' })).throw(
      /the log path may not contain a control character/u,
    );
  });

  it('should end with a newline, as a plist file must', () => {
    // Act
    const actual = renderLaunchAgentPlist({ ...spec, label: 'com.ferretry.fyd' });

    // Assert
    should(actual.endsWith('</dict></plist>\n')).be.true();
  });
});
