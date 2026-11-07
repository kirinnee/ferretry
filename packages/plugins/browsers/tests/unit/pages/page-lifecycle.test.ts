import { describe, it } from 'bun:test';
import should from 'should';
import {
  ConsoleLog,
  type DialogTimers,
  type EmulationTargets,
  type HeldDialogPort,
  type LifecycleScope,
  type LoggedRequestPort,
  type LoggedResponsePort,
  NetworkLog,
  PageDialogs,
  PageEmulation,
  type WaitableLocator,
  type WaitablePage,
  consoleLevelOf,
  isCredentialHeader,
  runLifecycleRequest,
  waitForCondition,
  withoutUserInfo,
} from '../../../../src/lib/index.ts';

/** Timers that fire only when a test says so. */
class ManualTimers implements DialogTimers {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  private next = 1;

  set(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { callback, ms });
    return handle;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  fireAll(): void {
    for (const [handle, timer] of [...this.pending]) {
      this.pending.delete(handle);
      timer.callback();
    }
  }
}

class FakeDialog implements HeldDialogPort {
  readonly answers: string[] = [];

  constructor(
    private readonly kind = 'confirm',
    private readonly text = 'Delete everything?',
  ) {}

  type(): string {
    return this.kind;
  }

  message(): string {
    return this.text;
  }

  async accept(promptText?: string): Promise<void> {
    this.answers.push(promptText === undefined ? 'accept' : `accept:${promptText}`);
  }

  async dismiss(): Promise<void> {
    this.answers.push('dismiss');
  }
}

describe('page dialogs', () => {
  it('should hold a dialog until it is answered, then hand back what it was', async () => {
    // Arrange
    const dialogs = new PageDialogs(new ManualTimers());
    const dialog = new FakeDialog('prompt', 'Your name?');
    dialogs.hold('p1', dialog);

    // Act
    const pending = dialogs.pending('p1');
    const answered = await dialogs.answer('p1', 'accept', 'hadi');

    // Assert
    should(pending).deepEqual({ type: 'prompt', message: 'Your name?' });
    should(answered).deepEqual({ type: 'prompt', message: 'Your name?' });
    should(dialog.answers).deepEqual(['accept:hadi']);
    should(dialogs.pending('p1')).be.undefined();
  });

  it('should dismiss a dialog nobody answers within the hold time', () => {
    // Arrange
    const timers = new ManualTimers();
    const dialogs = new PageDialogs(timers, 30_000);
    const dialog = new FakeDialog();
    dialogs.hold('p1', dialog);

    // Act
    const [timer] = [...timers.pending.values()];
    timers.fireAll();

    // Assert
    should(timer?.ms).equal(30_000);
    should(dialog.answers).deepEqual(['dismiss']);
    should(dialogs.pending('p1')).be.undefined();
  });

  it('should not dismiss an answered dialog a second time when the hold time passes', async () => {
    // Arrange
    const timers = new ManualTimers();
    const dialogs = new PageDialogs(timers);
    const dialog = new FakeDialog();
    dialogs.hold('p1', dialog);

    // Act
    await dialogs.answer('p1', 'dismiss');
    timers.fireAll();

    // Assert
    should(dialog.answers).deepEqual(['dismiss']);
  });

  it('should dismiss the older dialog when a page raises another', () => {
    // Arrange
    const dialogs = new PageDialogs(new ManualTimers());
    const older = new FakeDialog('alert', 'first');
    const newer = new FakeDialog('alert', 'second');

    // Act
    dialogs.hold('p1', older);
    dialogs.hold('p1', newer);

    // Assert
    should(older.answers).deepEqual(['dismiss']);
    should(dialogs.pending('p1')?.message).equal('second');
  });

  it('should clip a long message and name an unknown type an alert', () => {
    // Arrange
    const dialogs = new PageDialogs(new ManualTimers());

    // Act
    dialogs.hold('p1', new FakeDialog('weird', 'x'.repeat(5_000)));

    // Assert
    should(dialogs.pending('p1')?.type).equal('alert');
    should(dialogs.pending('p1')?.message.length).equal(1_024);
  });

  it('should refuse to answer a page that has no dialog', async () => {
    // Arrange
    const dialogs = new PageDialogs(new ManualTimers());

    // Act
    const failure = await dialogs.answer('p1', 'accept').catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).equal('no dialog is open on this page');
  });

  it('should tell a watcher at once when a dialog is already open, and when one opens later', async () => {
    // Arrange
    const dialogs = new PageDialogs(new ManualTimers());
    dialogs.hold('p1', new FakeDialog());
    const already = dialogs.opened('p1');
    const later = dialogs.opened('p2');
    let settled = false;
    void later.promise.then(() => {
      settled = true;
    });

    // Act
    await already.promise;
    await Promise.resolve();
    const before = settled;
    dialogs.hold('p2', new FakeDialog());
    await later.promise;

    // Assert
    should(before).be.false();
    should(settled).be.true();
  });

  it('should stop telling a cancelled watcher, and forget a dropped page without answering it', async () => {
    // Arrange
    const timers = new ManualTimers();
    const dialogs = new PageDialogs(timers);
    const watcher = dialogs.opened('p1');
    let settled = false;
    void watcher.promise.then(() => {
      settled = true;
    });
    watcher.cancel();
    const dialog = new FakeDialog();

    // Act
    dialogs.hold('p1', dialog);
    await Promise.resolve();
    dialogs.drop('p1');

    // Assert
    should(settled).be.false();
    should(dialog.answers).deepEqual([]);
    should(dialogs.pending('p1')).be.undefined();
    should(timers.pending.size).equal(0);
  });
});

