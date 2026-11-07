import { afterEach, describe, expect, test } from 'bun:test';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { ChildHandle, SpawnOptions } from '@ferretry/kernel/contract';
import { anonymous, device, type TestHost, testHost } from '@ferretry/kernel/testing';
import { AUDIT } from '../../contract/index.ts';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { KernelDetachedLauncher, OPENER_ENVIRONMENT_NAMES, openerEnvironment } from '../../daemon/open-url/launcher.ts';
import {
  type DetachedLauncherPort,
  OPEN_URL_LIMIT,
  OPEN_URL_WINDOW_MS,
  type OpenerCommand,
  OpenRateLimiter,
  OpenUrlError,
  OpenUrlService,
  openerCommand,
  parseOpenableUrl,
} from '../../daemon/open-url/service.ts';
import manifest from '../../manifest.ts';

/**
 * G27 (Gate row, Browsers' behaviour): `POST /v1/system/open-url` hands the address to the operating system as ONE argv
 * element, never a shell string; credentials and non-http(s) schemes are refused; 10 per 10 s; the log records
 * `link.opened` with the host only. Copied from today's `daemon/tests/unit/system/open-url.test.ts` and
 * `runtime/mounts/system-open.test.ts`.
 */

class RecordingLauncher implements DetachedLauncherPort {
  readonly launched: OpenerCommand[] = [];
  constructor(private readonly failure?: Error) {}
  async launch(command: OpenerCommand): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.launched.push(command);
  }
}

