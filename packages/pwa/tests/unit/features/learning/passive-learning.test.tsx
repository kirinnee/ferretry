import { describe, expect, it } from 'bun:test';
import type { LearningScanScope } from '@ferretry/protocol';
import {
  learningSessionActions,
  PassiveLearningChip,
  type PassiveLearningState,
  switchPassiveLearning,
  usePassiveLearning,
} from '../../../../src/features/learning/passive-learning.tsx';
import { interact, mount } from '../../../support/dom.ts';
import { AT, fakeLearningDaemon, learningDaemon } from '../../../support/learning.ts';
import { textOf, waitFor } from '../../../support/learning-dom.ts';

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

  it('renders the chip', async () => {
    const view = await mount(<PassiveLearningChip />);
    expect(textOf(view.container)).toBe('Learning: passive');
    await view.unmount();
  });

  it('describes the two Actions-menu entries and runs their handlers', async () => {
    const toggled: boolean[] = [];
    const scans: LearningScanScope[] = [];
    const handlers = { onTogglePassive: (next: boolean) => toggled.push(next), onScan: (s: LearningScanScope) => scans.push(s) };
    const off = learningSessionActions('s-1', undefined, handlers);
    expect(off.map(action => [action.id, action.kind, action.label])).toEqual([
      ['passive-learning', 'toggle', 'Passive learning'],
      ['scan-ferret', 'action', 'Scan this ferret for lessons…'],
    ]);
    const [toggle, scan] = off;
    expect(toggle?.kind === 'toggle' && toggle.checked).toBe(false);
    expect(toggle?.detail).toContain('Off');
    toggle?.run();
    scan?.run();
    const on = learningSessionActions('s-1', { sessionId: 's-1', passive: true, since: AT, setBy: 'owner' }, handlers);
    expect(on[0]?.detail).toContain('On');
    on[0]?.run();
    expect(toggled).toEqual([true, false]);
    expect(scans).toEqual([{ kind: 'sessions', sessionIds: ['s-1'] }]);
    expect(await switchPassiveLearning(learningDaemon, 's-1', true, fakeLearningDaemon().fetch)).toBe(
      'Re-instructed; it costs one turn.',
    );
  });
});