describe('console log', () => {
  it('should number entries, name their place and filter by level and by sequence', () => {
    // Arrange
    const log = new ConsoleLog();
    log.add('log', 'booted', { url: 'https://app.test/main.js', lineNumber: 9 });
    log.add('warning', 'deprecated');
    log.add('error', 'boom');
    log.add('debug', 'noise');

    // Act
    const all = log.read();
    const errors = log.read({ level: 'error' });
    const warnings = log.read({ level: 'warning' });
    const after = log.read({ since: 3 });

    // Assert
    should(all).containEql('#1 [log] booted (https://app.test/main.js:10)');
    should(all).containEql('#4 [debug] noise');
    should(errors).containEql('#3 [error] boom');
    should(errors).not.containEql('deprecated');
    should(warnings).containEql('#2 [warning] deprecated');
    should(warnings).containEql('#3 [error] boom');
    should(after).containEql('#4 [debug] noise');
    should(after).not.containEql('#3');
    should(all).containEql('ask with since: 4');
  });

  it('should say so when nothing matches, and keep the position', () => {
    // Arrange
    const log = new ConsoleLog();
    log.add('log', 'one');

    // Act
    const text = log.read({ since: 1 });

    // Assert
    should(text).equal('no console messages (last entry #1)');
  });

  it('should keep only the newest entries of a ring and only the newest limit of a read', () => {
    // Arrange
    const log = new ConsoleLog();
    for (let index = 0; index < 600; index += 1) log.add('log', `line ${index}`);

    // Act
    const everything = log.read({ limit: 500 });
    const few = log.read({ limit: 2 });

    // Assert
    should(everything).not.containEql('#100 ');
    should(everything).containEql('#101 [log] line 100');
    should(everything).containEql('#600 [log] line 599');
    should(few).containEql('#599 ');
    should(few).containEql('#600 ');
    should(few).not.containEql('#598 ');
  });

  it('should clip a long line, and drop user-info from the place it came from', () => {
    // Arrange
    const log = new ConsoleLog();
    log.add('log', 'y'.repeat(5_000), { url: 'https://user:pw@app.test/a.js' });

    // Act
    const text = log.read();

    // Assert
    should(text).not.containEql('user:pw');
    should(text).not.containEql('y'.repeat(2_001));
    should(text).containEql('y'.repeat(2_000));
  });

  it('should map every browser console type to one of the five levels', () => {
    should(
      ['error', 'warning', 'info', 'log', 'debug', 'assert', 'trace', 'table', 'dir'].map(consoleLevelOf),
    ).deepEqual(['error', 'warning', 'info', 'log', 'debug', 'error', 'log', 'log', 'log']);
  });
});

