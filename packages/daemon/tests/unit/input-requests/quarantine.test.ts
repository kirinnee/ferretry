import { describe, it } from 'bun:test';
import should from 'should';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';

const SESSION = 'mvv6b4qw-49d0158d';

function registry(window = 120_000) {
  const clock = { ms: 1_000_000 };
  return { clock, quarantine: new QuarantineRegistry({ now: () => clock.ms }, window) };
}

const settled = (quarantine: QuarantineRegistry, session: string, names: string[]): number => {
  const hold = quarantine.begin(session, names, 'req');
  return quarantine.settle(hold);
};

describe('QuarantineRegistry', () => {
  it('should hold a terminal under every name it is known by, until the window ends', () => {
    const { clock, quarantine } = registry();

    const until = settled(quarantine, SESSION, ['dev', '000000000001']);

    should(until).equal(1_120_000);
    should(quarantine.until(SESSION, ['000000000001'])).equal(until);
    should(quarantine.until(SESSION, [undefined, 'dev'])).equal(until);
    should(quarantine.until(SESSION, ['other'])).be.undefined();
    should(quarantine.until('x-1', ['dev'])).be.undefined();
    clock.ms = until;
    should(quarantine.until(SESSION, ['dev'])).be.undefined();
    should(quarantine.sessions()).eql([]);
  });

  it('should keep a hold in flight open for a full window from now, however long the delivery takes', () => {
    const { clock, quarantine } = registry();
    const hold = quarantine.begin(SESSION, ['dev'], 'req');

    clock.ms += 10 * 120_000;

    should(quarantine.until(SESSION, ['dev'])).equal(clock.ms + 120_000);
    should(quarantine.list(SESSION)).eql([{ key: 'dev', until: clock.ms + 120_000 }]);
    const until = quarantine.settle(hold);
    clock.ms += 119_999;
    should(quarantine.until(SESSION, ['dev'])).equal(until);
  });

  it('should settle a hold that was lost back into the registry', () => {
    const { quarantine } = registry();
    const hold = quarantine.begin(SESSION, ['dev'], 'req');
    quarantine.drop(SESSION);

    const until = quarantine.settle(hold);

    should(quarantine.until(SESSION, ['dev'])).equal(until);
  });

  it('should add a hold for the same terminal rather than replace the one before it', () => {
    const { clock, quarantine } = registry();
    const first = settled(quarantine, SESSION, ['dev', 'a']);
    clock.ms += 60_000;

    const second = settled(quarantine, SESSION, ['a', 'b']);

    should(quarantine.list(SESSION).length).equal(2);
    should(quarantine.until(SESSION, ['dev'])).equal(first);
    should(quarantine.until(SESSION, ['a'])).equal(second);
    should(quarantine.until(SESSION, ['b'])).equal(second);
  });

  it('should let a failed attempt release only its own hold, never an earlier delivery', () => {
    const { clock, quarantine } = registry();
    const delivered = settled(quarantine, SESSION, ['dev', 'a']);
    clock.ms += 30_000;
    const failed = quarantine.begin(SESSION, ['dev', 'a'], 'req');

    const remaining = quarantine.release(failed);

    should(remaining).equal(delivered);
    should(quarantine.until(SESSION, ['dev'])).equal(delivered);
  });

  it('should say nothing is left when the only hold is released', () => {
    const { quarantine } = registry();
    const hold = quarantine.begin(SESSION, ['dev'], 'req');

    should(quarantine.release(hold)).be.undefined();
    should(quarantine.sessions()).eql([]);
  });

  it('should end every settled hold on a terminal and give back each hold it released, by id', () => {
    const { quarantine } = registry();
    settled(quarantine, SESSION, ['dev', 'a']);
    settled(quarantine, SESSION, ['a', 'b']);
    settled(quarantine, SESSION, ['logs']);

    should((quarantine.end(SESSION, 'a') ?? []).flatMap(hold => hold.names).sort()).eql(['a', 'a', 'b', 'dev']);
    should(quarantine.end(SESSION, 'a')).be.undefined();
    should(quarantine.list(SESSION).map(entry => entry.key)).eql(['logs']);
    should((quarantine.end(SESSION, 'logs') ?? []).flatMap(hold => hold.names)).eql(['logs']);
    should(quarantine.sessions()).eql([]);
    should(quarantine.end('x-1', 'dev')).be.undefined();
  });

  it('should not let the owner end a hold on a delivery in flight', () => {
    const { quarantine } = registry();
    quarantine.begin(SESSION, ['dev'], 'req');

    should(quarantine.end(SESSION, 'dev')).be.undefined();
    should(quarantine.until(SESSION, ['dev'])).not.be.undefined();
  });

  it('should list what is held and forget a whole session', () => {
    const { quarantine } = registry();
    settled(quarantine, SESSION, ['dev']);
    settled(quarantine, 'x-1', ['dev']);

    should([...quarantine.sessions()].sort()).eql([SESSION, 'x-1']);
    quarantine.drop(SESSION);
    should(quarantine.list(SESSION)).eql([]);
    should(quarantine.list('x-1').length).equal(1);
  });

  it('should bring a quarantine back with its old end time, and ignore one that already ended or has no name', () => {
    const { clock, quarantine } = registry();

    quarantine.restore(SESSION, ['dev'], clock.ms + 30_000, 'r/1');
    quarantine.restore(SESSION, ['old'], clock.ms - 1, 'r/2');
    quarantine.restore(SESSION, [], clock.ms + 30_000, 'r/3');

    should(quarantine.list(SESSION)).eql([{ key: 'dev', until: clock.ms + 30_000 }]);
  });

  it('should drop only the entries whose window ended', () => {
    const { clock, quarantine } = registry();
    quarantine.restore(SESSION, ['short'], clock.ms + 10_000, 'r/1');
    quarantine.restore(SESSION, ['long'], clock.ms + 100_000, 'r/2');
    clock.ms += 50_000;

    quarantine.purge();

    should(quarantine.list(SESSION).map(entry => entry.key)).eql(['long']);
  });

  it('should hold every terminal of every session while locked, until unlocked', () => {
    const { quarantine } = registry();

    quarantine.lock();
    should(quarantine.until('x-1', ['anything'])).equal(1_120_000);
    quarantine.unlock();

    should(quarantine.until('x-1', ['anything'])).be.undefined();
  });

  it('should release a timed lock when its time has passed', () => {
    const { clock, quarantine } = registry();
    quarantine.lock(clock.ms + 5_000);

    should(quarantine.until(SESSION, ['dev'])).not.be.undefined();
    clock.ms += 5_000;
    should(quarantine.until(SESSION, ['dev'])).be.undefined();
  });

  it('should hold every terminal of one session, and none of another, when its replay failed', () => {
    const { clock, quarantine } = registry();

    quarantine.lockSession(SESSION);

    should(quarantine.until(SESSION, ['anything'])).equal(clock.ms + 120_000);
    should(quarantine.until('x-1', ['anything'])).be.undefined();
    should(quarantine.list(SESSION)).eql([]);
    clock.ms += 120_000;
    should(quarantine.until(SESSION, ['anything'])).be.undefined();
  });

  it('should return the holds a settle released, each by its own id, and leave a hold in flight alone', () => {
    const { quarantine } = registry();
    const a = quarantine.begin(SESSION, ['dev', 'a'], 'req');
    quarantine.settle(a);
    const b = quarantine.begin(SESSION, ['dev', 'a'], 'req');

    const released = quarantine.end(SESSION, 'dev') ?? [];

    should(released.map(hold => hold.id)).eql([a.id]);
    should(released[0]?.names).eql(['dev', 'a']);
    should(quarantine.unresolved(SESSION).map(hold => hold.id)).eql([b.id]);
    should(quarantine.until(SESSION, ['a'])).not.be.undefined();
  });

  it('should mint ids that never collide with a restored hold after a restart', () => {
    const { clock, quarantine } = registry();
    const restored = quarantine.restore(SESSION, ['dev', 'a'], 'in-flight', 'req/1');

    const fresh = quarantine.begin(SESSION, ['other'], 'req');

    should(restored?.id).equal('req/1');
    should(fresh.id).not.equal('req/1');
    should(quarantine.unresolved(SESSION).map(hold => hold.id)).eql(['req/1', fresh.id]);
    should(quarantine.until(SESSION, ['a'])).equal(clock.ms + 120_000);
  });

  it('should leave a live hold as it is when a replay names its id, and still bring back what it minted nothing for', () => {
    const { clock, quarantine } = registry();
    quarantine.lock();
    const live = quarantine.begin(SESSION, ['dev', '000000000001'], 'req');

    const again = quarantine.restore(SESSION, ['dev', '000000000001'], 'in-flight', live.id);
    const other = quarantine.restore(SESSION, ['old'], 'in-flight', 'gone/1');
    quarantine.unlock();

    should(again).be.undefined();
    should(other?.id).equal('gone/1');
    should(quarantine.unresolved(SESSION).map(hold => hold.id)).eql([live.id, 'gone/1']);
    quarantine.settle(live);
    clock.ms += 1;
    should(quarantine.unresolved(SESSION).map(hold => hold.id)).eql(['gone/1']);
  });

  it('should not let a replay replace a hold already in the registry under that id', () => {
    const { quarantine } = registry();
    quarantine.restore(SESSION, ['a'], 'in-flight', 'r/1');

    const again = quarantine.restore(SESSION, ['b'], 'in-flight', 'r/1');

    should(again).be.undefined();
    should(quarantine.until(SESSION, ['b'])).be.undefined();
  });

  it('should restore an unresolved hold with all its names, holding until it is settled to a fresh window', () => {
    const { clock, quarantine } = registry();
    quarantine.lock();
    const hold = quarantine.restore(SESSION, ['dev', '000000000001'], 'in-flight', 'req/9');
    clock.ms += 10 * 120_000;

    should(quarantine.until(SESSION, ['000000000001'])).equal(clock.ms + 120_000);
    should(quarantine.until(SESSION, ['dev'])).equal(clock.ms + 120_000);
    const until = quarantine.settle(hold as NonNullable<typeof hold>);
    quarantine.unlock();
    should(until).equal(clock.ms + 120_000);
    should(quarantine.unresolved(SESSION)).eql([]);
    clock.ms += 120_000;
    should(quarantine.until(SESSION, ['dev'])).be.undefined();
  });
});
