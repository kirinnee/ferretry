/**
 * The shell refuses an option the resolved verb does not declare, before the verb runs and before any daemon call:
 * `fy restart --outdated --bogus` would restart for real if the verb read only the names it knew and dropped the
 * unknown `--bogus` (`--dry-run` was such a name until `restart` declared it: see the last describe). These run the REAL generated registry through `runFy`; the audit of every verb's reads
 * is `verb-option-audit.test.ts`.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { EXIT } from '../../src/lib/errors.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

async function typed(...argv: string[]) {
  const transport = new RecordingTransport();
  const made = fakeWorld({ registry, transport });
  const code = await runFy(argv, made.world);
  return { code, err: made.io.stderr(), transport, connects: made.connects };
}

const refusal = (option: string, verb: string): string =>
  `unknown option ${option} for "${verb}"; see \`fy ${verb} --help\``;

describe('an undeclared option', () => {
  it('should refuse `restart --outdated --bogus` with the usage code and make no restart call', async () => {
    // Act
    const result = await typed('restart', '--outdated', '--bogus');

    // Assert
    should(result.code).equal(EXIT.usage);
    should(result.err).containEql(refusal('--bogus', 'restart'));
    should(result.transport.sent).deepEqual([]);
    should(result.connects).deepEqual([]);
  });

  it('should refuse it wherever it stands among the options', async () => {
    // Act
    const result = await typed('restart', '--bogus', '--outdated');

    // Assert
    should(result.code).equal(EXIT.usage);
    should(result.transport.sent).deepEqual([]);
  });

  it('should refuse an unknown option on another verb, as typed', async () => {
    // Act
    const longName = await typed('ps', '--bogus');
    const shortName = await typed('ps', '-z');
    const negated = await typed('ps', '--no-bogus');
    const valued = await typed('task', 'show', 'a1', '--nope=1');

    // Assert
    should(longName.err).containEql(refusal('--bogus', 'ps'));
    should(shortName.err).containEql(refusal('-z', 'ps'));
    should(negated.err).containEql(refusal('--no-bogus', 'ps'));
    should(valued.err).containEql(refusal('--nope', 'task show'));
    for (const result of [longName, shortName, negated, valued]) {
      should(result.code).equal(EXIT.usage);
      should(result.transport.sent).deepEqual([]);
      should(result.connects).deepEqual([]);
    }
  });

  it('should name a shell verb’s unknown option too', async () => {
    // Act
    const result = await typed('daemon', 'status', '--bogus');

    // Assert
    should(result.code).equal(EXIT.usage);
    should(result.err).containEql(refusal('--bogus', 'daemon status'));
  });

  it('should refuse one an old spelling’s target does not declare, naming the verb it ran', async () => {
    // Act
    const result = await typed('card', 'show', 'a1', '--bogus');

    // Assert
    should(result.code).equal(EXIT.usage);
    should(result.err).containEql(refusal('--bogus', 'task show'));
  });
});

describe('a declared option', () => {
  it('should pass: `restart --outdated` reaches the daemon', async () => {
    // Act
    const result = await typed('restart', '--outdated');

    // Assert
    should(result.err).not.containEql('unknown option');
    should(result.connects.length).be.above(0);
  });

  it('should pass in every declared spelling: long, short, `=value`, `--no-x`', async () => {
    // Act
    const results = await Promise.all([
      typed('ps', '--all', '--label', 'x', '--json'),
      typed('ps', '-a', '-l', 'x'),
      typed('ps', '--label=x'),
      typed('restart', '--no-outdated'),
      typed('new', '--auto', '--no-fast', '--no-rc', 'brief'),
    ]);

    // Assert
    for (const result of results) should(result.err).not.containEql('unknown option');
  });

  it('should pass when it is hidden: accepted, not listed', async () => {
    // Act
    const result = await typed('start', '--runtime', 'r1', '--card', 'c1', 'do it');

    // Assert
    should(result.err).not.containEql('unknown option');
  });

  it('should pass for a verb that reads its options itself (it refuses its own)', async () => {
    // Act
    const result = await typed('browser', 'status', '--bogus');

    // Assert
    should(result.err).not.containEql('unknown option --bogus for');
  });
});

describe('`restart --dry-run`', () => {
  /** A daemon that answers every call with an empty restart list, and writes down each call it was asked. */
  class Listing extends RecordingTransport {
    override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
      this.sent.push(request);
      this.options.push(options);
      return { status: 200, body: { outdated: [], queued: [], cancelled: 0 } };
    }
  }
  const read = [{ method: 'GET', path: '/v1/restarts' }];
  const dry = async (...argv: string[]) => {
    const transport = new Listing();
    const made = fakeWorld({
      registry,
      transport,
      inventory: {
        protocol: 'x' as never,
        plugins: [
          { id: 'kernel', on: true, contract: registry.kernel.contract },
          ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
        ],
      },
    });
    const code = await runFy(argv, made.world);
    return {
      code,
      err: made.io.stderr(),
      out: made.io.stdout(),
      calls: transport.sent.map(({ method, path }) => ({ method, path })),
    };
  };

  it('should only list what is out of date, with or without --outdated: the one read route, no restart', async () => {
    // Act
    const bare = await dry('restart');
    const results = [
      await dry('restart', '--dry-run'),
      await dry('restart', '--outdated', '--dry-run'),
      await dry('restart', '--dry-run', '--outdated'),
    ];

    // Assert
    should(bare.calls).deepEqual(read);
    for (const result of results) {
      should(result.err).not.containEql('unknown option');
      should(result.code).equal(EXIT.ok);
      should(result.out).equal(bare.out);
      should(result.calls).deepEqual(read);
    }
  });

  it('should not restart or clear anything when it stands beside another mode', async () => {
    // Act
    const results = await Promise.all([dry('restart', '--all', '--dry-run'), dry('restart', '--cancel', '--dry-run')]);

    // Assert
    for (const result of results) should(result.calls).deepEqual(read);
  });
});

describe('the options every verb accepts', () => {
  it('should pass `--help` and `-h` (the help answers before anything runs)', async () => {
    // Act
    const long = await typed('restart', '--bogus', '--help');
    const short = await typed('ps', '--bogus', '-h');

    // Assert
    should(long.code).equal(EXIT.ok);
    should(short.code).equal(EXIT.ok);
  });

  it('should pass `--as-owner`, the root flag today’s fy lists as inherited by every command', async () => {
    // Act
    const result = await typed('ps', '--as-owner');

    // Assert
    should(result.err).not.containEql('unknown option');
  });
});

describe('`--`', () => {
  it('should still end the options: what follows is text, not an option', async () => {
    // Act
    const result = await typed('send', 'a1', '--', '--bogus', 'text');

    // Assert
    should(result.err).not.containEql('unknown option');
  });

  it('should refuse an option written before it', async () => {
    // Act
    const result = await typed('send', 'a1', '--bogus', '--', 'text');

    // Assert
    should(result.code).equal(EXIT.usage);
    should(result.err).containEql(refusal('--bogus', 'send'));
  });
});