describe('credential headers', () => {
  it('should treat a credential header as one an agent never sees, whatever its case', () => {
    // Arrange
    const credentials = [
      'Cookie',
      'set-cookie',
      'AUTHORIZATION',
      'Proxy-Authorization',
      'x-csrf-token',
      'X-Api-Key',
      'x-apikey',
      'x-client-secret',
      'X-Auth-Token',
    ];
    const harmless = ['content-type', 'cache-control', 'content-length', 'etag', 'x-request-id'];

    // Act
    const stripped = credentials.map(isCredentialHeader);
    const kept = harmless.map(isCredentialHeader);

    // Assert
    should(stripped.every(Boolean)).be.true();
    should(kept.some(Boolean)).be.false();
  });

  it('should drop the user name and password from a URL', () => {
    should(withoutUserInfo('https://hadi:hunter2@example.test/a?b=1')).equal('https://example.test/a?b=1');
    should(withoutUserInfo('https://example.test/a')).equal('https://example.test/a');
    should(withoutUserInfo('not a url')).equal('not a url');
  });
});

class FakeRequest implements LoggedRequestPort {
  constructor(
    private readonly address: string,
    private readonly kind = 'fetch',
    private readonly verb = 'GET',
    private readonly size = 120,
  ) {}

  method(): string {
    return this.verb;
  }

  url(): string {
    return this.address;
  }

  resourceType(): string {
    return this.kind;
  }

  async sizes(): Promise<{ responseBodySize: number }> {
    return { responseBodySize: this.size };
  }
}

class FakeResponse implements LoggedResponsePort {
  constructor(
    private readonly code: number,
    private readonly head: Record<string, string>,
    private readonly payload: Uint8Array = new TextEncoder().encode('{"ok":true}'),
  ) {}

  status(): number {
    return this.code;
  }

  headers(): Record<string, string> {
    return this.head;
  }

  async body(): Promise<Uint8Array> {
    return this.payload;
  }
}

const finish = async (log: NetworkLog, request: FakeRequest, response: FakeResponse): Promise<void> => {
  log.responded(request, response);
  await log.finished(request);
};

