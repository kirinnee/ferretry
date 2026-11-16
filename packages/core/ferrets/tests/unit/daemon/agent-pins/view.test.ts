import { describe, it } from 'bun:test';
import should from 'should';
import { withPinned } from '../../../../daemon/lib/agent-pins/view.ts';
import { ferretSummary } from '../support/calls.ts';

describe('withPinned', () => {
  it('should answer the same ferret object while the ferret and its pin are unchanged', async () => {
    // Arrange
    const held = [ferretSummary('a'), ferretSummary('b')];
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
