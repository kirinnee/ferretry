import { describe, it } from 'bun:test';
import {
  type DaemonServiceFacts,
  type IFyApiClient,
  PERFORMANCE_PROFILE_PATH,
  type PerformanceProfileView,
  PerformanceProfileViewSchema,
  type PerformanceReport,
  renderPerformanceReport,
  type SyscallTrace,
} from '@ferretry/protocol';
import should from 'should';
import { minimalReport } from '../../../../../protocol/tests/performance-report-fixtures.ts';
import {
  type IProfileGateway,
  type ISyscallTracer,
  type ProfileCommandOptions,
  ProfileController,
  ProtocolProfileGateway,
  type SyscallTraceOutcome,
} from '../../../../src/lib/daemon/profile/controller.ts';
import type { IProgress } from '../../../../src/lib/progress/index.ts';
import { RecordingProgress } from '../../progress/fixtures.ts';

const START = Date.parse('2026-10-21T10:00:00.000Z');

const finished = (report: PerformanceReport = minimalReport()): PerformanceProfileView => ({
  state: 'finished',
  id: 'p1',
  report,
});
const running = (seconds: number): PerformanceProfileView => ({
  state: 'running',
  id: 'p1',
  startedAt: new Date(START).toISOString(),
  endsAt: new Date(START + seconds * 1_000).toISOString(),
});

const trace: SyscallTrace = { tool: 'strace', seconds: 30, total: 1, perSecond: 0.03, top: [], executions: [] };

class Harness {
  readonly reports: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly exitCodes: number[] = [];
  readonly sleeps: number[] = [];
  readonly written: Array<{ path: string; text: string }> = [];
  readonly starts: number[] = [];
  readonly views: string[] = [];
  readonly traces: Array<{ pid: number; seconds: number }> = [];
  clock = START;
  startedView: PerformanceProfileView = finished();
  viewAnswers: PerformanceProfileView[] = [];
  pidAnswer: Promise<number | undefined> = Promise.resolve(4242);
  prepared: SyscallTraceOutcome | undefined;
  prepares = 0;
  traceOutcome: SyscallTraceOutcome = { kind: 'traced', trace };

  readonly gateway: IProfileGateway = {
    start: async seconds => {
      this.starts.push(seconds);
      return this.startedView;
    },
    view: async id => {
      this.views.push(id);
      return this.viewAnswers.shift() ?? running(1);
    },
    pid: () => this.pidAnswer,
  };

  readonly tracer: ISyscallTracer = {
    prepare: async () => {
      this.prepares += 1;
      return this.prepared;
    },
    trace: async (pid, seconds) => {
      this.traces.push({ pid, seconds });
      return this.traceOutcome;
    },
  };

  progress: IProgress | undefined;
  service: (() => Promise<DaemonServiceFacts>) | undefined;

  subject(): ProfileController {
    return new ProfileController({
      ...(this.progress === undefined ? {} : { progress: this.progress }),
      ...(this.service === undefined ? {} : { service: this.service }),
      gateway: this.gateway,
      tracer: this.tracer,
      out: {
        report: message => void this.reports.push(message),
        warn: message => void this.warnings.push(message),
        error: message => void this.errors.push(message),
        setExitCode: code => void this.exitCodes.push(code),
      },
      sleep: async ms => {
        this.sleeps.push(ms);
        this.clock += ms;
      },
      now: () => this.clock,
      writeFile: async (path, text) => void this.written.push({ path, text }),
    });
  }
}

