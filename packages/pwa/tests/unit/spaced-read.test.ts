import { describe, it } from 'bun:test';
import should from 'should';
import { AGENDA_SAFETY_NET_MS, changesTheAgenda, SpacedRead } from '../../src/lib/spaced-read.ts';

describe('SpacedRead', () => {
  it('should read on the first ride and then at most once per spacing', () => {
    // Arrange
    let now = 1_000;
    const read = new SpacedRead(AGENDA_SAFETY_NET_MS, () => now);

    // Act
    const rides = [read.take()];
    for (let index = 0; index < 100; index += 1) {
      now += 290;
      rides.push(read.take());
    }

    // Assert: 29 s of transcript reads every 290 ms ride on ONE board read, the 30 s mark on a second.
    should(rides.filter(Boolean)).have.length(1);
    now += 1_000;
    should(read.take()).be.true();
    should(read.take()).be.false();
  });

  it('should read on the next ride once a change was announced', () => {
    // Arrange
    let now = 1_000;
    const read = new SpacedRead(AGENDA_SAFETY_NET_MS, () => now);
    read.take();
    now += 500;

    // Act
    read.reset();

    // Assert
    should(read.take()).be.true();
    should(read.take()).be.false();
  });
});

describe('changesTheAgenda', () => {
  it('should name exactly the board-change events', () => {
    // Arrange
    const types = ['agenda.changed', 'attention.changed', 'session.output', 'control.queue_changed'];

    // Act
    const changes = types.filter(type => changesTheAgenda({ type }));

    // Assert
    should(changes).deepEqual(['agenda.changed', 'attention.changed']);
  });
});
