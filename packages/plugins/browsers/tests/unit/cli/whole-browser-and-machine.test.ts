import { beforeEach, describe, it } from 'bun:test';
import should from 'should';
import { FIREWALL_ENTRY_GAP } from '../../../cli/lib/verbs/machine.ts';
import { cliWorld, FakeDaemon, type Recorded } from '../../support/cli.ts';

const BROWSER = 'POST /v1/ferrets/:ferretId/browser';
const PAGE = {
  url: 'https://x.test/',
  title: 'Home',
  pages: [{ id: 'p1', url: 'https://x.test/', title: 'Home' }],
  activePageId: 'p1',
  pageState: 'ready',
  canGoBack: false,
  canGoForward: false,
};
const STATUS = {
  sessionId: 'f1',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 600,
  capacity: { running: 1, maximum: 3 },
  state: 'running',
  ...PAGE,
};

/** A secret reference as the daemon reads it: the NAME in the CLI's words, never a value. */
const secretRef = (name: string): string => `\${secret:${name}}`;

let daemon: FakeDaemon;
beforeEach(() => {
  daemon = new FakeDaemon();
});

const bodies = (): unknown[] => daemon.calls.map(call => (call as Extract<Recorded, { via: 'route' }>).init?.body);

describe('the per-ferret browser verbs', () => {
  it('should read the status of the ferret this runs inside', async () => {
    // Arrange
    daemon.answer('GET /v1/ferrets/:ferretId/browser', STATUS);
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'status']);

    // Assert
    should(code).equal(0);
    should(world.stdout()).equal(
      'f1  browser running  1280x800  viewers 1/3\nprofile persistent · idle timeout 600s\n* p1  Home  https://x.test/\npage ready · back no · forward no\n',
    );
    should((daemon.calls[0] as { init: unknown }).init).deepEqual({ params: { ferretId: 'f1' } });
  });

  it('should act on the ferret --ferret names, above the one it runs inside', async () => {
    // Arrange
    daemon.answer(BROWSER, { status: STATUS, result: { ...PAGE, actedPageId: 'p1' } });
    const world = cliWorld(daemon, { ownFerret: 'own' });

    // Act
    const code = await world.run(['browser', 'navigate', 'https://x.test/', '--ferret', 'f9']);

    // Assert
    should(code).equal(0);
    should((daemon.calls[0] as { init: unknown }).init).deepEqual({
      params: { ferretId: 'f9' },
      body: { action: 'navigate', url: 'https://x.test/' },
    });
    should(world.stdout()).equal('Home\nhttps://x.test/\n');
  });

  it('should say a ferret is needed when it runs inside none and none is named', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'status']);

    // Assert
    should(code).equal(2);
    should(world.stderr()).equal('no ferret id; run inside a ferret or pass --ferret <id>\n');
  });

  it('should send each lifecycle and page act as its action', async () => {
    // Arrange
    daemon.answer(BROWSER, { status: STATUS });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    for (const line of [
      ['start'],
      ['stop'],
      ['back'],
      ['forward'],
      ['reload'],
      ['open', 'https://x.test/'],
      ['open'],
      ['new-page', 'https://y.test/'],
      ['activate-page', 'p2'],
      ['close-page', 'p2'],
      ['click', '#go'],
      ['read', 'main'],
      ['resize', '800', '600'],
    ])
      await world.run(['browser', ...line]);

    // Assert
    should(bodies()).deepEqual([
      { action: 'start' },
      { action: 'stop' },
      { action: 'back' },
      { action: 'forward' },
      { action: 'reload' },
      { action: 'open', url: 'https://x.test/' },
      { action: 'open' },
      { action: 'new-page', url: 'https://y.test/' },
      { action: 'activate-page', pageId: 'p2' },
      { action: 'close-page', pageId: 'p2' },
      { action: 'click', selector: '#go' },
      { action: 'read', selector: 'main' },
      { action: 'resize', width: 800, height: 600 },
    ]);
  });

  it('should print only the text a read fetched', async () => {
    // Arrange
    daemon.answer(BROWSER, { status: STATUS, result: { ...PAGE, actedPageId: 'p1', text: 'Welcome back' } });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    await world.run(['browser', 'read']);

    // Assert
    should(world.stdout()).equal('Welcome back\n');
  });

  it('should write a screenshot to the file and say so', async () => {
    // Arrange
    daemon.answer(BROWSER, {
      status: STATUS,
      result: {
        ...PAGE,
        actedPageId: 'p1',
        screenshotBase64: Buffer.from('PNGBYTES').toString('base64'),
        screenshotFormat: 'png',
      },
    });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'screenshot', 'shot.png']);

    // Assert
    should(code).equal(0);
    should(Buffer.from(world.files.get('shot.png') ?? new Uint8Array()).toString()).equal('PNGBYTES');
    should(world.stdout()).equal('screenshot written to shot.png\n');
  });

  it('should refuse a viewport outside the bounds before asking the daemon', async () => {
    // Arrange
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'resize', '1', '1']);

    // Assert
    should(code).equal(2);
    should(world.stderr()).containEql('width must be between');
    should(daemon.calls).have.length(0);
  });

  it('should say a refusal the daemon threw, and exit 1', async () => {
    // Arrange
    daemon.answer(BROWSER, () => {
      throw new Error('the browser is not running');
    });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'click', '#go']);

    // Assert
    should(code).equal(1);
    should(world.stderr()).equal('the browser is not running\n');
  });
});

