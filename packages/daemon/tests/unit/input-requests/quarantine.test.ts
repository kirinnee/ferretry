import { describe, it } from 'bun:test';
import should from 'should';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';

const SESSION = 'mvv6b4qw-49d0158d';

function registry(window = 120_000) {
  const clock = { ms: 1_000_000 };
  return { clock, quarantine: new QuarantineRegistry({ now: () => clock.ms }, window) };
}

describe('QuarantineRegistry', () => {
  it('should hold a terminal under every name it is known by, until the window ends', () => {
    const { clock, quarantine } = registry();

    const until = quarantine.start(SESSION, ['dev', '000000000001']);

    should(until).equal(1_120_000);
    should(quarantine.until(SESSION, ['000000000001'])).equal(until);
    should(quarantine.until(SESSION, [undefined, 'dev'])).equal(until);
    should(quarantine.until(SESSION, ['other'])).be.undefined();
    should(quarantine.until('x-1', ['dev'])).be.undefined();
    clock.ms = until;
    should(quarantine.until(SESSION, ['dev'])).be.undefined();
    should(quarantine.sessions()).eql([]);
  });

  it('should extend one entry rather than add a second when the same terminal is held again', () => {
    const { clock, quarantine } = registry();
    quarantine.start(SESSION, ['dev', 'a']);
    clock.ms += 60_000;

    const until = quarantine.start(SESSION, ['a', 'b']);

    should(quarantine.list(SESSION)).eql([{ key: 'a', until }]);
    should(quarantine.until(SESSION, ['dev'])).be.undefined();
    should(quarantine.until(SESSION, ['b'])).equal(until);
  });

  it('should end one terminal and give back the names it was known by', () => {
    const { quarantine } = registry();
    quarantine.start(SESSION, ['dev', 'a']);
    quarantine.start(SESSION, ['logs']);

    should(quarantine.end(SESSION, 'a')).eql(['dev', 'a']);
    should(quarantine.end(SESSION, 'a')).be.undefined();
    should(quarantine.list(SESSION).map(entry => entry.key)).eql(['logs']);
    should(quarantine.end(SESSION, 'logs')).eql(['logs']);
    should(quarantine.sessions()).eql([]);
    should(quarantine.end('x-1', 'dev')).be.undefined();
  });

  it('should list what is held and forget a whole session', () => {
    const { quarantine } = registry();
    quarantine.start(SESSION, ['dev']);
    quarantine.start('x-1', ['dev']);

    should([...quarantine.sessions()].sort()).eql([SESSION, 'x-1']);
    quarantine.drop(SESSION);
    should(quarantine.list(SESSION)).eql([]);
    should(quarantine.list('x-1').length).equal(1);
  });

  it('should bring a quarantine back with its old end time, and ignore one that already ended or has no name', () => {
    const { clock, quarantine } = registry();

    quarantine.restore(SESSION, ['dev'], clock.ms + 30_000);
    quarantine.restore(SESSION, ['old'], clock.ms - 1);
    quarantine.restore(SESSION, [], clock.ms + 30_000);

    should(quarantine.list(SESSION)).eql([{ key: 'dev', until: clock.ms + 30_000 }]);
  });

  it('should drop only the entries whose window ended', () => {
    const { clock, quarantine } = registry();
    quarantine.restore(SESSION, ['short'], clock.ms + 10_000);
    quarantine.restore(SESSION, ['long'], clock.ms + 100_000);
    clock.ms += 50_000;

    quarantine.purge();

    should(quarantine.list(SESSION).map(entry => entry.key)).eql(['long']);
  });
});
