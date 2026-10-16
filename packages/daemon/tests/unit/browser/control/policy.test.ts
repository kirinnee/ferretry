import { describe, it } from 'bun:test';
import should from 'should';
import {
  BrowserControlError,
  browserEnvironment,
  browserLoginChromeArguments,
  chromeExecutableCandidates,
  chromeInstallCommand,
  chromeLaunchArguments,
  generateVncPassword,
  loginWindowMinutes,
  normalizeBrowserUrl,
  normalizeViewport,
  selectChromeExecutable,
  vncSupervisorArguments,
  x11vncLaunchArguments,
} from '../../../../src/lib/index.ts';

describe('browser control policy', () => {
  it('should accept safe browser URLs and refuse active or local schemes', () => {
    // Act + Assert
    should(normalizeBrowserUrl('example.com/docs')).equal('https://example.com/docs');
    should(normalizeBrowserUrl('localhost:5173')).equal('http://localhost:5173/');
    should(normalizeBrowserUrl('about:blank')).equal('about:blank');
    for (const value of ['', 'http://[', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings']) {
      should(() => normalizeBrowserUrl(value)).throw(BrowserControlError);
    }
  });

  it('should create an explicit, scrubbed browser environment', () => {
    // Act
    const actual = browserEnvironment(':99', { PATH: '/bin', HOME: '/safe', DISPLAY: ':0', FY_TOKEN: 'secret' });

    // Assert
    should(actual).deepEqual({ PATH: '/bin', HOME: '/safe', DISPLAY: ':99' });
    should(browserEnvironment(undefined, { FY_TOKEN: 'secret' })).deepEqual({});
  });

  it('should select Chrome deterministically and fail closed when it is unavailable', () => {
    // Act + Assert
    should(chromeExecutableCandidates('darwin')[0]).match(/Google Chrome/);
    should(chromeExecutableCandidates('linux')).containEql('/usr/bin/google-chrome');
    should(selectChromeExecutable('linux', '/custom/chrome', value => value === '/custom/chrome')).equal(
      '/custom/chrome',
    );
    let unavailable: unknown;
    try {
      selectChromeExecutable('linux', undefined, () => false);
    } catch (error) {
      unavailable = error;
    }
    should(unavailable).instanceOf(BrowserControlError);
    should((unavailable as BrowserControlError).message).match(/FY_CHROME_BIN/);
  });

  it('should retain the Linux browser fingerprint while making human login unreachable over CDP', () => {
    // Act
    const agent = chromeLaunchArguments('/chrome', '/profile', 9222, { width: 1280, height: 800 }, 'linux');
    const human = browserLoginChromeArguments('/chrome', '/profile', 'linux');

    // Assert
    should(agent).containEql('--remote-debugging-address=127.0.0.1');
    should(agent).containEql('--no-sandbox');
    should(agent).containEql('--password-store=basic');
    should(human.some(argument => argument.startsWith('--remote-debugging'))).be.false();
    should(human).containEql('https://accounts.google.com/');
    should(chromeLaunchArguments('/chrome', '/profile', 1, { width: 320, height: 240 }, 'darwin')).containEql(
      '--headless=new',
    );
  });

  it('should look for a browser in the per-user, snap and PATH locations a fixed list misses', () => {
    // Act
    const linux = chromeExecutableCandidates('linux', undefined, { path: '/home/u/.nix-profile/bin/:relative/bin' });
    const mac = chromeExecutableCandidates('darwin', undefined, { home: '/Users/u' });

    // Assert — PATH directories are searched by every browser name, relative entries never.
    should(linux).containEql('/snap/bin/chromium');
    should(linux).containEql('/home/u/.nix-profile/bin/google-chrome');
    should(linux).containEql('/home/u/.nix-profile/bin/chromium');
    should(linux.some(candidate => candidate.startsWith('relative'))).be.false();
    should(new Set(linux).size).equal(linux.length);
    should(mac).containEql('/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    should(chromeExecutableCandidates('linux', ' /opt/chrome ', { path: '/usr/bin' })).deepEqual(['/opt/chrome']);
  });

  it('should name the one install command this machine can run when no browser exists', () => {
    // Arrange
    const has =
      (...managers: string[]) =>
      (command: string) =>
        managers.includes(command);

    // Act + Assert — the first manager present wins; snap outranks apt because Ubuntu ships Chromium as a snap.
    should(chromeInstallCommand('darwin', has())).equal('brew install --cask google-chrome');
    should(chromeInstallCommand('linux', has('apt-get', 'snap'))).equal('sudo snap install chromium');
    should(chromeInstallCommand('linux', has('apt-get'))).equal('sudo apt-get install -y chromium');
    should(chromeInstallCommand('linux', has('dnf'))).equal('sudo dnf install -y chromium');
    should(chromeInstallCommand('linux', has('pacman'))).equal('sudo pacman -S --noconfirm chromium');
    should(chromeInstallCommand('linux', has('zypper'))).equal('sudo zypper install -y chromium');
    should(chromeInstallCommand('linux', has('nix'))).equal('nix profile install nixpkgs#chromium');
    should(chromeInstallCommand('linux', has())).be.undefined();
  });

  it('should refuse a missing browser with one plain sentence naming the install command', () => {
    // Act
    const refusal = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        should(error).instanceOf(BrowserControlError);
        return (error as BrowserControlError).message;
      }
      throw new Error('expected a refusal');
    };

    // Assert
    should(
      refusal(() =>
        selectChromeExecutable('linux', undefined, () => false, { available: command => command === 'apt-get' }),
      ),
    ).equal(
      'Chrome is not installed on this machine: install it with `sudo apt-get install -y chromium`, or set FY_CHROME_BIN to its path.',
    );
    should(refusal(() => selectChromeExecutable('darwin', undefined, () => false))).containEql(
      '`brew install --cask google-chrome`',
    );
    should(refusal(() => selectChromeExecutable('linux', undefined, () => false))).equal(
      'Chrome is not installed on this machine: install Google Chrome or Chromium, or set FY_CHROME_BIN to its path.',
    );
    should(refusal(() => selectChromeExecutable('linux', '/nope/chrome', () => false))).equal(
      'FY_CHROME_BIN points at /nope/chrome, which does not exist.',
    );
  });

  it('should run a Linux browser headless, without the X11 platform, only when asked to', () => {
    // Act
    const headed = chromeLaunchArguments('/chrome', '/profile', 1, { width: 320, height: 240 }, 'linux');
    const headless = chromeLaunchArguments('/chrome', '/profile', 1, { width: 320, height: 240 }, 'linux', {
      headless: true,
    });

    // Assert
    should(headed).containEql('--ozone-platform=x11');
    should(headed).not.containEql('--headless=new');
    should(headless).containEql('--headless=new');
    should(headless).not.containEql('--ozone-platform=x11');
    should(headless).containEql('--no-sandbox');
  });

  it('should bound login duration and build loopback-only VNC supervision commands', () => {
    // Act
    const vnc = x11vncLaunchArguments('x11vnc', ':99', 5901, '/run/password', 0.1);
    const supervised = vncSupervisorArguments('timeout', 0.1, vnc, 0.1);

    // Assert
    should(loginWindowMinutes()).equal(15);
    should(loginWindowMinutes(60)).equal(60);
    for (const invalid of [0, 61, 1.5, Number.NaN])
      should(() => loginWindowMinutes(invalid)).throw(BrowserControlError);
    should(vnc).deepEqual([
      'x11vnc',
      '-display',
      ':99',
      '-rfbport',
      '5901',
      '-listen',
      '127.0.0.1',
      '-localhost',
      '-noipv6',
      '-passwdfile',
      'rm:/run/password',
      '-once',
      '-timeout',
      '1',
      '-noremote',
      '-nocmds',
      '-nolookup',
      '-quiet',
    ]);
    should(supervised.slice(0, 4)).deepEqual(['timeout', '--signal=TERM', '--kill-after=1', '1']);
  });

  it('should generate unbiased eight-character passwords and normalize finite viewports', () => {
    // Act
    const password = generateVncPassword(buffer => buffer.fill(255).fill(0, 0, 8));

    // Assert
    should(password).equal('aaaaaaaa');
    should(normalizeViewport(100.7, 9000)).deepEqual({ width: 320, height: 1200 });
    should(() => normalizeViewport(Number.NaN, 800)).throw(BrowserControlError);
  });
});