describe('the sign-in window', () => {
  it('should read its status and print the connection when it is open', async () => {
    // Arrange
    daemon.answer('GET /v1/browser/login', {
      state: 'open',
      profilePrimed: false,
      openedAt: '2026-11-13T09:00:00.000Z',
      expiresAt: '2026-11-13T09:15:00.000Z',
      connection: { host: '127.0.0.1', port: 5901, password: 'one-shot', sshTunnel: 'ssh -L 5901:127.0.0.1:5901 host' },
    });
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'login', 'status']);

    // Assert
    should(code).equal(0);
    should(world.stdout()).equal(
      'browser login window: open\nopened 2026-11-13T09:00:00.000Z\ncloses 2026-11-13T09:15:00.000Z\nprofile primed: no\ntunnel: ssh -L 5901:127.0.0.1:5901 host\nthen point a VNC viewer at 127.0.0.1:5901\npassword: one-shot\n',
    );
  });

  it('should start, confirm and stop it with the options it was given', async () => {
    // Arrange
    daemon.answer('POST /v1/browser/login', { state: 'closed', profilePrimed: true });
    const world = cliWorld(daemon);

    // Act
    await world.run(['browser', 'login', 'start', '--minutes', '15']);
    await world.run(['browser', 'login', 'start', '-m', '5']);
    await world.run(['browser', 'login', 'confirm']);
    await world.run(['browser', 'login', 'stop', '--primed']);

    // Assert
    should(bodies()).deepEqual([
      { action: 'start', minutes: 15 },
      { action: 'start', minutes: 5 },
      { action: 'confirm' },
      { action: 'stop', primed: true },
    ]);
  });

  it('should take no ferret: it is the machine’s', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'login', 'status', '--ferret', 'f1']);

    // Assert
    should(code).equal(2);
    should(world.stderr()).containEql('browser login status has no option --ferret');
  });
});

