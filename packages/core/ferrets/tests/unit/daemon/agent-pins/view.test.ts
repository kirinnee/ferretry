import { describe, it } from 'bun:test';
import should from 'should';
import { withPinned } from '../../../src/lib/agent-pins/view.ts';
import { sessionView } from '../runtime/mounts/support.ts';

describe('withPinned', () => {
  it('should answer the same view object while the view and its pin are unchanged', async () => {
    // Arrange
    const held = [sessionView('a'), sessionView('b')];
    let pins = new Map([['a', '2026-11-01T00:00:00.000Z']]);
    const subject = withPinned({ list: async () => held, get: async () => undefined }, { pinnedAt: async () => pins });
    const first = await subject.list();

    // Act
    const second = await subject.list();
    pins = new Map([['a', '2026-11-02T00:00:00.000Z']]);
    const repinned = await subject.list();

    // Assert
    should(first[0]?.pinnedAt).equal('2026-11-01T00:00:00.000Z');
    should(second[0]).equal(first[0]);
    should(second[1]).equal(first[1]);
    should(repinned[0]).not.equal(first[0]);
    should(repinned[0]?.pinnedAt).equal('2026-11-02T00:00:00.000Z');
    should(repinned[1]).equal(first[1]);
  });
});
