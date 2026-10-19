import { describe, expect, it } from 'bun:test';
import {
  PASSIVE_LEARNING_LABEL,
  PassiveLearningMark,
  type PassiveLearningState,
  usePassiveLearning,
} from '../../../../src/features/learning/passive-learning.tsx';
import { interact, mount } from '../../../support/dom.ts';
import { AT, fakeLearningDaemon, learningDaemon } from '../../../support/learning.ts';
import { waitFor } from '../../../support/learning-dom.ts';

describe('passive learning per ferret', () => {
  it('reads which ferrets learn, re-reads on its interval, and records a switch', async () => {
    const daemon = fakeLearningDaemon();
    daemon.state.sessions = [{ sessionId: 'a', passive: true, since: AT, setBy: 'default' }];
    let state: PassiveLearningState | undefined;
    function Probe() {
      state = usePassiveLearning(learningDaemon, daemon.fetch, 5);
      return null;
    }
    const view = await mount(<Probe />);
    await waitFor(() => state?.passive.has('a') === true, 'the first read');
    const reads = () => daemon.calls.filter(call => call.path === '/v1/learning/sessions').length;
    await waitFor(() => reads() >= 3, 'the interval re-reading');
    let note = '';
    await interact(async () => {
      note = (await state?.set('b', true))?.note ?? '';
    });
    expect(note).toBe('Re-instructed; it costs one turn.');
    expect(state?.passive.has('b')).toBe(true);
    await view.unmount();
  });

  it('treats a daemon without the route as nobody learning', async () => {
    const daemon = fakeLearningDaemon();
    daemon.once('GET /v1/learning/sessions', { status: 404, body: { error: 'not found' } });
    let state: PassiveLearningState | undefined;
    function Probe() {
      state = usePassiveLearning(learningDaemon, daemon.fetch);
      return null;
    }
    const view = await mount(<Probe />);
    await waitFor(() => daemon.calls.length === 1, 'the read');
    expect(state?.sessions).toBeNull();
    expect(state?.passive.size).toBe(0);
    // A switch that answers after the probe is gone changes nothing.
    const pending = state?.set('a', true);
    await view.unmount();
    await pending;
  });

  it('renders only the cap, with the whole state in its name and tooltip', async () => {
    const view = await mount(<PassiveLearningMark />);
    const mark = view.container.querySelector('[data-learning-passive]');
    expect(mark?.textContent).toBe('');
    expect(mark?.querySelector('svg')).not.toBeNull();
    expect(mark?.getAttribute('role')).toBe('img');
    expect(mark?.getAttribute('aria-label')).toBe(PASSIVE_LEARNING_LABEL);
    expect(mark?.getAttribute('title')).toBe(PASSIVE_LEARNING_LABEL);
    expect(PASSIVE_LEARNING_LABEL.startsWith('Learning: passive')).toBe(true);
    await view.unmount();
  });
});
