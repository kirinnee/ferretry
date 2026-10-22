import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyProbeFailure,
  type PackProbeOutcome,
  type PackProbePort,
  type PackProbeRequest,
  PROBE_PROMPT,
  ProbeCache,
  probeAnswered,
} from '../../../src/lib/pack/probe.ts';

const REQUEST: PackProbeRequest = {
  wrapper: 'claude-auto',
  harness: 'claude',
  model: 'opus',
  cwd: '/work',
  timeoutMs: 5_000,
};

class FakeProbe implements PackProbePort {
  readonly calls: PackProbeRequest[] = [];
  private readonly waiting: Array<(outcome: PackProbeOutcome) => void> = [];

  constructor(private readonly answer?: PackProbeOutcome) {}

  probe(request: PackProbeRequest): Promise<PackProbeOutcome> {
    this.calls.push(request);
    if (this.answer !== undefined) return Promise.resolve(this.answer);
    return new Promise(resolve => this.waiting.push(resolve));
  }

  release(outcome: PackProbeOutcome): void {
    for (const resolve of this.waiting.splice(0)) resolve(outcome);
  }
}

describe('probeAnswered', () => {
  it('should accept an OK on its own line whatever its case and punctuation', () => {
    // Arrange
    const outputs = ['OK', 'ok.', '  Ok!  ', 'thinking\r\nOK\r\n', '**OK**'];

    // Act
    const answers = outputs.map(probeAnswered);

    // Assert
    should(answers).deepEqual([true, true, true, true, true]);
  });

  it('should refuse output that only mentions OK or says nothing', () => {
    // Arrange
    const outputs = ['', 'Not OK', 'OK then', 'okay', 'error: no key'];

    // Act
    const answers = outputs.map(probeAnswered);

    // Assert
    should(answers).deepEqual([false, false, false, false, false]);
  });

  it('should publish the exact words it asks for', () => {
    // Arrange / Act / Assert
    should(PROBE_PROMPT).equal('Reply with exactly: OK');
  });
});

describe('classifyProbeFailure', () => {
  it("should read quota, sign-in and model failures from a CLI's own words, and nothing from anything else", () => {
    // Assert
    should(classifyProbeFailure('Claude AI usage limit reached')).equal('out_of_quota');
    should(classifyProbeFailure('429 Too Many Requests')).equal('out_of_quota');
    should(classifyProbeFailure('Your credit balance is too low')).equal('out_of_quota');
    should(classifyProbeFailure('Not logged in · Please run /login')).equal('not_logged_in');
    should(classifyProbeFailure('401 Unauthorized')).equal('not_logged_in');
    should(classifyProbeFailure('The model gpt-x does not exist or you do not have access')).equal('model_unavailable');
    should(classifyProbeFailure('unknown model: glm-9')).equal('model_unavailable');
    should(classifyProbeFailure('OK')).be.undefined();
    should(classifyProbeFailure('')).be.undefined();
  });
});

describe('ProbeCache', () => {
  it('should answer from the cache inside the ttl and probe again after it', async () => {
    // Arrange
    let now = 1_000;
    const port = new FakeProbe({ ok: true, ms: 12 });
    const cache = new ProbeCache(port, () => now);

    // Act
    const first = await cache.probe(REQUEST, 60_000);
    now += 59_999;
    const second = await cache.probe(REQUEST, 60_000);
    now += 1;
    const third = await cache.probe(REQUEST, 60_000);

    // Assert
    should(first).deepEqual({ outcome: { ok: true, ms: 12 }, cached: false });
    should(second).deepEqual({ outcome: { ok: true, ms: 12 }, cached: true });
    should(third.cached).be.false();
    should(port.calls).have.length(2);
  });

  it('should key an answer by wrapper, model and effort', async () => {
    // Arrange
    const port = new FakeProbe({ ok: true, ms: 1 });
    const cache = new ProbeCache(port, () => 0);

    // Act
    await cache.probe(REQUEST, 60_000);
    const otherModel = await cache.probe({ ...REQUEST, model: 'sonnet' }, 60_000);
    const defaultModel = await cache.probe(
      { wrapper: 'claude-auto', harness: 'claude', cwd: '/work', timeoutMs: 1 },
      60_000,
    );
    const otherWrapper = await cache.probe({ ...REQUEST, wrapper: 'claude-work' }, 60_000);
    const otherEffort = await cache.probe({ ...REQUEST, effort: 'max' }, 60_000);

    // Assert -- the start runs at its effort, so an answer at another effort proves nothing about it.
    should([otherModel.cached, defaultModel.cached, otherWrapper.cached, otherEffort.cached]).deepEqual([
      false,
      false,
      false,
      false,
    ]);
    should(port.calls).have.length(5);
  });

  it('should share a probe that is already running', async () => {
    // Arrange
    const port = new FakeProbe();
    const cache = new ProbeCache(port, () => 0);

    // Act
    const first = cache.probe(REQUEST, 60_000);
    const second = cache.probe(REQUEST, 60_000);
    port.release({ ok: true, ms: 7 });
    const answers = await Promise.all([first, second]);

    // Assert
    should(port.calls).have.length(1);
    should(answers[0]).deepEqual({ outcome: { ok: true, ms: 7 }, cached: false });
    should(answers[1]).deepEqual({ outcome: { ok: true, ms: 7 }, cached: true });
  });

  it('should never keep a failure: the next start asks again', async () => {
    // Arrange
    const port = new FakeProbe({ ok: false, ms: 3, reason: 'timed out' });
    const cache = new ProbeCache(port, () => 0);

    // Act
    const first = await cache.probe(REQUEST, 60_000);
    const second = await cache.probe(REQUEST, 60_000);

    // Assert
    should(first.outcome).deepEqual({ ok: false, ms: 3, reason: 'timed out' });
    should(second.cached).be.false();
    should(port.calls).have.length(2);
  });

  it('should never keep a pass for a ttl of zero', async () => {
    // Arrange
    const port = new FakeProbe({ ok: true, ms: 3 });
    const cache = new ProbeCache(port, () => 0);

    // Act
    await cache.probe(REQUEST, 0);
    const again = await cache.probe(REQUEST, 0);

    // Assert
    should(again.cached).be.false();
    should(port.calls).have.length(2);
  });
});
