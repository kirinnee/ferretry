import { describe, expect, it } from 'bun:test';
import { type PassiveLessonsState, usePassiveLessons } from '../../../app/src/passive.tsx';
import { interact, mount } from '../../support/app/dom.ts';
import { AT, fakeLessonsDaemon } from '../../support/app/lessons.ts';
import { waitFor } from '../../support/app/dom-helpers.ts';

describe('passive lessons per ferret', () => {
  it('reads which ferrets learn, re-reads on its interval, and records a switch', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.state.ferrets = [{ ferretId: 'a', passive: true, since: AT, setBy: 'default' }];
    let state: PassiveLessonsState | undefined;
    function Probe() {
      state = usePassiveLessons(daemon.connection, 5);
      return null;
    }
    const view = await mount(<Probe />);
    await waitFor(() => state?.passive.has('a') === true, 'the first read');
    const reads = () => daemon.calls.filter(call => call.route === 'GET /v1/lessons/ferrets').length;
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
    const daemon = fakeLessonsDaemon();
    daemon.once('GET /v1/lessons/ferrets', { refuse: { status: 404, code: 'not_found', message: 'not found' } });
    let state: PassiveLessonsState | undefined;
    function Probe() {
      state = usePassiveLessons(daemon.connection);
      return null;
    }
    const view = await mount(<Probe />);
    await waitFor(() => daemon.calls.length === 1, 'the read');
    expect(state?.records).toBeNull();
    expect(state?.passive.size).toBe(0);
    // A switch that answers after the probe is gone changes nothing.
    const pending = state?.set('a', true);
    await view.unmount();
    await pending;
  });
});