describe('network log', () => {
  it('should list each request with its id, method, status, kind, size, time and a URL without user-info', async () => {
    // Arrange
    let clock = 1_000;
    const log = new NetworkLog(() => clock);
    const api = new FakeRequest('https://hadi:pw@app.test/api/me', 'fetch', 'POST', 2_048);
    log.started(api);
    clock += 42;
    await finish(log, api, new FakeResponse(201, { 'content-type': 'application/json' }));
    const pending = new FakeRequest('https://app.test/slow', 'xhr');
    log.started(pending);

    // Act
    const text = log.list();

    // Assert
    should(text.split('\n')).deepEqual([
      'r1 POST 201 fetch 2.0KB 42ms https://app.test/api/me',
      'r2 GET pending xhr - - https://app.test/slow',
    ]);
  });

  it('should size a large response in megabytes', async () => {
    // Arrange
    const log = new NetworkLog(() => 0);
    const video = new FakeRequest('https://app.test/clip.mp4', 'media', 'GET', 3_145_728);
    log.started(video);
    await finish(log, video, new FakeResponse(200, {}));

    // Act
    const text = log.list();

    // Assert
    should(text).containEql('3.0MB');
  });

  it('should narrow a list by URL fragment and by resource type, and say when nothing is recorded', async () => {
    // Arrange
    const log = new NetworkLog();
    log.started(new FakeRequest('https://app.test/api/a', 'fetch'));
    log.started(new FakeRequest('https://app.test/logo.png', 'image'));
    log.started(new FakeRequest('https://cdn.test/app.js', 'script'));

    // Act
    const byUrl = log.list({ filter: '/api/' });
    const byType = log.list({ types: ['image', 'script'] });
    const none = log.list({ filter: 'nope' });

    // Assert
    should(byUrl.split('\n')).have.length(1);
    should(byUrl).containEql('r1 ');
    should(byType.split('\n')).have.length(2);
    should(byType).not.containEql('r1 ');
    should(none).equal('no requests recorded');
  });

  it('should fold an unknown resource type into other', () => {
    // Arrange
    const log = new NetworkLog();
    log.started(new FakeRequest('https://app.test/x', 'ping'));

    // Act
    const text = log.list({ types: ['other'] });

    // Assert
    should(text).containEql('r1 ');
  });

  it('should show a response without any credential header, and never the request headers', async () => {
    // Arrange
    const log = new NetworkLog();
    const request = new FakeRequest('https://app.test/api/me');
    log.started(request);
    await finish(
      log,
      request,
      new FakeResponse(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': 'session=SECRET-COOKIE',
        'x-auth-token': 'SECRET-TOKEN',
        'x-api-key': 'SECRET-KEY',
        authorization: 'Bearer SECRET-BEARER',
        'proxy-authorization': 'Basic SECRET-PROXY',
        'cache-control': 'no-store',
      }),
    );

    // Act
    const text = await log.get('r1');

    // Assert
    should(text).containEql('cache-control: no-store');
    should(text).containEql('content-type: application/json; charset=utf-8');
    should(text).containEql('{"ok":true}');
    should(text).not.containEql('SECRET');
    should(text.toLowerCase()).not.containEql('cookie');
    should(text.toLowerCase()).not.containEql('authorization');
  });

  it('should clip a text body at 64 KiB and say so', async () => {
    // Arrange
    const log = new NetworkLog();
    const request = new FakeRequest('https://app.test/big');
    log.started(request);
    await finish(
      log,
      request,
      new FakeResponse(200, { 'content-type': 'text/plain' }, new TextEncoder().encode('z'.repeat(70_000))),
    );

    // Act
    const text = await log.get('r1');

    // Assert
    should(text).containEql('z'.repeat(65_536));
    should(text).not.containEql('z'.repeat(65_537));
    should(text).containEql('(body clipped to 65536 bytes of 70000)');
  });

  it('should not show a binary body', async () => {
    // Arrange
    const log = new NetworkLog();
    const request = new FakeRequest('https://app.test/a.png', 'image');
    log.started(request);
    await finish(log, request, new FakeResponse(200, { 'content-type': 'image/png' }, new Uint8Array([137, 80])));

    // Act
    const text = await log.get('r1');

    // Assert
    should(text).containEql('(body not shown: image/png)');
  });

  it('should say what happened to a request that failed or has no response yet, and refuse an id it never had', async () => {
    // Arrange
    const log = new NetworkLog();
    const failed = new FakeRequest('https://app.test/down');
    const waiting = new FakeRequest('https://app.test/wait');
    log.started(failed);
    log.started(waiting);
    log.failed(failed, 'net::ERR_CONNECTION_REFUSED');

    // Act
    const failure = await log.get('r1');
    const none = await log.get('r2');
    const missing = await log.get('r9').catch((error: unknown) => error);

    // Assert
    should(failure).containEql('failed (net::ERR_CONNECTION_REFUSED)');
    should(failure).containEql('no response: net::ERR_CONNECTION_REFUSED');
    should(none).containEql('no response yet');
    should((missing as Error).message).containEql('r9 is not in this page');
  });

  it('should keep only the newest 300 requests', () => {
    // Arrange
    const log = new NetworkLog();
    for (let index = 0; index < 320; index += 1) log.started(new FakeRequest(`https://app.test/${index}`));

    // Act
    const rows = log.list().split('\n');

    // Assert
    should(rows).have.length(100);
    should(rows[99]).containEql('/319');
    should(log.list({ filter: '/0' })).equal('no requests recorded');
  });
});