describe('ProfileController', () => {
  it.each([['abc'], ['1.5'], ['-5'], ['4'], ['301'], ['']])('should refuse --seconds %j', async seconds => {
    // Arrange
    const harness = new Harness();
    const input: ProfileCommandOptions = { seconds };

    // Act
    await harness.subject().run(input);

    // Assert
    should(harness.errors).deepEqual(['--seconds must be a whole number from 5 to 300']);
    should(harness.exitCodes).deepEqual([1]);
    should(harness.starts).deepEqual([]);
  });

  it.each([
    [undefined, 30],
    ['5', 5],
    [' 300 ', 300],
  ])('should start a window of %j as %d seconds', async (seconds, expected) => {
    // Arrange
    const harness = new Harness();
    const input: ProfileCommandOptions = seconds === undefined ? {} : { seconds };

    // Act
    await harness.subject().run(input);

    // Assert
    should(harness.starts).deepEqual([expected]);
    should(harness.warnings).deepEqual([
      `profiling the daemon for ${String(expected)} s — leave it idle for an idle profile…`,
    ]);
    should(harness.reports).deepEqual([renderPerformanceReport(minimalReport())]);
    should(harness.exitCodes).deepEqual([]);
    should(harness.prepares).equal(0);
  });

  it('should print the protocol document with --json and no progress line', async () => {
    // Arrange
    const harness = new Harness();

    // Act
    await harness.subject().run({ json: true });

    // Assert
    should(harness.warnings).deepEqual([]);
    should(harness.reports).deepEqual([JSON.stringify(minimalReport())]);
  });

  it('should poll a running window after its end until it finishes', async () => {
    // Arrange
    const harness = new Harness();
    harness.startedView = running(10);
    harness.viewAnswers = [running(10), running(10), finished()];

    // Act
    await harness.subject().run({ seconds: '10' });

    // Assert
    should(harness.sleeps).deepEqual([10_000, 1_000, 1_000]);
    should(harness.views).deepEqual(['p1', 'p1', 'p1']);
    should(harness.reports).deepEqual([renderPerformanceReport(minimalReport())]);
  });

  it('should not wait when the window has already ended', async () => {
    // Arrange
    const harness = new Harness();
    harness.startedView = running(10);
    harness.clock = START + 20_000;
    harness.viewAnswers = [finished()];

    // Act
    await harness.subject().run({ seconds: '10' });

    // Assert
    should(harness.sleeps).deepEqual([]);
    should(harness.reports).have.length(1);
  });

  it('should give up a minute past the end of the window', async () => {
    // Arrange
    const harness = new Harness();
    harness.startedView = running(5);
    harness.viewAnswers = Array.from({ length: 200 }, () => running(5));

    // Act
    await harness.subject().run({ seconds: '5' });

    // Assert
    should(harness.errors).deepEqual([
      'the daemon did not finish the profile; is it still running? (fy daemon status)',
    ]);
    should(harness.exitCodes).deepEqual([1]);
    should(harness.reports).deepEqual([]);
    should(harness.written).deepEqual([]);
    should(harness.clock).be.aboveOrEqual(START + 65_000);
  });

  it('should add a trace taken over the same window', async () => {
    // Arrange
    const harness = new Harness();

    // Act
    await harness.subject().run({ traceSyscalls: true, seconds: '30' });

    // Assert
    should(harness.prepares).equal(1);
    should(harness.traces).deepEqual([{ pid: 4242, seconds: 30 }]);
    should(harness.reports).deepEqual([renderPerformanceReport({ ...minimalReport(), syscallTrace: trace })]);
  });

  it('should say why there is no trace when the tracer refuses to prepare', async () => {
    // Arrange
    const harness = new Harness();
    harness.prepared = { kind: 'unavailable', reason: 'strace is not installed' };

    // Act
    await harness.subject().run({ traceSyscalls: true, json: true });

    // Assert
    should(harness.traces).deepEqual([]);
    should(harness.reports).deepEqual([
      JSON.stringify({ ...minimalReport(), limitations: ['No system-call trace: strace is not installed.'] }),
    ]);
  });

  it.each([
    ['says nothing', () => Promise.resolve(undefined)],
    ['cannot be asked', () => Promise.reject(new Error('refused'))],
  ])('should say why there is no trace when the daemon %s about its process id', async (_name, pid) => {
    // Arrange
    const harness = new Harness();
    harness.pidAnswer = pid();

    // Act
    await harness.subject().run({ traceSyscalls: true, json: true });

    // Assert
    should(harness.traces).deepEqual([]);
    should(harness.reports).deepEqual([
      JSON.stringify({
        ...minimalReport(),
        limitations: ['No system-call trace: the daemon did not report its process id.'],
      }),
    ]);
  });

  it('should carry the reason an unavailable trace gives', async () => {
    // Arrange
    const harness = new Harness();
    harness.traceOutcome = { kind: 'unavailable', reason: 'sudo was declined' };

    // Act
    await harness.subject().run({ traceSyscalls: true, json: true });

    // Assert
    should(harness.reports).deepEqual([
      JSON.stringify({ ...minimalReport(), limitations: ['No system-call trace: sudo was declined.'] }),
    ]);
  });

  it('should write the document to --out and point at it after the readable report', async () => {
    // Arrange
    const harness = new Harness();

    // Act
    await harness.subject().run({ out: 'report.json' });

    // Assert
    should(harness.written).deepEqual([{ path: 'report.json', text: `${JSON.stringify(minimalReport(), null, 2)}\n` }]);
    should(harness.reports).deepEqual([
      renderPerformanceReport(minimalReport()),
      '\nThe full report is in report.json; it holds no content or secrets, so it is safe to send.',
    ]);
  });

  it('should write --out without the extra line under --json', async () => {
    // Arrange
    const harness = new Harness();

    // Act
    await harness.subject().run({ out: 'report.json', json: true });

    // Assert
    should(harness.written).have.length(1);
    should(harness.reports).deepEqual([JSON.stringify(minimalReport())]);
  });
});

