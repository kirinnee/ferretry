import { describe, it } from 'bun:test';
import type { RuntimeControlRequest, SessionView } from '@ferretry/protocol';
import should from 'should';
import type { CodexPickerCleanup } from '../../../../src/lib/session/harness/cleanup.ts';
import { CODEX_PICKER_QUARANTINE_KIND } from '../../../../src/lib/session/harness/quarantine.ts';
import { HarnessQuirkService } from '../../../../src/lib/session/harness/service.ts';
import {
  SessionRuntimeControlService,
  type SessionRuntimeControlPorts,
} from '../../../../src/lib/session/runtime-control/service.ts';
import { SessionRuntimeError } from '../../../../src/lib/session/runtime-control/types.ts';
import { sessionView } from '../../runtime/mounts/support.ts';
import {
  account,
  CLAUDE_VIEW,
  CODEX_VIEW,
  catalogCache,
  FakeAccounts,
  FakePickerTransport,
  FakeRuntimeInjector,
  FakeRuntimePane,
  FakeRuntimeRepository,
  NOW,
  RecordingSerial,
} from './support.ts';

/**
 * The decisions that used to live in `bin/fyd.ts`, where no coverage ledger reaches.
 *
 * Every case here is one of the guarantees that file asserted in prose and nothing proved: the four
 * preconditions and their order, both places a request id is spent, the catalog gate that keeps the
 * manual escape hatch alive when the catalog is what is broken, and the quarantine ordering that
 * decides whether a half-driven modal is still open after a restart.
 */

/** A cleanup that reports whatever the test wants, without a pane. */
const cleanup = (kind: 'recovered' | 'quarantined') => ({
  async dismiss() {
    return kind === 'recovered'
      ? ({ kind: 'settled' } as const)
      : ({ kind: 'unconfirmed', reason: 'the pane would not close' } as const);
  },
});

const harnessService = (recovery: 'recovered' | 'quarantined' = 'quarantined') =>
  new HarnessQuirkService(cleanup(recovery) as unknown as CodexPickerCleanup, 'fy');

/** The concrete fakes stay concrete, so a test can read what they recorded. */
interface Overrides {
  readonly repository?: FakeRuntimeRepository;
  readonly pane?: FakeRuntimePane;
  readonly injector?: FakeRuntimeInjector;
  readonly serial?: RecordingSerial;
  readonly picker?: SessionRuntimeControlPorts['picker'];
  readonly harness?: SessionRuntimeControlPorts['harness'];
  readonly accounts?: SessionRuntimeControlPorts['accounts'];
  readonly catalog?: SessionRuntimeControlPorts['catalog'];
  readonly clock?: SessionRuntimeControlPorts['clock'];
  readonly clientName?: string;
}

function subjectWith(overrides: Overrides = {}) {
  const repository = overrides.repository ?? new FakeRuntimeRepository();
  const pane = overrides.pane ?? new FakeRuntimePane();
  const injector = overrides.injector ?? new FakeRuntimeInjector();
  const serial = overrides.serial ?? new RecordingSerial();
  const ports: SessionRuntimeControlPorts = {
    repository,
    pane,
    injector,
    picker: overrides.picker ?? (() => new FakePickerTransport()),
    harness: overrides.harness ?? harnessService(),
    accounts: overrides.accounts ?? (new FakeAccounts() as SessionRuntimeControlPorts['accounts']),
    catalog: overrides.catalog ?? catalogCache(async () => []),
    serial,
    sleeper: { sleep: async () => undefined },
    clock: overrides.clock ?? { now: () => NOW },
    clientName: overrides.clientName ?? 'fy',
  };
  return { ports, repository, pane, injector, serial, subject: new SessionRuntimeControlService(ports) };
}

/** The refusal a call produced, as a value. */
const refusal = async (work: Promise<unknown>): Promise<SessionRuntimeError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionRuntimeError)) throw new Error(`expected a runtime refusal, got ${String(error)}`);
  return error;
};

const EFFORT: RuntimeControlRequest = { action: 'effort', effort: 'high' };
const COMPACT: RuntimeControlRequest = { action: 'compact' };
const OPEN_PICKER: RuntimeControlRequest = { action: 'model' };

