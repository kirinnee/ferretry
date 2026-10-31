import { describe, it } from 'bun:test';
import {
  COPY_AFTER_MASK_SECONDS,
  COPY_DEFAULT_LIFETIME_SECONDS,
  COPY_MAX_CAPTURES_PER_HOUR,
  COPY_MAX_LIVE_PER_SESSION,
  COPY_STDERR_MAX_CHARS,
  COPY_VALUE_MAX_BYTES,
  type CopyCapture,
} from '@ferretry/protocol';
import should from 'should';
import {
  EphemeralValues,
  type SecretChildOutcome,
  type SecretChildRunner,
  type SecretChildSpec,
  SecureCopyError,
  SecureCopyService,
} from '../../../src/lib/index.ts';

const TOKEN = 'vcp_SEALED-UNIQUE-7f3a';

class Clock {
  ms = Date.parse('2026-10-31T09:00:00.000Z');
  now(): number {
    return this.ms;
  }
}

/** A child runner that answers what the case set and records every spec, as the secret store's runner would run it. */
class FakeRunner implements SecretChildRunner {
  readonly specs: SecretChildSpec[] = [];
  outcome: SecretChildOutcome = { outcome: 'exited', exitCode: 0, stdout: `${TOKEN}\n`, stderr: '', truncated: false };
  async run(spec: SecretChildSpec): Promise<SecretChildOutcome> {
    this.specs.push(spec);
    return this.outcome;
  }
}

function world() {
  const clock = new Clock();
  const runner = new FakeRunner();
  const masking = new EphemeralValues(clock);
  const folders = new Map<string, string>([['s1', '/work/s1']]);
  const exposure = { answer: 'clean' as 'found' | 'clean' | 'unknown', failing: false, asked: [] as string[] };
  const redact = { locked: false, vault: new Map<string, string>() };
  const service = new SecureCopyService({
    clock,
    runner,
    folders: { folderOf: async sessionId => folders.get(sessionId) },
    exposure: {
      transcriptHolds: async (sessionId, value) => {
        // The masking registry holds the value BEFORE the transcript is looked at.
        exposure.asked.push(`${sessionId}:${String(masking.scrub(sessionId, value) !== value)}`);
        if (exposure.failing) throw new Error('unreadable');
        return exposure.answer;
      },
    },
    masking,
    redact: async text => {
      if (redact.locked) throw new Error('the vault is locked');
      return [...redact.vault].reduce((masked, [value, name]) => masked.replaceAll(value, `[redacted:${name}]`), text);
    },
  });
  return { clock, runner, masking, folders, exposure, redact, service };
}

const command = (argv: readonly string[] = ['gh', 'auth', 'token'], extra: Partial<CopyCapture['source']> = {}) =>
  ({ name: 'token', source: { kind: 'command', argv: [...argv], ...extra } }) as CopyCapture;

const refusal = async (work: Promise<unknown>): Promise<SecureCopyError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(SecureCopyError);
  return error as SecureCopyError;
};

