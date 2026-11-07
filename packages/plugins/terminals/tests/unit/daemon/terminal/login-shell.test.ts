import { describe, it } from 'bun:test';
import should from 'should';
import {
  chooseLoginShell,
  describeShellChoice,
  directoryServiceShell,
  FALLBACK_LOGIN_SHELL,
  listedShells,
  type LoginShellSource,
  passwdShell,
} from '../../../src/lib/terminal/login-shell.ts';

const PASSWD = [
  '# comment',
  'root:x:0:0:root:/root:/bin/bash',
  'kirin:x:1000:1000:Kirin,,,:/home/kirin:/usr/bin/zsh',
  'svc:x:998:998::/nonexistent:/usr/sbin/nologin',
  'bare:x:997:997::/home/bare:',
].join('\n');

const SHELLS = ['# /etc/shells', '', '/bin/sh', '/bin/bash', '/usr/bin/zsh', '/usr/sbin/nologin', 'not-absolute'].join(
  '\n',
);

const everything = async (): Promise<boolean> => true;

describe('passwdShell', () => {
  it('should read the shell of the entry whose uid matches', () => {
    should(passwdShell(PASSWD, 1000)).equal('/usr/bin/zsh');
    should(passwdShell(PASSWD, 0)).equal('/bin/bash');
  });

  it.each([[4242], [997]])('should answer nothing for uid %d, which has no usable entry', uid => {
    should(passwdShell(PASSWD, uid)).be.undefined();
  });

  it('should not mistake the uid for the gid or another numeric field', () => {
    should(passwdShell('a:x:1:1000:::/bin/bash', 1000)).be.undefined();
  });
});

describe('directoryServiceShell', () => {
  it('should read the UserShell line dscl prints', () => {
    should(directoryServiceShell('UserShell: /bin/zsh\n')).equal('/bin/zsh');
  });

  it.each([[''], ['<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)\n'], ['RealName: A\n']])(
    'should answer nothing for %j',
    output => {
      should(directoryServiceShell(output)).be.undefined();
    },
  );
});

describe('listedShells', () => {
  it('should keep absolute paths and drop comments, blanks and anything else', () => {
    should([...listedShells(SHELLS)]).deepEqual(['/bin/sh', '/bin/bash', '/usr/bin/zsh', '/usr/sbin/nologin']);
  });
});

describe('chooseLoginShell', () => {
  const listed = listedShells(SHELLS);

  it('should prefer the first candidate that is listed and runnable', async () => {
    // Act
    const choice = await chooseLoginShell(
      [
        { source: 'config', path: '/bin/bash' },
        { source: 'passwd', path: '/usr/bin/zsh' },
      ],
      listed,
      everything,
    );

    // Assert
    should(choice).deepEqual({ shell: '/bin/bash', source: 'config', rejected: [] });
  });

  it('should skip a candidate /etc/shells does not list and say why', async () => {
    // Act
    const choice = await chooseLoginShell(
      [
        { source: 'config', path: '/opt/evil/shell' },
        { source: 'passwd', path: '/usr/bin/zsh' },
      ],
      listed,
      everything,
    );

    // Assert
    should(choice.shell).equal('/usr/bin/zsh');
    should(choice.source).equal('passwd');
    should(choice.rejected).deepEqual([
      { source: 'config', path: '/opt/evil/shell', reason: 'it is not listed in /etc/shells' },
    ]);
  });

  it('should skip a listed path that is not an executable file', async () => {
    // Act
    const choice = await chooseLoginShell(
      [
        { source: 'passwd', path: '/usr/bin/zsh' },
        { source: 'environment', path: '/bin/bash' },
      ],
      listed,
      async path => path !== '/usr/bin/zsh',
    );

    // Assert
    should(choice.shell).equal('/bin/bash');
    should(choice.rejected.map(entry => entry.reason)).deepEqual(['it is not an executable file']);
  });

  it.each([
    ['bin/bash', 'it is not an absolute path'],
    ['/bin/bash -c evil', 'it contains whitespace or a control character'],
    ['/usr/sbin/nologin', 'nologin is not an interactive shell'],
  ])('should refuse %j before consulting anything else', async (path, reason) => {
    // Act
    const choice = await chooseLoginShell([{ source: 'passwd', path }], listed, everything);

    // Assert
    should(choice.shell).equal(FALLBACK_LOGIN_SHELL);
    should(choice.rejected).deepEqual([{ source: 'passwd', path, reason }]);
  });

  it('should accept nothing but the fallback when /etc/shells cannot be read', async () => {
    // Act
    const choice = await chooseLoginShell([{ source: 'passwd', path: '/usr/bin/zsh' }], undefined, everything);

    // Assert
    should(choice.shell).equal('/bin/sh');
    should(choice.source).be.undefined();
    should(choice.rejected[0]?.reason).equal('/etc/shells could not be read');
  });

  it('should fall back to /bin/sh when there are no candidates at all', async () => {
    should(await chooseLoginShell([], listed, everything)).deepEqual({ shell: '/bin/sh', rejected: [] });
  });
});

describe('describeShellChoice', () => {
  it('should stay silent when the first candidate was simply used', () => {
    should(describeShellChoice({ shell: '/usr/bin/zsh', source: 'passwd', rejected: [] })).be.undefined();
  });

  it('should say why a candidate was refused and what opens instead', () => {
    // Act
    const line = describeShellChoice({
      shell: '/usr/bin/zsh',
      source: 'passwd',
      rejected: [{ source: 'config', path: '/opt/x', reason: 'it is not listed in /etc/shells' }],
    });

    // Assert
    should(line).equal(
      'terminals: /opt/x from terminals.shell in config/daemon.json was not used because it is not listed in /etc/shells; terminals open /usr/bin/zsh.',
    );
  });

  it('should say it fell back when nothing was found or accepted', () => {
    // Each source is named the way the owner would look for it.
    const named = (source: LoginShellSource): string | undefined =>
      describeShellChoice({
        shell: '/bin/sh',
        rejected: [{ source, path: '/x', reason: 'it is not an executable file' }],
      });
    should(named('passwd')).containEql('from the passwd entry');
    should(named('directory-service')).containEql('from the directory service');
    should(named('environment')).containEql('from $SHELL');
    should(describeShellChoice({ shell: '/bin/sh', rejected: [] })).match(/no login shell was found.*\/bin\/sh/u);
    should(
      describeShellChoice({
        shell: '/bin/sh',
        rejected: [{ source: 'environment', path: '/x/y', reason: 'it is not an executable file' }],
      }),
    ).match(/\$SHELL.*not an executable file.*\/bin\/sh \(the fallback\)/u);
  });
});