describe('ProtocolProfileGateway', () => {
  type Call = { path: string; init: RequestInit | undefined };

  function fakeClient(answer: unknown): { client: Pick<IFyApiClient, 'request'>; calls: Call[] } {
    const calls: Call[] = [];
    const client = {
      request: async (path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
        calls.push({ path, init });
        return schema.parse(answer);
      },
    } as unknown as Pick<IFyApiClient, 'request'>;
    return { client, calls };
  }

  it('should start a profile with a POST carrying the seconds', async () => {
    // Arrange
    const { client, calls } = fakeClient(finished());
    const subject = new ProtocolProfileGateway(client);

    // Act
    const actual = await subject.start(45);

    // Assert
    should(actual).deepEqual(PerformanceProfileViewSchema.parse(finished()));
    should(calls).have.length(1);
    should(calls[0]?.path).equal(PERFORMANCE_PROFILE_PATH);
    should(calls[0]?.init).deepEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seconds: 45 }),
    });
  });

  it('should read a profile on its encoded path', async () => {
    // Arrange
    const { client, calls } = fakeClient(running(5));
    const subject = new ProtocolProfileGateway(client);

    // Act
    const actual = await subject.view('a/b');

    // Assert
    should(actual.state).equal('running');
    should(calls[0]?.path).equal(`${PERFORMANCE_PROFILE_PATH}/a%2Fb`);
    should(calls[0]?.init).be.undefined();
  });

  it.each([
    [{ ok: true, pid: 4242 }, 4242],
    [{ ok: true }, undefined],
  ])('should read the daemon process id from /healthz (%j)', async (answer, expected) => {
    // Arrange
    const { client, calls } = fakeClient(answer);
    const subject = new ProtocolProfileGateway(client);

    // Act
    const actual = await subject.pid();

    // Assert
    should(actual).equal(expected);
    should(calls[0]?.path).equal('/healthz');
  });
});

describe('ProfileController progress', () => {
  it('should measure against the window it asked for, and complete the step', async () => {
    // Arrange
    const harness = new Harness();
    const progress = new RecordingProgress();
    harness.progress = progress;

    // Act
    await harness.subject().run({ seconds: '45' });

    // Assert
    should(progress.events).deepEqual(['start Measuring the daemon [45s]', 'succeed']);
  });

  it('should fail the step when the daemon never finishes the profile', async () => {
    // Arrange
    const harness = new Harness();
    const progress = new RecordingProgress();
    harness.progress = progress;
    harness.startedView = running(30);
    harness.viewAnswers = [];
    harness.gateway.view = async () => {
      throw new Error('gone');
    };

    // Act
    await harness
      .subject()
      .run({})
      .catch(() => undefined);

    // Assert
    should(progress.events[0]).equal('start Measuring the daemon [30s]');
    should(progress.events.at(-1)).equal('fail');
  });
});

describe('ProfileController and the service definition', () => {
  it('should add how the daemon is run to the report, and leave the report as it is when that cannot be read', async () => {
    // Arrange
    const told = new Harness();
    told.service = async () => ({ manager: 'launchd', processType: 'Interactive' });
    const failing = new Harness();
    failing.service = async () => {
      throw new Error('no plist');
    };

    // Act
    await told.subject().run({ json: true });
    await failing.subject().run({ json: true });

    // Assert
    const [withService] = told.reports.map(text => JSON.parse(text) as PerformanceReport);
    const [without] = failing.reports.map(text => JSON.parse(text) as PerformanceReport);
    should(withService?.service).deepEqual({ manager: 'launchd', processType: 'Interactive' });
    should(without).not.have.property('service');
  });
});