describe('resolving the session a control names', () => {
  it('should tell an unusable reference apart from a session nobody holds', async () => {
    // TWO STATUSES ON THE WIRE, 400 and 404, and collapsing them would report a client's malformed
    // input as somebody's deleted session.
    // Arrange
    const { subject } = subjectWith();

    // Act
    const invalid = await refusal(subject.control('!nope', EFFORT, 'req-1'));
    const missing = await refusal(subject.control('s404', EFFORT, 'req-1'));

    // Assert
    should(invalid).match({ failure: 'invalid', message: /is not a usable session id/u });
    should(missing).match({ failure: 'not_found', message: /no session s404/u });
  });

  it('should make the same distinction when only reading the catalog', async () => {
    // Arrange
    const { subject } = subjectWith();

    // Act / Assert
    should(await refusal(subject.models('!nope'))).match({ failure: 'invalid' });
    should(await refusal(subject.models('s404'))).match({ failure: 'not_found' });
  });

  it('should fail rather than guess when a held session does not satisfy the protocol', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [undefined as unknown as SessionView] });
    const { subject } = subjectWith({ repository });

    // Act / Assert
    should(await refusal(subject.control('s1', EFFORT, 'req-1'))).match({
      failure: 'failed',
      message: /documents do not satisfy the protocol/u,
    });
  });

  it('should fail when the launch record cannot address a pane', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()], launch: undefined });
    const { subject } = subjectWith({ repository });

    // Act / Assert
    should(await refusal(subject.control('s1', EFFORT, 'req-1'))).match({
      failure: 'failed',
      message: /no readable launch record/u,
    });
  });
});

describe('the four preconditions, in order', () => {
  it('should refuse a session in a terminal status before it looks at a pane', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW({ status: 'completed' })] });
    const pane = new FakeRuntimePane();
    const { subject, injector } = subjectWith({ repository, pane });

    // Act
    const failure = await refusal(subject.control('s1', EFFORT, 'req-1'));

    // Assert
    should(failure).match({ failure: 'refused', message: /requires a running session/u });
    should(pane.stopped).be.empty();
    should(injector.delivered).be.empty();
  });

  it('should refuse a session already holding the picker quarantine', async () => {
    // That quarantine exists to stop the daemon typing into a modal it could not identify, and a
    // retry of the control that caused it is the likeliest thing to do so.
    // Arrange
    const repository = new FakeRuntimeRepository({
      views: [CLAUDE_VIEW({ needsHumanKind: CODEX_PICKER_QUARANTINE_KIND, needsHuman: 'run fy resume s1' })],
    });
    const { subject, injector } = subjectWith({ repository, clientName: 'fy' });

    // Act
    const failure = await refusal(subject.control('s1', EFFORT, 'req-1'));

    // Assert: the refusal names the CLI a human types, not this daemon.
    should(failure).match({ failure: 'refused', message: /fy/u });
    should(injector.delivered).be.empty();
  });

  it('should refuse a pane whose harness has gone', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const pane = new FakeRuntimePane({ alive: false, dead: true, promptReady: false });
    const { subject, injector } = subjectWith({ repository, pane });

    // Act / Assert
    should(await refusal(subject.control('s1', EFFORT, 'req-1'))).match({
      failure: 'refused',
      message: /requires a live harness pane/u,
    });
    should(injector.delivered).be.empty();
  });

  it('should refuse a busy pane rather than queueing a control behind a running turn', async () => {
    // A queued control that silently applied three minutes later would apply to whatever turn was
    // running by then.
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const pane = new FakeRuntimePane({ alive: true, dead: false, promptReady: false });
    const { subject, injector } = subjectWith({ repository, pane });

    // Act / Assert
    should(await refusal(subject.control('s1', EFFORT, 'req-1'))).match({
      failure: 'refused',
      message: /waiting at an idle prompt/u,
    });
    should(injector.delivered).be.empty();
  });
});