describe('SecureCopyService capturing what a command prints', () => {
  it('should keep a program run by its path as written, so a rule naming the bare program never matches it', async () => {
    const { service } = world();

    const local = await service.capture('s1', {
      ...command(['./vercel', 'tokens', 'create']),
      name: 'local',
    } as CopyCapture);
    const absolute = await service.capture('s1', {
      ...command(['/usr/bin/gh', 'auth', 'token']),
      name: 'absolute',
    } as CopyCapture);

    should([local.copy.from, absolute.copy.from]).eql([
      { kind: 'command', program: './vercel' },
      { kind: 'command', program: '/usr/bin/gh' },
    ]);
  });

  it('should hold stdout under the name and say only where it came from, how long it is and when it lapses', async () => {
    const { service, runner, clock } = world();

    const { copy, command: report } = await service.capture('s1', command(['gh', 'auth', 'token']));

    should(copy).eql({
      handle: 'sealed:token',
      name: 'token',
      from: { kind: 'command', program: 'gh' },
      length: TOKEN.length,
      lines: 1,
      capturedAt: new Date(clock.ms).toISOString(),
      expiresAt: new Date(clock.ms + COPY_DEFAULT_LIFETIME_SECONDS * 1000).toISOString(),
      state: 'live',
      exposure: { transcript: 'clean' },
      uses: 0,
    });
    should(report).eql({ outcome: 'exited', exitCode: 0 });
    should(JSON.stringify({ copy, report })).not.containEql(TOKEN);
    should(runner.specs).eql([
      {
        command: ['gh', 'auth', 'token'],
        cwd: '/work/s1',
        env: {},
        timeoutMs: 30_000,
        maxOutputBytes: COPY_VALUE_MAX_BYTES + 1,
      },
    ]);
  });

  it('should run in the session folder, a folder under it, or an absolute one', async () => {
    const { service, runner } = world();

    await service.capture('s1', { ...command(), name: 'a', source: { kind: 'command', argv: ['x'], cwd: 'sub/dir' } });
    await service.capture('s1', {
      ...command(),
      name: 'b',
      source: { kind: 'command', argv: ['x'], cwd: '/elsewhere' },
    });

    should(runner.specs.map(spec => spec.cwd)).eql(['/work/s1/sub/dir', '/elsewhere']);
    const error = await refusal(service.capture('s9', command()));
    should(error.code).equal('bad_request');
    should(error.message).containEql('absolute cwd');
  });

  it('should keep surrounding white space only when asked', async () => {
    const { service, runner } = world();
    runner.outcome = { ...runner.outcome, stdout: '  two\nlines  \n' };

    should((await service.capture('s1', command(['x'], { trim: false }))).copy.length).equal(14);
    should((await service.capture('s1', { ...command(['x']), name: 'other' })).copy).match({ length: 9, lines: 2 });
  });

  it('should mask the value from the moment it is read, until its life and the after-mask window are over', async () => {
    const { service, masking, clock, exposure } = world();

    await service.capture('s1', command());

    should(exposure.asked).eql(['s1:true']);
    should(masking.scrub('s1', `export TOKEN=${TOKEN}`)).equal('export TOKEN=[sealed:token]');
    should(masking.scrubAll(TOKEN)).equal('[sealed:token]');
    clock.ms += (COPY_DEFAULT_LIFETIME_SECONDS + COPY_AFTER_MASK_SECONDS) * 1000 - 1;
    should(masking.scrub('s1', TOKEN)).equal('[sealed:token]');
    clock.ms += 1;
    should(masking.scrub('s1', TOKEN)).equal(TOKEN);
  });

  it('should say honestly when the value was already in the transcript, or when that could not be checked', async () => {
    const found = world();
    found.exposure.answer = 'found';
    should((await found.service.capture('s1', command())).copy.exposure).eql({ transcript: 'found' });

    const unreadable = world();
    unreadable.exposure.failing = true;
    should((await unreadable.service.capture('s1', command())).copy.exposure).eql({ transcript: 'unknown' });
  });

  it('should copy nothing when the command fails, and hand back its stderr with the value masked', async () => {
    const { service, runner, masking, redact } = world();
    redact.vault.set('vault-secret', 'GH');
    runner.outcome = {
      outcome: 'exited',
      exitCode: 1,
      stdout: `${TOKEN}\n`,
      stderr: `error: token ${TOKEN} rejected (auth vault-secret)\n`,
      truncated: false,
    };

    const error = await refusal(service.capture('s1', command()));

    should(error.code).equal('upstream_failed');
    should(error.message).equal(
      'The command exited with 1; nothing was copied. It said on stderr: error: token [sealed:token] rejected (auth [redacted:GH])',
    );
    should(service.list('s1')).eql([]);
    should(masking.heldCount()).equal(0);
  });

  it('should hand back stderr from a command that worked, masked and cut', async () => {
    const { service, runner } = world();
    runner.outcome = { ...runner.outcome, stderr: `note: printed ${TOKEN} ${'x'.repeat(3_000)}` };

    const { command: report } = await service.capture('s1', command());

    should(report?.stderr?.startsWith('note: printed [sealed:token] xxx')).be.true();
    should(report?.stderr?.length).equal(COPY_STDERR_MAX_CHARS);
    should(report?.stderr).not.containEql(TOKEN);
  });

  it('should withhold stderr when the vault cannot be opened to check it', async () => {
    const { service, runner, redact } = world();
    redact.locked = true;
    runner.outcome = { ...runner.outcome, exitCode: 2, stderr: 'something the vault would have masked' };

    const error = await refusal(service.capture('s1', command()));

    should(error.message).equal('The command exited with 2; nothing was copied.');
  });

  it('should refuse a timeout, a spawn failure, empty output and output over the cap', async () => {
    const cases: readonly [SecretChildOutcome, string, string][] = [
      [{ outcome: 'timeout', stdout: TOKEN, stderr: '', truncated: true }, 'upstream_failed', 'ran out of time'],
      [{ outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false }, 'bad_request', 'gh could not be started'],
      [
        { outcome: 'exited', exitCode: 0, stdout: ' \n', stderr: '', truncated: false },
        'bad_request',
        'printed nothing',
      ],
      [
        { outcome: 'exited', exitCode: 0, stdout: 'x'.repeat(COPY_VALUE_MAX_BYTES + 1), stderr: '', truncated: true },
        'bad_request',
        'more than',
      ],
      [
        { outcome: 'exited', exitCode: 0, stdout: 'é'.repeat(9_000), stderr: '', truncated: false },
        'bad_request',
        'more than',
      ],
    ];
    for (const [outcome, code, words] of cases) {
      const { service, runner, masking } = world();
      runner.outcome = outcome;
      const error = await refusal(service.capture('s1', command()));
      should(error.code).equal(code);
      should(error.message).containEql(words);
      should(service.heldCount()).equal(0);
      should(masking.heldCount()).equal(0);
    }
  });

  it('should refuse a page or clipboard copy until the browser phase', async () => {
    const { service, runner } = world();

    const clipboard = await refusal(
      service.capture('s1', { name: 'token', source: { kind: 'clipboard', key: 'app' } }),
    );
    const page = await refusal(
      service.capture('s1', { name: 'token', source: { kind: 'browser', key: 'app', ref: 'e1', read: 'text' } }),
    );

    should([clipboard.code, page.code]).eql(['unavailable', 'unavailable']);
    should(runner.specs).eql([]);
  });
});