class FakeLocator implements WaitableLocator {
  readonly waits: string[] = [];

  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
  ) {}

  first(): WaitableLocator {
    return this;
  }

  async waitFor(options: { state: string; timeout: number }): Promise<void> {
    this.waits.push(`${this.selector} ${options.state} ${options.timeout}`);
    this.page.calls.push(`${this.selector} ${options.state} ${options.timeout}`);
    if (this.page.neverAppears) {
      const error = new Error('Timeout 1000ms exceeded');
      error.name = 'TimeoutError';
      throw error;
    }
  }

  async innerText(): Promise<string> {
    if (this.page.bodyError !== undefined) throw this.page.bodyError;
    return this.page.bodies.shift() ?? this.page.lastBody;
  }
}

class FakePage implements WaitablePage {
  readonly calls: string[] = [];
  bodies: string[] = [];
  lastBody = '';
  address = 'https://app.test/login';
  neverAppears = false;
  badSelector = false;
  bodyError: Error | undefined;

  url(): string {
    return this.address;
  }

  locator(selector: string): WaitableLocator {
    if (this.badSelector) throw new Error(`Unexpected token "${selector}"`);
    return new FakeLocator(this, selector);
  }

  async waitForLoadState(state: string, options: { timeout: number }): Promise<void> {
    this.calls.push(`load ${state} ${options.timeout}`);
    if (this.neverAppears) {
      const error = new Error('Timeout');
      error.name = 'TimeoutError';
      throw error;
    }
  }
}