describe('spending the request id', () => {
  it('should spend BEFORE the keystrokes for compact, so a lost answer never compacts twice', async () => {
    // The bookkeeping after `/compact` can fail with the harness having already done the work.
    // Arrange — delivery succeeds, the journal write that follows it does not.
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    repository.journal = async () => {
      throw new Error('the journal is unwritable');
    };
    const { subject, injector } = subjectWith({ repository });

    // Act — the first attempt reaches the harness and then dies on its own bookkeeping.
    await subject.control('s1', COMPACT, 'req-1').catch(() => undefined);
    const retry = await refusal(subject.control('s1', COMPACT, 'req-1'));

    // Assert: told to go and look, never handed a second `/compact`.
    should(injector.delivered).deepEqual([['fy-s1', '/compact']]);
    should(retry).match({ failure: 'unsettled' });
  });

  it('should leave the id UNSPENT when the plan is refused, so the caller may fix and reuse it', async () => {
    // Everything before the first keystroke is decision and refusal; nothing has touched the pane.
    // Arrange — an effort-only switch a picker harness cannot express.
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW(), CODEX_VIEW(), CODEX_VIEW()] });
    const { subject, injector } = subjectWith({ repository });

    // Act
    const refused = await refusal(subject.control('s1', EFFORT, 'req-1'));
    const reused = await refusal(subject.control('s1', EFFORT, 'req-1'));

    // Assert: the same honest refusal both times, never `unsettled`.
    should(refused).match({ failure: 'unsupported' });
    should(reused).match({ failure: 'unsupported' });
    should(injector.delivered).be.empty();
  });

  it('should replay the first answer for a genuine retry without touching the harness again', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const { subject, injector } = subjectWith({ repository });

    // Act
    const first = await subject.control('s1', COMPACT, 'req-1');
    const second = await subject.control('s1', COMPACT, 'req-1');

    // Assert
    should(second).equal(first);
    should(injector.delivered).have.length(1);
  });

  it('should refuse an id reused for a different control', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const { subject } = subjectWith({ repository });

    // Act
    await subject.control('s1', COMPACT, 'req-1');
    const failure = await refusal(subject.control('s1', EFFORT, 'req-1'));

    // Assert
    should(failure).match({ failure: 'conflict' });
  });

  it('should serialise controls per session, so two drives never share one modal', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const serial = new RecordingSerial();
    const { subject } = subjectWith({ repository, serial });

    // Act
    await Promise.all([subject.control('s1', COMPACT, 'a'), subject.control('s1', COMPACT, 'b')]);

    // Assert: the queue was entered twice and never held by two at once.
    should(serial.entered).equal(2);
    should(serial.peak).equal(1);
  });
});