describe('SecureCopyService limits', () => {
  it('should refuse a second live copy under one name, and allow it again once the first is discarded', async () => {
    const { service } = world();
    await service.capture('s1', command());

    should((await refusal(service.capture('s1', command()))).code).equal('conflict');
    service.discard('s1', 'token');
    should((await service.capture('s1', command())).copy.state).equal('live');
  });

  it("should keep one session's names apart from another's", async () => {
    const { service, folders } = world();
    folders.set('s2', '/work/s2');
    await service.capture('s1', command());

    should((await service.capture('s2', command())).copy.state).equal('live');
    should(service.list('s2')).have.length(1);
  });

  it('should hold at most the live cap per session', async () => {
    const { service } = world();
    for (let index = 0; index < COPY_MAX_LIVE_PER_SESSION; index += 1)
      await service.capture('s1', { ...command(), name: `t${String(index)}` });

    should((await refusal(service.capture('s1', { ...command(), name: 'one-more' }))).code).equal('capacity');
  });

  it('should count every capture attempt in the hour, failed ones too, and allow more once the hour passes', async () => {
    const { service, runner, clock } = world();
    runner.outcome = { ...runner.outcome, exitCode: 1 };
    for (let index = 0; index < COPY_MAX_CAPTURES_PER_HOUR; index += 1) await refusal(service.capture('s1', command()));
    runner.outcome = { ...runner.outcome, exitCode: 0 };

    const error = await refusal(service.capture('s1', command()));
    should(error.code).equal('capacity');
    should(runner.specs).have.length(COPY_MAX_CAPTURES_PER_HOUR);
    clock.ms += 3_600_001;
    should((await service.capture('s1', command())).copy.state).equal('live');
  });
});

describe('SecureCopyService lifetime', () => {
  it('should let go of the value on discard, keep it listed and masked for the after-mask window, then forget it', async () => {
    const { service, masking, clock } = world();
    await service.capture('s1', command());

    const discarded = service.discard('s1', 'token');

    should(discarded.state).equal('discarded');
    should(service.heldCount('s1')).equal(0);
    should(masking.scrub('s1', TOKEN)).equal('[sealed:token]');
    should(service.discard('s1', 'token')).eql(discarded);
    clock.ms += COPY_AFTER_MASK_SECONDS * 1000;
    should(masking.scrub('s1', TOKEN)).equal(TOKEN);
    should(service.list('s1')).eql([]);
    should((await refusal(Promise.resolve().then(() => service.discard('s1', 'token')))).code).equal('not_found');
  });

  it('should expire a copy at its time, list it as expired, and forget it after the after-mask window', async () => {
    const { service, clock } = world();
    await service.capture('s1', { ...command(), expiresInSeconds: 60 });

    clock.ms += 60_000;
    should(service.list('s1').map(copy => copy.state)).eql(['expired']);
    should(service.heldCount()).equal(0);
    clock.ms += COPY_AFTER_MASK_SECONDS * 1000;
    service.purge();
    should(service.sessions()).eql([]);
  });

  it('should drop every copy of a session that ended', async () => {
    const { service } = world();
    await service.capture('s1', command());

    service.drop('s1');

    should(service.heldCount()).equal(0);
    should(service.list('s1')).eql([]);
  });

  it('should list copies oldest first', async () => {
    const { service, clock } = world();
    await service.capture('s1', { ...command(), name: 'b' });
    clock.ms += 1;
    await service.capture('s1', { ...command(), name: 'a' });

    should(service.list('s1').map(copy => copy.handle)).eql(['sealed:b', 'sealed:a']);
  });
});