function service(launcher = new RecordingLauncher(), platform: NodeJS.Platform = 'linux') {
  const audit = new FakeGate();
  let now = 1_000;
  const open = new OpenUrlService({
    launcher,
    audit: { record: draft => audit.audit(draft) },
    platform,
    nowMs: () => now,
  });
  return {
    open,
    launcher,
    audit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('G27 the route is declared by Browsers', () => {
  test("G27 declares today's route and descriptor: operator, any caller, privilegedOnly, noStore, no capability", () => {
    const route = manifest.actions.routes.find(declared => declared.key === 'POST /v1/system/open-url');

    expect(route).toBeDefined();
    expect(route?.minimum).toBe('operator');
    expect(route?.caller).toBe('any');
    expect(route?.privilegedOnly).toBe(true);
    expect(route?.noStore).toBe(true);
    expect(route?.capability).toBeUndefined();
  });

  test('G27 gives the route its own guard reason: one address to the OS, no page read', () => {
    const route = manifest.actions.routes.find(declared => declared.key === 'POST /v1/system/open-url');

    expect(route?.guard).toEqual({ none: 'hands one validated address to the OS; reads no page' });
  });

  test('G27 names only the three openers it may start, each by program name', () => {
    expect(manifest.permissions?.spawn).toEqual(expect.arrayContaining(['open', 'xdg-open', 'rundll32']));
  });
});

describe('G27 what may be opened', () => {
  test('G27 accepts http and https and hands back the normalised address and its host', () => {
    expect(parseOpenableUrl('https://Example.com/a?b=1#c')).toEqual({
      ok: true,
      href: 'https://example.com/a?b=1#c',
      host: 'example.com',
    });
    expect(parseOpenableUrl('http://localhost:8080')).toEqual({
      ok: true,
      href: 'http://localhost:8080/',
      host: 'localhost',
    });
  });

  test.each([
    ['javascript:alert(1)', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['data:text/html,<script>1</script>', 'scheme'],
    ['vscode://file/etc/passwd', 'scheme'],
    ['ssh://host', 'scheme'],
    ['https://user:pass@example.com/', 'credentials'],
    ['https://user@example.com/', 'credentials'],
    ['not a url', 'unreadable'],
    ['example.com', 'unreadable'],
    ['', 'unreadable'],
    [' https://example.com/', 'unreadable'],
    ['https://exa\nmple.com/', 'unreadable'],
    ['https://example.com/\tx', 'unreadable'],
    ['https://example.com/\u0000', 'unreadable'],
    [`https://example.com/${'a'.repeat(2100)}`, 'too_long'],
  ] as const)('G27 refuses %p as %s: credentials and every scheme but http(s)', (raw, refusal) => {
    const result = parseOpenableUrl(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe(refusal);
  });
});

describe('G27 the address is one argv element', () => {
  const href = 'https://example.com/a?x=1&y=%41^z';

  test('G27 uses open on macOS and xdg-open elsewhere, the address alone as the argument', () => {
    expect(openerCommand('darwin', href)).toEqual({ command: 'open', args: [href] });
    expect(openerCommand('linux', href)).toEqual({ command: 'xdg-open', args: [href] });
  });

  test('G27 reaches Windows through the URL handler and never through a command interpreter', () => {
    const command = openerCommand('win32', href);

    expect(command).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', href] });
    expect(command.command).not.toMatch(/cmd|sh$/u);
  });

  test('G27 never joins the address into a shell string for any platform', () => {
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as const) {
      const command = openerCommand(platform, href);
      expect(command.args.at(-1)).toBe(href);
      expect(command.command).not.toContain(' ');
      expect(command.command).not.toContain(href);
    }
  });
});

class RecordingSpawn {
  readonly started: { program: string; args: readonly string[]; options: SpawnOptions | undefined }[] = [];
  start(program: string, args: readonly string[], options?: SpawnOptions): ChildHandle {
    this.started.push({ program, args, options });
    const empty = () => new ReadableStream<Uint8Array>({ start: controller => controller.close() });
    return {
      pid: 1,
      stdout: empty(),
      stderr: empty(),
      write: () => undefined,
      kill: () => undefined,
      exited: Promise.resolve(0),
      pipes: [],
      closePipes: () => undefined,
    };
  }
}

describe('G27 the real launcher', () => {
  test('G27 starts the opener as program plus argv with the host environment, an ended stdin and no shell', async () => {
    const spawn = new RecordingSpawn();
    const environment = { PATH: '/bin', DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' };
    const launcher = new KernelDetachedLauncher(spawn, environment);
    const href = 'https://example.com/a?b=1 && touch /tmp/x'.replaceAll(' ', '%20');

    await launcher.launch({ command: 'xdg-open', args: [href] });

    expect(spawn.started).toHaveLength(1);
    const [started] = spawn.started;
    expect(started?.program).toBe('xdg-open');
    expect(started?.args).toEqual([href]);
    expect(started?.program).not.toMatch(/^(sh|bash|cmd|powershell)/);
    expect(started?.options?.env).toEqual(environment);
    expect(started?.options?.stdin).toEqual(new Uint8Array());
  });

  test('G27 gives the opener exactly the allow-listed names, and drops a token or FY_HOME', () => {
    expect([...OPENER_ENVIRONMENT_NAMES]).toEqual([
      'PATH',
      'HOME',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'XDG_CURRENT_DESKTOP',
      'XDG_SESSION_TYPE',
      'DBUS_SESSION_BUS_ADDRESS',
      'BROWSER',
      'LANG',
    ]);
    const everything: Record<string, string | undefined> = {
      LC_ALL: 'C.UTF-8',
      LC_TIME: 'en_GB.UTF-8',
      LANGUAGE: 'en',
      FY_HOME: '/home/someone/.ferretry',
      FY_ADMIN_TOKEN: 'token-value',
      ANTHROPIC_API_KEY: 'key-value',
      LOCAL_SECRET: 'x',
    };
    for (const name of OPENER_ENVIRONMENT_NAMES) everything[name] = `value-of-${name}`;
    everything.BROWSER = undefined;

    const given = openerEnvironment(everything);

    expect(Object.keys(given).sort()).toEqual(
      [...OPENER_ENVIRONMENT_NAMES.filter(name => name !== 'BROWSER'), 'LC_ALL', 'LC_TIME'].sort(),
    );
    expect(JSON.stringify(given)).not.toContain('token-value');
    expect(JSON.stringify(given)).not.toContain('key-value');
    expect(given.FY_HOME).toBeUndefined();
  });

  test('G27 passes the launcher only the allow-listed part of the daemon environment', async () => {
    const spawn = new RecordingSpawn();
    const launcher = new KernelDetachedLauncher(spawn, {
      PATH: '/bin',
      DISPLAY: ':0',
      FY_HOME: '/x',
      FY_ADMIN_TOKEN: 't',
    });

    await launcher.launch({ command: 'xdg-open', args: ['https://example.com/'] });

    expect(spawn.started[0]?.options?.env).toEqual({ PATH: '/bin', DISPLAY: ':0' });
  });

  test('G27 passes the Windows handler arguments through unchanged, the address last', async () => {
    const spawn = new RecordingSpawn();
    const launcher = new KernelDetachedLauncher(spawn, {});
    const command = openerCommand('win32', 'https://example.com/');

    await launcher.launch(command);

    expect(spawn.started[0]?.program).toBe(command.command);
    expect(spawn.started[0]?.args).toEqual([...command.args]);
    expect(spawn.started[0]?.args.at(-1)).toBe('https://example.com/');
  });
});

describe('G27 how often', () => {
  test('G27 allows ten in a window and refuses the next, telling how long to wait', () => {
    const limiter = new OpenRateLimiter();

    const results = Array.from({ length: OPEN_URL_LIMIT + 1 }, () => limiter.take(5_000));

    expect(OPEN_URL_LIMIT).toBe(10);
    expect(OPEN_URL_WINDOW_MS).toBe(10_000);
    expect(results.slice(0, OPEN_URL_LIMIT).every(result => result.allowed)).toBe(true);
    expect(results[OPEN_URL_LIMIT]).toEqual({ allowed: false, retryAfterMs: OPEN_URL_WINDOW_MS });
  });

  test('G27 allows again once the window has slid past the oldest opening', () => {
    const limiter = new OpenRateLimiter(2, 1_000);
    limiter.take(0);
    limiter.take(500);

    expect(limiter.take(999)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect(limiter.take(1_000)).toEqual({ allowed: true });
  });

  test('G27 refuses the eleventh opening inside the window with a retry-after, and allows it again afterwards', async () => {
    const { open, launcher, advance } = service();
    for (let index = 0; index < OPEN_URL_LIMIT; index += 1) await open.open('https://example.com/');

    const limited = await open.open('https://example.com/').catch((error: unknown) => error);
    advance(OPEN_URL_WINDOW_MS);
    const later = await open.open('https://example.com/');

    expect((limited as OpenUrlError).code).toBe('rate_limited');
    expect((limited as OpenUrlError).retryAfterSeconds).toBe(10);
    expect(later.opened).toBe(true);
    expect(launcher.launched).toHaveLength(OPEN_URL_LIMIT + 1);
  });
});

describe('G27 what the log keeps', () => {
  test('G27 records link.opened with the host only, never the path or query', async () => {
    const { open, launcher, audit } = service(new RecordingLauncher(), 'darwin');

    const view = await open.open('https://example.com/private?token=SECRET');

    expect(view).toEqual({ opened: true, host: 'example.com' });
    expect(launcher.launched).toEqual([{ command: 'open', args: ['https://example.com/private?token=SECRET'] }]);
    expect(audit.audits).toEqual([
      { event: AUDIT.linkOpened, actor: { kind: 'host' }, outcome: 'succeeded', subject: 'example.com' },
    ]);
    expect(JSON.stringify(audit.audits)).not.toContain('SECRET');
  });

  test('G27 refuses an unopenable address before anything is launched, and says why in the log without echoing it', async () => {
    const { open, launcher, audit } = service();

    const failure = await open.open('javascript:alert(1)').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenUrlError);
    expect((failure as OpenUrlError).code).toBe('invalid_url');
    expect(launcher.launched).toEqual([]);
    expect(audit.audits).toEqual([
      { event: AUDIT.linkOpened, actor: { kind: 'host' }, outcome: 'refused', detail: { reason: 'scheme' } },
    ]);
    expect(JSON.stringify(audit.audits)).not.toContain('alert');
  });

  test('G27 says the opener failed, without echoing the system error, when it cannot start', async () => {
    const { open, audit } = service(new RecordingLauncher(new Error('spawn xdg-open ENOENT /home/someone')));

    const failure = await open.open('https://example.com/').catch((error: unknown) => error);

    expect((failure as OpenUrlError).code).toBe('opener_failed');
    expect((failure as OpenUrlError).message).not.toContain('ENOENT');
    expect(audit.audits).toEqual([
      {
        event: AUDIT.linkOpened,
        actor: { kind: 'host' },
        outcome: 'failed',
        subject: 'example.com',
        detail: { reason: 'opener-unavailable' },
      },
    ]);
  });
});

describe('G27 the route, mounted by the daemon half', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  async function mounted(): Promise<{ host: TestHost; opener: RecordingLauncher; gate: FakeGate }> {
    const opener = new RecordingLauncher();
    const gate = new FakeGate();
    const half = implementDaemon(daemon.manifest, { build: ctx => buildBrowsers(ctx, { opener }) });
    host = await testHost({ plugins: [half], fakes: { vault: new FakeVault(), gate } });
    return { host, opener, gate };
  }

  test('G27 answers the host and launches the address as one argv element, and the log keeps the host only', async () => {
    const { host: built, opener, gate } = await mounted();

    const answer = await built.request('POST', '/v1/system/open-url', {
      body: { url: 'https://example.com/a?token=SECRET' },
    });

    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ opened: true, host: 'example.com' });
    expect(opener.launched).toHaveLength(1);
    expect(opener.launched[0]?.args.at(-1)).toBe('https://example.com/a?token=SECRET');
    expect(gate.audits.map(draft => [draft.event, draft.subject])).toEqual([[AUDIT.linkOpened, 'example.com']]);
    expect(JSON.stringify(gate.audits)).not.toContain('SECRET');
  });

  test('G27 refuses credentials and a non-http(s) scheme with 400, and launches nothing', async () => {
    const { host: built, opener } = await mounted();

    const credentials = await built.request('POST', '/v1/system/open-url', {
      body: { url: 'https://user:pass@example.com/' },
    });
    const scheme = await built.request('POST', '/v1/system/open-url', { body: { url: 'file:///etc/passwd' } });

    expect(credentials.status).toBe(400);
    expect(scheme.status).toBe(400);
    expect(opener.launched).toEqual([]);
  });

  test('G27 refuses a relayed caller with 403 and launches nothing', async () => {
    const { host: built, opener, gate } = await mounted();

    const answer = await built.request('POST', '/v1/system/open-url', {
      body: { url: 'https://example.com/' },
      as: device('phone'),
    });

    expect(answer.status).toBe(403);
    expect(opener.launched).toEqual([]);
    expect(gate.audits).toEqual([]);
  });

  test('G27 refuses a caller with no credential with 401 and launches nothing', async () => {
    const { host: built, opener } = await mounted();

    const answer = await built.request('POST', '/v1/system/open-url', {
      body: { url: 'https://example.com/' },
      as: anonymous(),
    });

    expect(answer.status).toBe(401);
    expect(opener.launched).toEqual([]);
  });

  test.each([
    ['a missing url', {}],
    ['an extra field', { url: 'https://example.com/', extra: true }],
  ])('G27 refuses a body with %s with 400 and launches nothing', async (_name, body) => {
    const { host: built, opener } = await mounted();

    const answer = await built.request('POST', '/v1/system/open-url', { body });

    expect(answer.status).toBe(400);
    expect(opener.launched).toEqual([]);
  });

  test('G27 answers 429 with a retry-after on the eleventh opening in ten seconds', async () => {
    const { host: built } = await mounted();
    for (let index = 0; index < OPEN_URL_LIMIT; index += 1)
      await built.request('POST', '/v1/system/open-url', { body: { url: 'https://example.com/' } });

    const limited = await built.request('POST', '/v1/system/open-url', { body: { url: 'https://example.com/' } });

    expect(limited.status).toBe(429);
  });
});