describe('reading the catalog a switch is planned against', () => {
  it('should refuse an empty Claude catalog rather than answer a blank sheet', async () => {
    // `servableModels` empties for an account the manifest declared down, and the browser's
    // native-picker escape hatch is Codex-only — a `200` with no choices explains nothing.
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const accounts = new FakeAccounts([account({ available: true, models: [] })]);
    const { subject } = subjectWith({ repository, accounts: accounts as SessionRuntimeControlPorts['accounts'] });

    // Act / Assert
    should(await refusal(subject.models('s1'))).match({
      failure: 'catalog_unavailable',
      message: /publishes no available model/u,
    });
  });

  it('should say WHY an unavailable account cannot be switched into', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const accounts = new FakeAccounts([
      account({ available: false, unavailableReason: 'quota exhausted', models: [] }),
    ]);
    const { subject } = subjectWith({ repository, accounts: accounts as SessionRuntimeControlPorts['accounts'] });

    // Act / Assert
    should(await refusal(subject.models('s1'))).match({
      failure: 'catalog_unavailable',
      message: /unavailable \(quota exhausted\)/u,
    });
  });

  it('should refuse when no account is published under the session executable', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const accounts = new FakeAccounts([account({ agent: 'somebody-else' })]);
    const { subject } = subjectWith({ repository, accounts: accounts as SessionRuntimeControlPorts['accounts'] });

    // Act / Assert
    should(await refusal(subject.models('s1'))).match({
      failure: 'catalog_unavailable',
      message: /no account is published under claude-auto/u,
    });
  });

  it('should restate an inventory that could not be read at all', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const accounts = new FakeAccounts(new Error('the manifest is unreadable'));
    const { subject } = subjectWith({ repository, accounts: accounts as SessionRuntimeControlPorts['accounts'] });

    // Act / Assert
    should(await refusal(subject.models('s1'))).match({
      failure: 'catalog_unavailable',
      message: /the manifest is unreadable/u,
    });
  });

  it('should answer a Claude catalog from the published account', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const { subject } = subjectWith({ repository });

    // Act
    const catalog = await subject.models('s1');

    // Assert
    should(catalog).match({ harness: 'claude', source: 'wrapper-inventory' });
    should(catalog.choices.map(choice => choice.value)).deepEqual(['opus']);
  });

  it('should answer a Codex catalog from the account probe, in the order its picker renders', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW()] });
    const catalog = catalogCache(async () => [
      { value: 'gpt-5.6-codex', label: 'Codex', reasoningEfforts: [{ value: 'high' }] },
      { value: 'gpt-5.6-mini', label: 'Mini', reasoningEfforts: [{ value: 'low' }] },
    ]);
    const { subject } = subjectWith({ repository, catalog });

    // Act
    const answer = await subject.models('s1');

    // Assert
    should(answer).match({ harness: 'codex', source: 'codex-app-server' });
    should(answer.choices.map(choice => choice.value)).deepEqual(['gpt-5.6-codex', 'gpt-5.6-mini']);
  });

  it('should restate a Codex probe that failed', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW()] });
    const catalog = catalogCache(async () => {
      throw new Error('the probe timed out after 10s');
    });
    const { subject } = subjectWith({ repository, catalog });

    // Act / Assert
    should(await refusal(subject.models('s1'))).match({
      failure: 'catalog_unavailable',
      message: /timed out after 10s/u,
    });
  });

  it('should NOT read a catalog for a bare picker open, so the escape hatch survives a broken one', async () => {
    // This is the case the manual escape hatch exists for: probing here would make it fail exactly
    // when the catalog is the thing that is broken.
    // Arrange
    let probes = 0;
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW()] });
    const catalog = catalogCache(async () => {
      probes += 1;
      throw new Error('the probe is broken');
    });
    const { subject, injector } = subjectWith({ repository, catalog });

    // Act
    await subject.control('s1', OPEN_PICKER, 'req-1');

    // Assert
    should(probes).equal(0);
    should(injector.delivered).deepEqual([['fy-s1', '/model']]);
  });

  it('should refuse a TARGETED Codex switch when the catalog cannot be read', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW()] });
    const catalog = catalogCache(async () => {
      throw new Error('the probe is broken');
    });
    const { subject, injector } = subjectWith({ repository, catalog });

    // Act / Assert
    should(
      await refusal(subject.control('s1', { action: 'model', model: 'gpt-5.6-codex', effort: 'high' }, 'req-1')),
    ).match({ failure: 'catalog_unavailable' });
    should(injector.delivered).be.empty();
  });
});

describe('performing the plan', () => {
  it('should inject a native effort command and answer with a RE-READ view', async () => {
    // The daemon must not claim the switch took; the harness's own transcript says so on the next read.
    // Arrange — the second read is a different view, so a projected answer would be visible.
    const after = sessionView('s1', { harness: 'claude' }, { status: 'running', observedModel: 'opus-5' });
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW(), after] });
    const { subject, injector } = subjectWith({ repository });

    // Act
    const view = await subject.control('s1', EFFORT, 'req-1');

    // Assert
    should(injector.delivered).deepEqual([['fy-s1', '/effort high']]);
    should(view.state.observedModel).equal('opus-5');
    should(repository.calls).match([
      { kind: 'journal', event: 'control.runtime_model', data: { harness: 'claude', requestedEffort: 'high' } },
    ]);
  });

  it('should journal a compact as its own command rather than as a model switch', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const { subject } = subjectWith({ repository });

    // Act
    await subject.control('s1', COMPACT, 'req-1');

    // Assert
    should(repository.calls).match([
      { kind: 'journal', event: 'control.session_command', data: { harness: 'claude', command: 'compact' } },
    ]);
  });

  it('should claim nothing about a bare picker open, because the daemon made no choice', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW()] });
    const { subject } = subjectWith({ repository });

    // Act
    await subject.control('s1', OPEN_PICKER, 'req-1');

    // Assert
    should(repository.calls).match([{ kind: 'journal', event: 'control.runtime_model', data: { picker: true } }]);
  });

  it('should refuse when the harness read a native command as a model turn', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const injector = new FakeRuntimeInjector('turn-started');
    const { subject } = subjectWith({ repository, injector });

    // Act / Assert
    should(await refusal(subject.control('s1', EFFORT, 'req-1'))).match({
      failure: 'failed',
      message: /as a model turn instead of a native runtime control/u,
    });
  });

  it('should restate a delivery that threw', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const injector = new FakeRuntimeInjector(new Error('the pane is gone'));
    const { subject } = subjectWith({ repository, injector });

    // Act / Assert
    should(await refusal(subject.control('s1', EFFORT, 'req-1'))).match({
      failure: 'failed',
      message: /the pane is gone/u,
    });
  });

  it('should refuse a model this wrapper may not switch to', async () => {
    // Arrange
    const repository = new FakeRuntimeRepository({ views: [CLAUDE_VIEW()] });
    const { subject } = subjectWith({ repository });

    // Act / Assert
    should(await refusal(subject.control('s1', { action: 'model', model: 'sonnet' }, 'req-1'))).match({
      failure: 'unsupported',
      message: /not available on wrapper claude-auto/u,
    });
  });
});

