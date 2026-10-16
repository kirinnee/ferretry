import { describe, it } from 'bun:test';
import should from 'should';
import { wardenEventTrigger, wardenTriggerEnabled } from '../../../src/lib/warden/index.ts';

describe('the events that bring a sweep forward', () => {
  it.each([
    ['session.exited', {}, 'paneDied'],
    ['session.failed', null, 'paneDied'],
    ['turn.state', { from: 'working', to: 'your-turn' }, 'turnEnd'],
    ['turn.state', { from: 'working', to: 'needs-input' }, 'question'],
  ] as const)('should read %s %j as %s', (type, data, expected) => {
    // Act / Assert
    should(wardenEventTrigger(type, data)).equal(expected);
  });

  it.each([
    ['turn.state', { from: 'your-turn', to: 'working' }],
    ['turn.state', { to: null }],
    ['turn.state', 'your-turn'],
    ['turn.state', ['your-turn']],
    ['turn.state', null],
    ['control.send', { to: 'your-turn' }],
  ] as const)('should ignore %s %j', (type, data) => {
    // Act / Assert
    should(wardenEventTrigger(type, data)).be.undefined();
  });

  it('should react only to the triggers the owner left on', () => {
    // Arrange
    const events = { turnEnd: false, question: true, paneDied: true };

    // Act / Assert
    should(wardenTriggerEnabled('turnEnd', events)).be.false();
    should(wardenTriggerEnabled('question', events)).be.true();
  });
});