describe('SecureCopyService under the security review', () => {
  it('should let only one of two captures under one name run, and count a running one against the live cap', async () => {
    const { service, runner } = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const slow = runner.run.bind(runner);
    runner.run = async spec => {
      await gate;
      return await slow(spec);
    };

    const first = service.capture('s1', command());
    const second = await refusal(service.capture('s1', command()));
    for (let index = 1; index < COPY_MAX_LIVE_PER_SESSION; index += 1)
      void service.capture('s1', { ...command(), name: `t${String(index)}` });
    const over = await refusal(service.capture('s1', { ...command(), name: 'one-too-many' }));
    release();
    await first;

    should(second.code).equal('conflict');
    should(over.code).equal('capacity');
    should(runner.specs.length).equal(COPY_MAX_LIVE_PER_SESSION);
  });

  it('should withhold stderr that holds a piece of the value, not just mask the whole of it', async () => {
    const { service, runner } = world();
    runner.outcome = { ...runner.outcome, exitCode: 1, stderr: `error: bad prefix ${TOKEN.slice(0, 9)}… try again` };

    const error = await refusal(service.capture('s1', command()));

    should(error.message).equal(
      'The command exited with 1; nothing was copied. It said on stderr: [withheld: it held part of sealed:token]',
    );
    should(error.message).not.containEql(TOKEN.slice(0, 9));
  });
});

describe('SecureCopyService and a short value', () => {
  it('should mask a short value whole in stderr, and keep stderr that holds none of it', async () => {
    const { service, runner } = world();
    runner.outcome = { outcome: 'exited', exitCode: 0, stdout: 'ab12', stderr: 'printed ab12 once', truncated: false };

    const { command: report } = await service.capture('s1', command());

    should(report?.stderr).equal('printed [sealed:token] once');
  });
});

describe('SecureCopyService under the re-review', () => {
  it('should mask a copy kept with its newline in every spelling: stderr, reads, and the transcript check', async () => {
    const { service, runner, masking } = world();
    runner.outcome = {
      outcome: 'exited',
      exitCode: 0,
      stdout: `${TOKEN}\n`,
      stderr: `token ${TOKEN} minted`,
      truncated: false,
    };

    const { command: report } = await service.capture('s1', command(['x'], { trim: false }));

    should(report?.stderr).equal('token [sealed:token] minted');
    should(masking.scrub('s1', `see ${TOKEN} here`)).equal('see [sealed:token] here');
    should(JSON.stringify(report)).not.containEql(TOKEN);
  });

  it('should call a copy seen when the transcript holds it without its newline', async () => {
    const { runner } = world();
    const seen = new SecureCopyService({
      clock: { now: () => Date.parse('2026-10-31T09:00:00.000Z') },
      runner,
      folders: { folderOf: async () => '/work' },
      exposure: { transcriptHolds: async (_session, value) => (value === TOKEN ? 'found' : 'clean') },
      masking: new EphemeralValues({ now: () => Date.parse('2026-10-31T09:00:00.000Z') }),
      redact: async text => text,
    });
    runner.outcome = { ...runner.outcome, stdout: `${TOKEN}\n` };

    should((await seen.capture('s1', command(['x'], { trim: false }))).copy.exposure.transcript).equal('found');
  });

  it('should hold the value before stderr goes through the redactor', async () => {
    const clock = { now: () => Date.parse('2026-10-31T09:00:00.000Z') };
    const masking = new EphemeralValues(clock);
    const masked: boolean[] = [];
    const service = new SecureCopyService({
      clock,
      runner: {
        run: async () => ({ outcome: 'exited', exitCode: 0, stdout: TOKEN, stderr: 'a warning', truncated: false }),
      },
      folders: { folderOf: async () => '/work' },
      exposure: { transcriptHolds: async () => 'clean' },
      masking,
      redact: async text => {
        masked.push(masking.scrub('s1', TOKEN) !== TOKEN);
        return text;
      },
    });

    await service.capture('s1', command());

    should(masked).eql([true]);
  });

  it('should keep a short token whose command wrote a long stderr', async () => {
    const { service, runner } = world();
    runner.outcome = { outcome: 'exited', exitCode: 0, stdout: TOKEN, stderr: 'w'.repeat(20_000), truncated: true };

    should((await service.capture('s1', command())).copy.state).equal('live');
  });

  it('should refuse a value too short to seal and mask safely', async () => {
    const { service, runner, masking } = world();
    runner.outcome = { ...runner.outcome, stdout: 'ab1\n' };

    const error = await refusal(service.capture('s1', command()));

    should(error.message).containEql('fewer than 4 characters');
    should(masking.heldCount()).equal(0);
  });
});