describe('wait for a condition', () => {
  const noSleep = async (): Promise<void> => undefined;

  it('should wait for an element in the state asked for, by ref or by selector', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const byRef = await waitForCondition(
      page,
      { kind: 'element', target: { kind: 'ref', ref: 'e3' }, state: 'hidden' },
      800,
      noSleep,
    );
    const bySelector = await waitForCondition(
      page,
      { kind: 'element', target: { kind: 'selector', selector: '#go' }, state: 'visible' },
      500,
      noSleep,
    );

    // Assert
    should(byRef).be.true();
    should(bySelector).be.true();
    should(page.calls[0]).equal('aria-ref=e3 hidden 800');
    should(page.calls[1]).equal('#go visible 500');
  });

  it('should answer false, not throw, when an element does not reach the state in time', async () => {
    // Arrange
    const page = new FakePage();
    page.neverAppears = true;

    // Act
    const matched = await waitForCondition(
      page,
      { kind: 'element', target: { kind: 'selector', selector: '#go' }, state: 'visible' },
      100,
      noSleep,
    );

    // Assert
    should(matched).be.false();
  });

  it('should still throw for a selector the page cannot parse', async () => {
    // Arrange
    const page = new FakePage();
    page.badSelector = true;

    // Act
    const failure = await waitForCondition(
      page,
      { kind: 'element', target: { kind: 'selector', selector: '###' }, state: 'visible' },
      100,
      noSleep,
    ).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql('Unexpected token');
  });

  it('should wait for a load state', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const matched = await waitForCondition(page, { kind: 'load', state: 'networkidle' }, 700, noSleep);

    // Assert
    should(matched).be.true();
    should(page.calls).deepEqual(['load networkidle 700']);
  });

  it('should answer false when a load state is not reached in time', async () => {
    // Arrange
    const page = new FakePage();
    page.neverAppears = true;

    // Act
    const matched = await waitForCondition(page, { kind: 'load', state: 'load' }, 100, noSleep);

    // Assert
    should(matched).be.false();
  });

  it('should poll the body until the text appears', async () => {
    // Arrange
    const page = new FakePage();
    page.bodies = ['Loading', 'Loading', 'Welcome back, Hadi'];

    // Act
    const matched = await waitForCondition(page, { kind: 'text', text: 'Welcome' }, 5_000, noSleep);

    // Assert
    should(matched).be.true();
    should(page.bodies).have.length(0);
  });

  it('should poll the body until the text is gone', async () => {
    // Arrange
    const page = new FakePage();
    page.bodies = ['Loading…', 'Done'];

    // Act
    const matched = await waitForCondition(page, { kind: 'textGone', text: 'Loading' }, 5_000, noSleep);

    // Assert
    should(matched).be.true();
  });

  it('should give up on text that never shows, after the whole timeout', async () => {
    // Arrange
    const page = new FakePage();
    page.lastBody = 'nothing here';
    const slept: number[] = [];

    // Act
    const matched = await waitForCondition(page, { kind: 'text', text: 'Welcome' }, 350, async ms => {
      slept.push(ms);
    });

    // Assert
    should(matched).be.false();
    should(slept.reduce((sum, ms) => sum + ms, 0)).equal(350);
  });

  it('should treat a body read that timed out as text not shown yet, and surface any other failure', async () => {
    // Arrange
    const page = new FakePage();
    const timedOut = new Error('Timeout 1000ms exceeded');
    timedOut.name = 'TimeoutError';
    page.bodyError = timedOut;

    // Act
    const quiet = await waitForCondition(page, { kind: 'text', text: 'Welcome' }, 200, noSleep);
    page.bodyError = new Error('Target closed');
    const failed = await waitForCondition(page, { kind: 'text', text: 'Welcome' }, 200, noSleep).catch(
      (error: unknown) => error,
    );

    // Assert
    should(quiet).be.false();
    should((failed as Error).message).equal('Target closed');
  });

  it('should match a URL by a part of it, and notice when the page gets there', async () => {
    // Arrange
    const page = new FakePage();
    let sleeps = 0;

    // Act
    const matched = await waitForCondition(page, { kind: 'url', url: '/dashboard' }, 5_000, async () => {
      sleeps += 1;
      if (sleeps === 2) page.address = 'https://app.test/dashboard?x=1';
    });
    const never = await waitForCondition(page, { kind: 'url', url: '/nowhere' }, 200, noSleep);

    // Assert
    should(matched).be.true();
    should(sleeps).equal(2);
    should(never).be.false();
  });

  it('should sleep for a time wait, and never past the timeout', async () => {
    // Arrange
    const page = new FakePage();
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };

    // Act
    await waitForCondition(page, { kind: 'time', ms: 800 }, 1_000, sleep);
    await waitForCondition(page, { kind: 'time', ms: 800 }, 300, sleep);

    // Assert
    should(slept).deepEqual([800, 300]);
  });
});

class RecordingSession {
  readonly sent: Array<{ method: string; params: unknown }> = [];

  async send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.sent.push({ method, params });
    return {};
  }
}

class FakeTargets implements EmulationTargets {
  readonly session = new RecordingSession();
  readonly viewports: Array<{ width: number; height: number }> = [];
  readonly granted: Array<{ permissions: readonly string[]; origin: string }> = [];
  cleared = 0;
  address = 'https://app.test/page';

  async setViewport(viewport: { width: number; height: number }): Promise<void> {
    this.viewports.push(viewport);
  }

  url(): string {
    return this.address;
  }

  async grantPermissions(permissions: readonly string[], origin: string): Promise<void> {
    this.granted.push({ permissions, origin });
  }

  async clearPermissions(): Promise<void> {
    this.cleared += 1;
  }
}

