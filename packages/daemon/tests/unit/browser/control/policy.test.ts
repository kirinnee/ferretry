import { describe, it } from 'bun:test';
import should from 'should';
import {
  AUTOMATION_SWITCH_PATTERN,
  CDP_PIPE_SWITCH,
  defaultCdpTransport,
  agentBrowserArguments,
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
  xvfbInstallCommand,
  xvfbMissingMessage,
} from '../../../../src/lib/index.ts';

/** The default transport, on a fixed number so an assertion can name it. */
const PORT = { kind: 'port', port: 9222 } as const;

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

  it("should give an X client the private display's cookie file and never the host's own", () => {
    // Act
    const actual = browserEnvironment(
      ':99',
      { PATH: '/bin', XAUTHORITY: '/home/operator/.Xauthority' },
      '/state/x11/xauthority',
    );

    // Assert
    should(actual).deepEqual({ PATH: '/bin', DISPLAY: ':99', XAUTHORITY: '/state/x11/xauthority' });
    should(browserEnvironment(':99', { XAUTHORITY: '/home/operator/.Xauthority' })).deepEqual({ DISPLAY: ':99' });
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
    const agent = chromeLaunchArguments('/chrome', '/profile', PORT, { width: 1280, height: 800 }, 'linux');
    const human = browserLoginChromeArguments('/chrome', '/profile', 'linux');

    // Assert
    should(agent).containEql('--remote-debugging-address=127.0.0.1');
    should(agent).containEql('--no-sandbox');
    should(agent).containEql('--password-store=basic');
    should(human.some(argument => argument.startsWith('--remote-debugging'))).be.false();
    should(human).containEql('https://accounts.google.com/');
    should(
      chromeLaunchArguments('/chrome', '/profile', { kind: 'port', port: 1 }, { width: 320, height: 240 }, 'darwin'),
    ).containEql('--headless=new');
  });

  it('should turn the back/forward cache off, in the one --disable-features flag Chrome reads', () => {
    // Act
    const agent = chromeLaunchArguments('/chrome', '/profile', PORT, { width: 1280, height: 800 }, 'linux');
    const features = agent.filter(argument => argument.startsWith('--disable-features='));

    // Assert — a restored page would bring back its whole heap, a password a grant fill typed included.
    should(features).have.length(1);
    should(features[0]?.split('=')[1]?.split(',')).containEql('BackForwardCache');
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
    const headed = chromeLaunchArguments(
      '/chrome',
      '/profile',
      { kind: 'port', port: 1 },
      { width: 320, height: 240 },
      'linux',
    );
    const headless = chromeLaunchArguments(
      '/chrome',
      '/profile',
      { kind: 'port', port: 1 },
      { width: 320, height: 240 },
      'linux',
      {
        headless: true,
      },
    );

    // Assert
    should(headed).containEql('--ozone-platform=x11');
    should(headed).not.containEql('--headless=new');
    should(headless).containEql('--headless=new');
    should(headless).not.containEql('--ozone-platform=x11');
    should(headless).containEql('--no-sandbox');
  });

  it('should put the real Google Chrome ahead of any Chromium, wherever each was found', () => {
    // Act
    const linux = chromeExecutableCandidates('linux', undefined, { path: '/nix/bin' });
    const mac = chromeExecutableCandidates('darwin', undefined, { home: '/Users/u' });
    const chosen = selectChromeExecutable(
      'linux',
      undefined,
      candidate => candidate === '/usr/bin/chromium' || candidate === '/nix/bin/google-chrome',
      { path: '/nix/bin' },
    );

    // Assert — a Chromium in /usr/bin no longer shadows a Google Chrome on PATH.
    should(chosen).equal('/nix/bin/google-chrome');
    should(linux.indexOf('/opt/google/chrome/chrome')).be.below(linux.indexOf('/usr/bin/chromium'));
    should(linux.indexOf('/nix/bin/google-chrome-stable')).be.below(linux.indexOf('/snap/bin/chromium'));
    should(mac).deepEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
    should(chromeExecutableCandidates('darwin')).deepEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  });

  it('should give the agent browser no debugging port when the pipe is chosen, in any mode, with any extras', () => {
    // Every account on the host can reach a loopback port, and the DevTools protocol asks nobody who they
    // are: a port hands the owner's signed-in profile to all of them. The pipe has no address at all.
    const viewport = { width: 1280, height: 800 };
    const extras = { userAgent: 'Mozilla/5.0', proxy: { server: 'http://127.0.0.1:1', bypass: ['<local>'] } };
    for (const platform of ['linux', 'darwin'] as const) {
      for (const mode of ['headless', 'window'] as const) {
        for (const argv of [
          agentBrowserArguments('/chrome', '/profile', { kind: 'pipe' }, viewport, platform, mode),
          agentBrowserArguments('/chrome', '/profile', { kind: 'pipe' }, viewport, platform, mode, extras),
        ]) {
          should(argv.filter(argument => argument.startsWith('--remote-debugging'))).deepEqual([CDP_PIPE_SWITCH]);
          should(argv.filter(argument => argument.startsWith('--remote-allow-origins'))).deepEqual([]);
          should(argv.filter(argument => AUTOMATION_SWITCH_PATTERN.test(argument))).deepEqual([]);
        }
      }
    }
  });

  it('should default to the port on every platform: the pipe is only ever chosen', () => {
    should(defaultCdpTransport()).equal('port');
    should(
      agentBrowserArguments('/chrome', '/profile', PORT, { width: 1280, height: 800 }, 'linux', 'window'),
    ).not.containEql(CDP_PIPE_SWITCH);
  });

  it('should allow the DevTools pipe and still refuse every switch that says or hides automation', () => {
    // The pipe is the transport, not a switch Ferretry adds to announce automation or to hide it.
    should(AUTOMATION_SWITCH_PATTERN.test(CDP_PIPE_SWITCH)).be.false();
    should(CDP_PIPE_SWITCH).equal('--remote-debugging-pipe');
    // What a driver such as Playwright adds when IT launches Chrome — and what hides automation — stay out.
    for (const forbidden of [
      '--enable-automation',
      '--disable-blink-features=AutomationControlled',
      '--disable-blink-features=IdleDetection,AutomationControlled',
    ]) {
      should(AUTOMATION_SWITCH_PATTERN.test(forbidden)).be.true();
    }
  });

  it('should launch the agent browser headless or as a real window, never with an automation switch', () => {
    // Act
    const viewport = { width: 1280, height: 800 };
    const launches = {
      linuxHeadless: agentBrowserArguments('/chrome', '/profile', PORT, viewport, 'linux', 'headless'),
      linuxWindow: agentBrowserArguments('/chrome', '/profile', PORT, viewport, 'linux', 'window'),
      macHeadless: agentBrowserArguments('/chrome', '/profile', PORT, viewport, 'darwin', 'headless'),
      macWindow: agentBrowserArguments('/chrome', '/profile', PORT, viewport, 'darwin', 'window'),
    };
    const keepPainting = [
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ];

    // Assert — every mode keeps the loopback debugging port the view streams through, and none says or
    // hides that it is automated.
    for (const argv of Object.values(launches)) {
      should(argv).containEql('--remote-debugging-address=127.0.0.1');
      should(argv).containEql('--remote-debugging-port=9222');
      should(argv).containEql('--user-data-dir=/profile');
      should(argv.filter(argument => AUTOMATION_SWITCH_PATTERN.test(argument))).deepEqual([]);
      should(argv.filter(argument => /automation/i.test(argument))).deepEqual([]);
    }
    // Headless is what it always was.
    should(launches.linuxHeadless).containEql('--headless=new');
    should(launches.macHeadless).containEql('--headless=new');
    should(launches.linuxHeadless).not.containEql('--disable-renderer-backgrounding');
    // A real window: no headless flag (so no HeadlessChrome user agent), drawing on X11 on Linux, and every
    // window keeps painting while another has focus.
    for (const argv of [launches.linuxWindow, launches.macWindow]) {
      should(argv.some(argument => argument.startsWith('--headless'))).be.false();
      for (const flag of keepPainting) should(argv).containEql(flag);
    }
    should(launches.linuxWindow).containEql('--ozone-platform=x11');
    should(launches.macWindow).not.containEql('--ozone-platform=x11');
  });

  it('should name what installs Xvfb, or say to install it, when a Linux real window has no display', () => {
    // Arrange
    const has =
      (...managers: string[]) =>
      (command: string) =>
        managers.includes(command);

    // Act + Assert
    should(xvfbInstallCommand(has('apt-get', 'nix'))).equal('sudo apt-get install -y xvfb');
    should(xvfbInstallCommand(has('dnf'))).equal('sudo dnf install -y xorg-x11-server-Xvfb');
    should(xvfbInstallCommand(has('pacman'))).equal('sudo pacman -S --noconfirm xorg-server-xvfb');
    should(xvfbInstallCommand(has('zypper'))).equal('sudo zypper install -y xvfb-run');
    should(xvfbInstallCommand(has('nix'))).equal('nix profile install nixpkgs#xvfb');
    should(xvfbInstallCommand(has())).be.undefined();
    should(xvfbMissingMessage(has('apt-get'))).equal(
      'Browser mode is Real window, which needs Xvfb on Linux and this host has none: install it with `sudo apt-get install -y xvfb`, or set Browser mode back to Headless.',
    );
    should(xvfbMissingMessage(has())).equal(
      'Browser mode is Real window, which needs Xvfb on Linux and this host has none: install Xvfb, or set Browser mode back to Headless.',
    );
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
