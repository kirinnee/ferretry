import { describe, expect, it } from 'bun:test';
import {
  type MachineLearners,
  PASSIVE_LEARNING_LABEL,
  PassiveLearningMark,
  type PassiveLearningState,
  useMachinesPassiveLearning,
  usePassiveLearning,
} from '../../../../src/features/learning/passive-learning.tsx';
import { type DaemonConnection, daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import type { DaemonFetch } from '../../../../src/lib/runtime-models.ts';
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

describe('passive learning on every listed machine', () => {
  const studio = daemonConnection({ daemonId: 'daemon/studio', baseUrl: 'https://studio.example.test', deviceId: 's' });
  const laptop = daemonConnection({ daemonId: 'daemon/laptop', baseUrl: 'https://laptop.example.test', deviceId: 'l' });
  const learner = (sessionId: string, passive = true) => ({ sessionId, passive, since: AT, setBy: 'owner' });

  /** Two machines that answer at their own address; a third host refuses, like a daemon without the route. */
  const machines = (answers: Record<string, unknown[]>) => {
    const reads: string[] = [];
    let gate: Promise<void> = Promise.resolve();
    const fetch: DaemonFetch = async input => {
      const url = new URL(String(input));
      reads.push(url.host);
      await gate;
      const answer = answers[url.host];
      return answer === undefined ? Response.json({ error: 'not found' }, { status: 404 }) : Response.json(answer);
    };
    return { fetch, reads, hold: (held: Promise<void>) => (gate = held) };
  };

  it('keeps each machine’s learners under its own id, re-reads them, and drops a machine that left', async () => {
    // The same id on both machines: only the studio's "a" learns.
    const daemons = machines({
      'studio.example.test': [learner('a'), learner('quiet', false)],
      'laptop.example.test': [learner('a', false), learner('b')],
    });
    let learners: MachineLearners | undefined;
    function Probe({ listed }: { readonly listed: readonly DaemonConnection[] }) {
      learners = useMachinesPassiveLearning(listed, daemons.fetch, 5);
      return null;
    }
    const view = await mount(<Probe listed={[studio, laptop]} />);
    await waitFor(() => learners?.size === 2, 'both machines answering');
    expect([...(learners?.get(studio.daemonId) ?? [])]).toEqual(['a']);
    expect([...(learners?.get(laptop.daemonId) ?? [])]).toEqual(['b']);
    await waitFor(() => daemons.reads.filter(host => host === 'laptop.example.test').length >= 3, 'the re-reads');

    await view.render(<Probe listed={[studio]} />);
    await waitFor(() => learners?.size === 1, 'the laptop leaving');
    expect(learners?.has(studio.daemonId)).toBe(true);
    await view.unmount();
  });

  it('marks nobody on a machine without the route, and writes nothing after it is gone', async () => {
    const other = daemonConnection({ daemonId: 'daemon/old', baseUrl: 'https://old.example.test', deviceId: 'o' });
    const daemons = machines({ 'studio.example.test': [learner('a')] });
    let learners: MachineLearners | undefined;
    function Probe() {
      learners = useMachinesPassiveLearning([other, studio], daemons.fetch);
      return null;
    }
    const view = await mount(<Probe />);
    await waitFor(() => learners?.size === 1, 'the studio answering');
    expect(learners?.has(other.daemonId)).toBe(false);

    let release = (): void => undefined;
    daemons.hold(new Promise<void>(resolve => (release = resolve)));
    const held = await mount(<Probe />);
    await waitFor(() => daemons.reads.length >= 4, 'the held reads');
    await held.unmount();
    await interact(async () => {
      release();
      await Promise.resolve();
    });
    await view.unmount();
  });
});
