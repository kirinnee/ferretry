import { describe, it } from 'bun:test';
import should from 'should';
import type { AuditEntry, AuditSink } from '../../../src/lib/audit/index.ts';
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
} from '../../../src/lib/system/open-url.ts';

class RecordingLauncher implements DetachedLauncherPort {
  readonly launched: OpenerCommand[] = [];
  constructor(private readonly failure?: Error) {}
  async launch(command: OpenerCommand): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.launched.push(command);
  }
}

class RecordingAudit implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function service(launcher = new RecordingLauncher(), platform: NodeJS.Platform = 'linux') {
  const audit = new RecordingAudit();
  let now = 1_000;
  const open = new OpenUrlService({ launcher, audit, platform, nowMs: () => now });
  return {
    open,
    launcher,
    audit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('parseOpenableUrl', () => {
  it('should accept http and https and hand back the normalised address and its host', () => {
    // Arrange / Act
    const plain = parseOpenableUrl('https://Example.com/a?b=1#c');
    const insecure = parseOpenableUrl('http://localhost:8080');

    // Assert
    should(plain).deepEqual({ ok: true, href: 'https://example.com/a?b=1#c', host: 'example.com' });
    should(insecure).deepEqual({ ok: true, href: 'http://localhost:8080/', host: 'localhost' });
  });

  it.each([
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
  ] as const)('should refuse %p as %s', (raw, refusal) => {
    // Act
    const result = parseOpenableUrl(raw);

    // Assert
    should(result.ok).equal(false);
    if (!result.ok) should(result.refusal).equal(refusal);
  });
});

describe('openerCommand', () => {
  const href = 'https://example.com/a?x=1&y=%41^z';

  it('should use open on macOS with the address as one argument', () => {
    should(openerCommand('darwin', href)).deepEqual({ command: 'open', args: [href] });
  });

  it('should use xdg-open on Linux with the address as one argument', () => {
    should(openerCommand('linux', href)).deepEqual({ command: 'xdg-open', args: [href] });
  });

  it('should reach Windows through the URL handler and never through a command interpreter', () => {
    // Act
    const command = openerCommand('win32', href);

    // Assert — cmd would re-read `&`, `^` and `%`; this entry point is given the address untouched.
    should(command).deepEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', href] });
    should(command.command).not.match(/cmd|sh$/u);
  });

  it('should never join the address into a shell string for any platform', () => {
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as const) {
      const command = openerCommand(platform, href);
      should(command.args.at(-1)).equal(href);
      should(command.command).not.containEql(' ');
      should(command.command).not.containEql(href);
    }
  });
});

describe('OpenRateLimiter', () => {
  it('should allow the limit and refuse the next, telling how long to wait', () => {
    // Arrange
    const limiter = new OpenRateLimiter();

    // Act
    const results = Array.from({ length: OPEN_URL_LIMIT + 1 }, () => limiter.take(5_000));

    // Assert
    should(results.slice(0, OPEN_URL_LIMIT).every(result => result.allowed)).equal(true);
    should(results[OPEN_URL_LIMIT]).deepEqual({ allowed: false, retryAfterMs: OPEN_URL_WINDOW_MS });
  });

  it('should allow again once the window has slid past the oldest opening', () => {
    // Arrange
    const limiter = new OpenRateLimiter(2, 1_000);
    limiter.take(0);
    limiter.take(500);

    // Act / Assert
    should(limiter.take(999)).deepEqual({ allowed: false, retryAfterMs: 1 });
    should(limiter.take(1_000)).deepEqual({ allowed: true });
  });
});

describe('OpenUrlService', () => {
  it('should hand the validated address to the launcher and audit only its host', async () => {
    // Arrange
    const { open, launcher, audit } = service(new RecordingLauncher(), 'darwin');

    // Act
    const view = await open.open('https://example.com/private?token=SECRET');

    // Assert
    should(view).deepEqual({ opened: true, host: 'example.com' });
    should(launcher.launched).deepEqual([{ command: 'open', args: ['https://example.com/private?token=SECRET'] }]);
    should(audit.entries).deepEqual([
      { event: 'link.opened', actor: { kind: 'host' }, outcome: 'succeeded', subject: 'example.com' },
    ]);
    should(JSON.stringify(audit.entries)).not.containEql('SECRET');
  });

  it('should refuse an unopenable address before anything is launched, and say why in the audit', async () => {
    // Arrange
    const { open, launcher, audit } = service();

    // Act
    const failure = await open.open('javascript:alert(1)').catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(OpenUrlError);
    should((failure as OpenUrlError).code).equal('invalid_url');
    should(launcher.launched).deepEqual([]);
    should(audit.entries).deepEqual([
      { event: 'link.opened', actor: { kind: 'host' }, outcome: 'refused', detail: { reason: 'scheme' } },
    ]);
    should(JSON.stringify(audit.entries)).not.containEql('alert');
  });

  it('should refuse the eleventh opening inside the window and allow it again afterwards', async () => {
    // Arrange
    const { open, launcher, advance } = service();
    for (let index = 0; index < OPEN_URL_LIMIT; index += 1) await open.open('https://example.com/');

    // Act
    const limited = await open.open('https://example.com/').catch((error: unknown) => error);
    advance(OPEN_URL_WINDOW_MS);
    const later = await open.open('https://example.com/');

    // Assert
    should((limited as OpenUrlError).code).equal('rate_limited');
    should((limited as OpenUrlError).retryAfterSeconds).equal(10);
    should(later.opened).equal(true);
    should(launcher.launched).have.length(OPEN_URL_LIMIT + 1);
  });

  it('should say the opener failed, without echoing the system error, when it cannot start', async () => {
    // Arrange
    const { open, audit } = service(new RecordingLauncher(new Error('spawn xdg-open ENOENT /home/someone')));

    // Act
    const failure = await open.open('https://example.com/').catch((error: unknown) => error);

    // Assert
    should((failure as OpenUrlError).code).equal('opener_failed');
    should((failure as OpenUrlError).message).not.containEql('ENOENT');
    should(audit.entries).deepEqual([
      {
        event: 'link.opened',
        actor: { kind: 'host' },
        outcome: 'failed',
        subject: 'example.com',
        detail: { reason: 'opener-unavailable' },
      },
    ]);
  });
});
