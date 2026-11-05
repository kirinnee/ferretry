/**
 * Proves the command-palette rendezvous: a request reaches a listening Live control, stops when it leaves,
 * and reaches nobody when nobody listens.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { LIVE_VOICE_TOGGLE_EVENT, onLiveToggle, requestLiveToggle } from '../../../src/lib/voice-chat/live-command.ts';

describe('live voice command', () => {
  it('reaches the control that listens, until it stops listening', () => {
    const target = new EventTarget();
    let toggles = 0;
    const stop = onLiveToggle(target, () => void (toggles += 1));
    requestLiveToggle(target);
    requestLiveToggle(target);
    should(toggles).equal(2);
    stop();
    requestLiveToggle(target);
    should(toggles).equal(2);
  });

  it('is a plain event with a stable name, and harmless with no listener', () => {
    const target = new EventTarget();
    const seen: string[] = [];
    target.addEventListener(LIVE_VOICE_TOGGLE_EVENT, event => void seen.push(event.type));
    requestLiveToggle(target);
    should(seen).deepEqual(['fy:live-voice-toggle']);
    requestLiveToggle(new EventTarget());
  });
});
