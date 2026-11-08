import { describe, it } from 'bun:test';
import should from 'should';
import { PerformanceRecorder } from '../../../../app/lib/performance/recorder.ts';
import { jsonBytes, recordingClient } from '../../../../app/lib/performance/recording-client.ts';
import { DaemonCallError } from '../../../../app/shell.ts';
import { fakeClient } from '../support/client.ts';
import type { UsageClient } from '../../../../app/shell.ts';

const handClock = () => {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

describe('recordingClient', () => {
  it('should record a call by route, with its duration, status and both sizes', async () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const inner = fakeClient({
      'POST /v1/sessions/:id/agenda': () => {
        clock.advance(40);
        return { sessions: [] };
      },
    });
    const subject = recordingClient(inner, recorder);

    // Act
    const answer = await subject.call('POST /v1/sessions/:id/agenda', {
      params: { id: 'fy_s_1' },
      body: { note: 'héllo' },
    });
    clock.advance(59_960);

    // Assert — the caller's answer is intact, and the sample names the route and nothing else.
    should(answer).eql({ sessions: [] });
    should(recorder.report(60_000).routes).eql([
      {
        route: 'POST /v1/sessions/:id/agenda',
        count: 1,
        perMinute: 1,
        p50Ms: 40,
        p95Ms: 40,
        maxMs: 40,
        bytesIn: 15,
        bytesOut: 17,
        failed: 0,
      },
    ]);
  });

  it('should record a refusal as a request that was answered, and pass it on to the caller', async () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const subject = recordingClient(
      {
        call: async () => {
          throw new DaemonCallError(403, 'forbidden', 'operator access is required');
        },
      } as unknown as UsageClient,
      recorder,
    );

    // Act
    const failure = await subject.call('GET /v1/usage').catch((error: unknown) => error);
    clock.advance(60_000);

    // Assert
    should(failure).be.instanceOf(DaemonCallError);
    should(recorder.report(60_000).routes[0]).match({ route: 'GET /v1/usage', count: 1, failed: 0 });
  });

  it('should record a failure that is not a refusal as a transport failure', async () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const subject = recordingClient(
      {
        call: async () => {
          throw new Error('the carrier is down');
        },
      } as unknown as UsageClient,
      recorder,
    );

    // Act
    const failure = await subject.call('GET /v1/usage').catch((error: unknown) => error);
    clock.advance(60_000);

    // Assert
    should(failure).be.instanceOf(Error);
    should(recorder.report(60_000).requests).match({ count: 1, failed: 1 });
  });
});

describe('jsonBytes', () => {
  it('should weigh every JSON value this app sends, and nothing for what has no body', () => {
    // Arrange
    const values: unknown[] = [undefined, null, 'a€😀', { q: 'é' }, [1, 2], 12];

    // Act
    const actual = values.map(jsonBytes);

    // Assert — `"a€😀"` is 2 + 1 + 3 + 4; `{"q":"é"}` is 10 bytes with é as two; `[1,2]` 5; `12` 2.
    should(actual).eql([0, 0, 10, 10, 5, 2]);
  });

  it('should weigh nothing for a value that cannot be serialised or serialises to nothing', () => {
    // Arrange
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const unserialisable: unknown[] = [circular, 10n, () => 1];

    // Act + Assert
    should(unserialisable.map(jsonBytes)).eql([0, 0, 0]);
  });
});