describe('page emulation', () => {
  it('should refuse permissions on a page that is not on a website', async () => {
    // Arrange
    const targets = new FakeTargets();
    targets.address = 'about:blank';
    const other = new FakeTargets();
    other.address = 'not a url';

    // Act
    const blank = await new PageEmulation().apply(targets, { permissions: ['geolocation'] }).catch((e: unknown) => e);
    const garbled = await new PageEmulation().apply(other, { permissions: ['geolocation'] }).catch((e: unknown) => e);

    // Assert
    should((blank as Error).message).match(/open a page on it first/u);
    should((garbled as Error).message).match(/open a page on it first/u);
  });

  it('should send each requested condition through the matching DevTools call', async () => {
    // Arrange
    const targets = new FakeTargets();

    // Act
    const text = await new PageEmulation().apply(targets, {
      viewport: { width: 390, height: 844 },
      geolocation: { latitude: 52.5, longitude: 13.4 },
      locale: 'de-DE',
      timezone: 'Europe/Berlin',
      cpuThrottle: 4,
      network: { latency: 200, throughput: 800 },
      permissions: ['geolocation'],
    });

    // Assert
    should(targets.viewports).deepEqual([{ width: 390, height: 844 }]);
    should(targets.session.sent).deepEqual([
      { method: 'Emulation.setGeolocationOverride', params: { latitude: 52.5, longitude: 13.4, accuracy: 100 } },
      { method: 'Emulation.setLocaleOverride', params: { locale: 'de-DE' } },
      { method: 'Emulation.setTimezoneOverride', params: { timezoneId: 'Europe/Berlin' } },
      { method: 'Emulation.setCPUThrottlingRate', params: { rate: 4 } },
      { method: 'Network.enable', params: undefined },
      {
        method: 'Network.emulateNetworkConditions',
        params: { offline: false, latency: 200, downloadThroughput: 100_000, uploadThroughput: 100_000 },
      },
    ]);
    should(targets.granted).deepEqual([{ permissions: ['geolocation'], origin: 'https://app.test' }]);
    should(text).containEql('viewport 390x844');
    should(text).containEql('permissions geolocation for https://app.test');
  });

  it('should keep media features it set earlier, because Chrome replaces the whole set', async () => {
    // Arrange
    const targets = new FakeTargets();
    const emulation = new PageEmulation();

    // Act
    await emulation.apply(targets, { media: { colorScheme: 'dark' } });
    await emulation.apply(targets, { media: { reducedMotion: 'reduce', print: true } });

    // Assert
    should(targets.session.sent[1]).deepEqual({
      method: 'Emulation.setEmulatedMedia',
      params: {
        media: 'print',
        features: [
          { name: 'prefers-color-scheme', value: 'dark' },
          { name: 'prefers-reduced-motion', value: 'reduce' },
        ],
      },
    });
  });

  it('should put everything back on reset', async () => {
    // Arrange
    const targets = new FakeTargets();
    const emulation = new PageEmulation();
    await emulation.apply(targets, { media: { colorScheme: 'dark' } });
    targets.session.sent.length = 0;

    // Act
    const text = await emulation.apply(targets, { reset: true });

    // Assert
    should(targets.session.sent.map(call => call.method)).deepEqual([
      'Emulation.setEmulatedMedia',
      'Emulation.setGeolocationOverride',
      'Emulation.setLocaleOverride',
      'Emulation.setTimezoneOverride',
      'Emulation.setCPUThrottlingRate',
      'Network.enable',
      'Network.emulateNetworkConditions',
    ]);
    should(targets.session.sent[0]?.params).deepEqual({ media: '', features: [] });
    should(targets.cleared).equal(1);
    should(targets.viewports).deepEqual([{ width: 1280, height: 800 }]);
    should(text).containEql('reset');
  });

  it('should say offline in the summary and leave the throughput unlimited when none is given', async () => {
    // Arrange
    const targets = new FakeTargets();

    // Act
    const text = await new PageEmulation().apply(targets, { network: { offline: true } });

    // Assert
    should(text).containEql('network offline');
    should(targets.session.sent[1]?.params).deepEqual({
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  it('should refuse to grant a permission on a page that is not a website', async () => {
    // Arrange
    const targets = new FakeTargets();
    targets.address = 'about:blank';

    // Act
    const failure = await new PageEmulation()
      .apply(targets, { permissions: ['notifications'] })
      .catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql('open a page on it first');
    should(targets.granted).deepEqual([]);
  });

  it('should never send a user agent or client-hint override', async () => {
    // Arrange
    const targets = new FakeTargets();

    // Act
    await new PageEmulation().apply(targets, {
      viewport: { width: 400, height: 800 },
      media: { colorScheme: 'light' },
      geolocation: { latitude: 0, longitude: 0 },
      locale: 'en-US',
      timezone: 'UTC',
      cpuThrottle: 2,
      network: { offline: true },
    });
    await new PageEmulation().apply(targets, { reset: true });

    // Assert
    const methods = targets.session.sent.map(call => call.method);
    should(methods.some(method => /UserAgent|ClientHint|ExtraHTTPHeaders/iu.test(method))).be.false();
  });
});

const scopeOf = (
  overrides: Partial<LifecycleScope> = {},
): LifecycleScope & { page: FakePage; targets: FakeTargets } => {
  const page = new FakePage();
  const targets = new FakeTargets();
  return {
    pageKey: 'p1',
    page,
    dialogs: new PageDialogs(new ManualTimers()),
    messages: new ConsoleLog(),
    network: new NetworkLog(),
    emulation: new PageEmulation(),
    targets,
    sleep: async () => undefined,
    ...overrides,
  } as LifecycleScope & { page: FakePage; targets: FakeTargets };
};

describe('running a lifecycle request', () => {
  it('should answer a dialog and say which kind it was', async () => {
    // Arrange
    const scope = scopeOf();
    const dialog = new FakeDialog('confirm', 'Really?');
    scope.dialogs.hold('p1', dialog);

    // Act
    const reply = await runLifecycleRequest(scope, { op: 'dialog', action: 'accept' });

    // Assert
    should(reply).deepEqual({ text: 'accepted the confirm dialog: Really?', dialogType: 'confirm' });
    should(dialog.answers).deepEqual(['accept']);
  });

  it('should report a wait as met or not met', async () => {
    // Arrange
    const scope = scopeOf();

    // Act
    const met = await runLifecycleRequest(scope, {
      op: 'wait',
      condition: { kind: 'load', state: 'load' },
      timeoutMs: 500,
    });
    scope.page.neverAppears = true;
    const notMet = await runLifecycleRequest(scope, {
      op: 'wait',
      condition: { kind: 'load', state: 'load' },
      timeoutMs: 500,
    });

    // Assert
    should(met).deepEqual({ text: 'condition met', matched: true });
    should(notMet).deepEqual({ text: 'condition not met yet', matched: false });
  });

  it('should read the console and the network log, and refuse an unknown request id', async () => {
    // Arrange
    const scope = scopeOf();
    scope.messages.add('error', 'boom');
    scope.network.started(new FakeRequest('https://app.test/api'));

    // Act
    const logged = await runLifecycleRequest(scope, { op: 'console', level: 'error' });
    const listed = await runLifecycleRequest(scope, { op: 'network', action: 'list', filter: 'api' });
    const failure = await runLifecycleRequest(scope, { op: 'network', action: 'get', id: 'r77' }).catch(
      (error: unknown) => error,
    );

    // Assert
    should(logged.text).containEql('#1 [error] boom');
    should(listed.text).containEql('r1 GET pending');
    should((failure as Error).message).containEql('r77');
  });

  it('should emulate through the page emulation', async () => {
    // Arrange
    const scope = scopeOf();

    // Act
    const reply = await runLifecycleRequest(scope, { op: 'emulate', emulation: { cpuThrottle: 6 } });

    // Assert
    should(reply.text).equal('Emulating: cpu 6x slower');
  });
});