describe('a picker drive that failed part way', () => {
  const drivingCodex = (harness: HarnessQuirkService, picker: () => FakePickerTransport) => {
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW(), CODEX_VIEW()] });
    const catalog = catalogCache(async () => [
      { value: 'gpt-5.6-codex', label: 'Codex', reasoningEfforts: [{ value: 'high' }, { value: 'max' }] },
    ]);
    return subjectWith({ repository, catalog, harness, picker });
  };

  it('should quarantine, journal, then stop — in that order, and durably before the stop', async () => {
    // A decision held only in memory is undone by the next restart, which is exactly when nobody is
    // watching. So a stop that also fails still leaves the input gates closed.
    // Arrange — the picker never opens, and cleanup cannot close it either.
    const { subject, repository, pane } = drivingCodex(harnessService('quarantined'), () => new FakePickerTransport());

    // Act
    const failure = await refusal(
      subject.control('s1', { action: 'model', model: 'gpt-5.6-codex', effort: 'max' }, 'req-1'),
    );

    // Assert
    should(repository.calls.map(call => call.kind)).deepEqual(['quarantine', 'journal']);
    should(repository.calls[0]).match({
      kind: 'quarantine',
      patch: { status: 'failed', health: 'crashed', promptReady: false, finishedAt: NOW },
    });
    should(repository.calls[1]).match({ kind: 'journal', event: 'session.codex_picker_quarantined' });
    should(pane.stopped).deepEqual(['fy-s1']);
    should(failure).match({ failure: 'failed' });
  });

  it('should still report when the stop ALSO failed', async () => {
    // Arrange
    const pane = new FakeRuntimePane({ alive: true, dead: false, promptReady: true }, new Error('tmux would not stop'));
    const repository = new FakeRuntimeRepository({ views: [CODEX_VIEW(), CODEX_VIEW()] });
    const catalog = catalogCache(async () => [
      { value: 'gpt-5.6-codex', label: 'Codex', reasoningEfforts: [{ value: 'high' }, { value: 'max' }] },
    ]);
    const { subject } = subjectWith({
      repository,
      catalog,
      pane,
      harness: harnessService('quarantined'),
      picker: () => new FakePickerTransport(),
    });

    // Act
    const failure = await refusal(
      subject.control('s1', { action: 'model', model: 'gpt-5.6-codex', effort: 'max' }, 'req-1'),
    );

    // Assert: the quarantine still landed, and the report survives the second failure.
    should(repository.calls.map(call => call.kind)).deepEqual(['quarantine', 'journal']);
    should(failure).match({ failure: 'failed' });
  });

  it('should NOT quarantine a drive the cleanup recovered from', async () => {
    // A picker that closed cleanly leaves a usable session; failing it is honest, quarantining is not.
    // Arrange
    const { subject, repository, pane } = drivingCodex(harnessService('recovered'), () => new FakePickerTransport());

    // Act
    const failure = await refusal(
      subject.control('s1', { action: 'model', model: 'gpt-5.6-codex', effort: 'max' }, 'req-1'),
    );

    // Assert
    should(repository.calls).be.empty();
    should(pane.stopped).be.empty();
    should(failure).match({ failure: 'failed' });
  });
});