describe('the proxy test', () => {
  it('should test the saved proxy, and exit 0 when it is reachable', async () => {
    // Arrange
    daemon.answer('POST /v1/browser/proxy/test', {
      reachable: true,
      tested: 'saved',
      roundTripMs: 42,
      egressIp: '203.0.113.7',
      message: 'Reached it.',
    });
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'proxy', 'test']);

    // Assert
    should(code).equal(0);
    should(bodies()).deepEqual([{}]);
    should(world.stdout()).equal('Proxy reachable via saved proxy in 42 ms; egress IP 203.0.113.7. Reached it.\n');
  });

  it('should test an unsaved proxy whose credentials are secret NAMES, and exit 1 in one line when it fails', async () => {
    // Arrange
    daemon.answer('POST /v1/browser/proxy/test', {
      reachable: false,
      tested: 'unsaved',
      errorClass: 'auth',
      message: 'The proxy refused the credentials.',
    });
    const world = cliWorld(daemon);

    // Act
    const code = await world.run([
      'browser',
      'proxy',
      'test',
      '--url',
      'http://proxy.test:8080',
      '--username-secret',
      'PROXY_USER',
      '--password-secret',
      'PROXY_PASS',
      '--bypass',
      'a.test,b.test',
    ]);

    // Assert
    should(code).equal(1);
    should(bodies()).deepEqual([
      {
        proxy: {
          url: 'http://proxy.test:8080',
          bypass: ['a.test', 'b.test'],
          username: secretRef('PROXY_USER'),
          password: secretRef('PROXY_PASS'),
        },
      },
    ]);
    should(world.stderr()).equal('Proxy test failed (auth): The proxy refused the credentials. [unsaved proxy]\n');
  });

  it('should refuse a pasted password where a secret NAME goes, without echoing it', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const code = await world.run([
      'browser',
      'proxy',
      'test',
      '--url',
      'http://proxy.test:8080',
      '--password-secret',
      'hunter2 pasted',
    ]);

    // Assert
    should(code).equal(2);
    should(world.stderr()).containEql('--password-secret');
    should(world.stderr()).not.containEql('hunter2 pasted');
  });

  it('should refuse a bypass list with no proxy to bypass', async () => {
    const world = cliWorld(daemon);
    should(await world.run(['browser', 'proxy', 'test', '--bypass', 'a.test'])).equal(2);
    should(world.stderr()).equal('--bypass, --username-secret and --password-secret need --url\n');
  });
});

describe('the loopback firewall', () => {
  it('should print each file as the binary carries it, without its final newline', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const codes = [
      await world.run(['browser', 'firewall', 'script']),
      await world.run(['browser', 'firewall', 'unit']),
      await world.run(['browser', 'firewall', 'verify-unit']),
      await world.run(['browser', 'firewall', 'timer']),
    ];

    // Assert
    should(codes).deepEqual([0, 0, 0, 0]);
    should(world.out).deepEqual([
      '#!/bin/sh\necho script\n',
      '[Unit]\nDescription=apply\n',
      '[Unit]\nDescription=verify\n',
      '[Timer]\nOnCalendar=hourly\n',
    ]);
    should(daemon.calls).have.length(0);
  });

  it('should refuse the entry in a sentence that names the gap, and exit 1', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'firewall', 'entry']);

    // Assert
    should(code).equal(1);
    should(world.stderr()).equal(`${FIREWALL_ENTRY_GAP}\n`);
    should(FIREWALL_ENTRY_GAP).containEql('browserPorts');
  });

  it('should refuse an unknown sub-verb with a sentence instead of printing and exiting 0', async () => {
    // The shell resolves the longest declared verb: `browser firewall nope` falls back to no verb at all.
    const world = cliWorld(daemon);
    await should(world.run(['browser', 'firewall', 'nope'])).rejectedWith(/no verb in/u);
  });
});

describe('the spellings v4 also took', () => {
  it('should send close as stop and goto as navigate, exactly as the main verbs do', async () => {
    // Arrange
    daemon.answer(BROWSER, { status: STATUS, result: { ...PAGE, actedPageId: 'p1' } });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const closed = await world.run(['browser', 'close']);
    const went = await world.run(['browser', 'goto', 'https://x.test/']);

    // Assert
    should([closed, went]).deepEqual([0, 0]);
    should(bodies()).deepEqual([{ action: 'stop' }, { action: 'navigate', url: 'https://x.test/' }]);
  });

  it('should send login close as login stop, with --primed', async () => {
    // Arrange
    daemon.answer('POST /v1/browser/login', { state: 'closed', profilePrimed: true });
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'login', 'close', '--primed']);

    // Assert
    should(code).equal(0);
    should(bodies()).deepEqual([{ action: 'stop', primed: true }]);
  });
});
