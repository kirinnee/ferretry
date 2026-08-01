import { describe, it } from 'bun:test';
import should from 'should';
import {
  TerminalReapService,
  type ExactTerminalReaper,
  type RegisteredPaneObserver,
  type TerminalPaneRegistry,
  type TerminalReapSessionDirectory,
} from '../../../src/lib/session/reap-service.ts';
import type {
  DurableTerminalSession,
  ObservedTerminalPane,
  RegisteredTerminalPane,
  TerminalReapTarget,
} from '../../../src/lib/session/reap.ts';

const DAEMON = 'daemon-a';
const PANE: RegisteredTerminalPane = {
  daemonId: DAEMON,
  sessionId: 'msa1ny28-4f0f298e',
  tmuxSession: 'fy-msa1ny28-4f0f298e',
  paneId: '%41',
  pid: 812,
  processStartTicks: 1_002_003,
};
const SESSION: DurableTerminalSession = {
  daemonId: DAEMON,
  sessionId: PANE.sessionId,
  status: 'completed',
  finishedAt: '2026-08-01T10:00:00.000Z',
};

class Registry implements TerminalPaneRegistry {
  constructor(readonly values: readonly RegisteredTerminalPane[]) {}
  async list(): Promise<readonly RegisteredTerminalPane[]> {
    return this.values;
  }
}

class Sessions implements TerminalReapSessionDirectory {
  constructor(readonly values: readonly DurableTerminalSession[]) {}
  async list(): Promise<readonly DurableTerminalSession[]> {
    return this.values;
  }
}

class Observer implements RegisteredPaneObserver {
  readonly asked: RegisteredTerminalPane[] = [];
  constructor(private readonly observation: ObservedTerminalPane | undefined) {}
  async observe(registration: RegisteredTerminalPane): Promise<ObservedTerminalPane | undefined> {
    this.asked.push(registration);
    return this.observation;
  }
}

class Reaper implements ExactTerminalReaper {
  readonly targets: TerminalReapTarget[] = [];
  async reap(target: TerminalReapTarget): Promise<void> {
    this.targets.push(target);
  }
}

interface SubjectOptions {
  readonly registrations?: readonly RegisteredTerminalPane[];
  readonly sessions?: readonly DurableTerminalSession[];
  readonly observation?: ObservedTerminalPane;
}

function subject(options: SubjectOptions = {}) {
  const registrations = options.registrations ?? [PANE];
  const sessions = options.sessions ?? [SESSION];
  const observer = new Observer(Object.hasOwn(options, 'observation') ? options.observation : PANE);
  const reaper = new Reaper();
  return {
    observer,
    reaper,
    service: new TerminalReapService(DAEMON, new Registry(registrations), new Sessions(sessions), observer, reaper),
  };
}

describe('TerminalReapService', () => {
  it('should observe and reap only a fully proven registered terminal pane', async () => {
    const harness = subject();

    const result = await harness.service.sweep();

    should(result).deepEqual({ planned: 1, reaped: 1 });
    should(harness.observer.asked).deepEqual([PANE]);
    should(harness.reaper.targets).deepEqual([PANE]);
  });

  it('should not inspect or kill an unregistered pane', async () => {
    const harness = subject({ registrations: [] });

    const result = await harness.service.sweep();

    should(result).deepEqual({ planned: 0, reaped: 0 });
    should(harness.observer.asked).deepEqual([]);
    should(harness.reaper.targets).deepEqual([]);
  });

  it('should not inspect or kill a registration belonging to another daemon', async () => {
    const harness = subject({ registrations: [{ ...PANE, daemonId: 'daemon-b' }] });

    const result = await harness.service.sweep();

    should(result).deepEqual({ planned: 0, reaped: 0 });
    should(harness.observer.asked).deepEqual([]);
    should(harness.reaper.targets).deepEqual([]);
  });

  it('should not kill when durable state or the exact observed incarnation is missing', async () => {
    const unfinished = subject({ sessions: [{ ...SESSION, status: 'running' }] });
    const missingObservation = subject({ observation: undefined });
    const recycled = subject({ observation: { ...PANE, processStartTicks: PANE.processStartTicks + 1 } });

    await unfinished.service.sweep();
    await missingObservation.service.sweep();
    await recycled.service.sweep();

    should(unfinished.reaper.targets).deepEqual([]);
    should(missingObservation.reaper.targets).deepEqual([]);
    should(recycled.reaper.targets).deepEqual([]);
  });
});
