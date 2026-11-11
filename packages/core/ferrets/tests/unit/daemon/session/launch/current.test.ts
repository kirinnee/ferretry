import { describe, it } from 'bun:test';
import should from 'should';
import {
  currentLaunchEffort,
  currentLaunchFast,
  currentLaunchModel,
  movedModel,
  movedModelSource,
  pickedModelSource,
  relaunchModelSource,
} from '../../../../../daemon/lib/session/launch/index.ts';
import { launchConfig, launchState } from './support.ts';

const LATER = '2027-01-15T09:00:00.000Z';
const EARLIER = '2027-01-15T07:00:00.000Z';
const servesAll = () => true;

describe('currentLaunchModel', () => {
  it('should keep a model the owner switched to with /model after the daemon last decided', () => {
    // Arrange
    const config = launchConfig({ model: 'claude-opus-5' });
    const state = launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER });

    // Act / Assert
    should(currentLaunchModel(config, state, servesAll)).equal('claude-sonnet-5');
  });

  it('should keep the decision when the report is the same model without its selector', () => {
    // Arrange: a harness strips `[1m]` from what it reports, and the window lives in that selector.
    const config = launchConfig({ model: 'claude-opus-5[1m]' });
    const state = launchState({ observedModel: 'claude-opus-5', observedModelAt: LATER });

    // Act / Assert
    should(currentLaunchModel(config, state, servesAll)).equal('claude-opus-5[1m]');
  });

  it('should ignore a report older than the last move, which described the account it left', () => {
    // Arrange
    const config = launchConfig({
      model: 'claude-opus-5',
      move: { from: 'claude-auto-old', to: 'claude-auto-boot', at: LATER },
    });
    const state = launchState({ observedModel: 'claude-sonnet-5', observedModelAt: EARLIER });

    // Act / Assert
    should(currentLaunchModel(config, state, servesAll)).equal('claude-opus-5');
  });

  it('should ignore a reported model this account cannot serve, and a report with no time', () => {
    // Arrange
    const config = launchConfig({ model: 'claude-opus-5' });
    const unservable = launchState({ observedModel: 'claude-haiku-5', observedModelAt: LATER });
    const untimed = launchState({ observedModel: 'claude-sonnet-5' });

    // Act / Assert
    should(currentLaunchModel(config, unservable, model => model !== 'claude-haiku-5')).equal('claude-opus-5');
    should(currentLaunchModel(config, untimed, servesAll)).equal('claude-opus-5');
  });

  it('should take the report when nothing was decided, and answer nothing when neither says', () => {
    // Arrange
    const config = launchConfig({ model: undefined });

    // Act / Assert
    should(
      currentLaunchModel(config, launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER }), servesAll),
    ).equal('claude-sonnet-5');
    should(currentLaunchModel(config, launchState(), servesAll)).be.undefined();
  });
});

describe('currentLaunchEffort', () => {
  it('should prefer a reported effort newer than the decision, else the launch effort', () => {
    // Arrange
    const config = launchConfig({ launchReasoningEffort: 'medium' });

    // Act / Assert
    should(currentLaunchEffort(config, launchState({ observedReasoningEffort: 'max', observedModelAt: LATER }))).equal(
      'max',
    );
    should(
      currentLaunchEffort(config, launchState({ observedReasoningEffort: 'max', observedModelAt: EARLIER })),
    ).equal('medium');
    should(currentLaunchEffort(launchConfig(), launchState())).be.undefined();
  });
});

describe('currentLaunchFast', () => {
  it('should prefer a reported state newer than the decision, else the state it was launched in', () => {
    // Arrange
    const config = launchConfig({ launchFast: true });

    // Act / Assert
    should(currentLaunchFast(config, launchState({ observedFast: false, observedModelAt: LATER }))).equal(false);
    should(currentLaunchFast(config, launchState({ observedFast: false, observedModelAt: EARLIER }))).equal(true);
    should(currentLaunchFast(config, launchState({ observedFast: false }))).equal(true);
    should(currentLaunchFast(config, launchState())).equal(true);
  });

  it('should answer nothing when nothing was ever decided, so a relaunch asserts nothing', () => {
    // Act / Assert
    should(currentLaunchFast(launchConfig(), launchState())).be.undefined();
    should(currentLaunchFast(launchConfig(), launchState({ observedFast: true, observedModelAt: LATER }))).equal(true);
  });
});

describe('movedModel (B191)', () => {
  const crossing = { sameRuntime: false } as const;
  const base = { sourceDefault: 'opus[1m]', crossing, servable: servesAll };

  it('should take the target default when the session was on the source default and the move crosses runtimes', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' });

    // Act / Assert
    should(movedModel({ ...base, config, state: launchState({}) })).be.undefined();
  });

  it('should keep a model the person asked for when the move crosses runtimes', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'requested' });

    // Act / Assert
    should(movedModel({ ...base, config, state: launchState({}) })).equal('opus[1m]');
  });

  it('should keep a model the person switched to with /model after the decision', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' });
    const state = launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER });

    // Act / Assert
    should(movedModel({ ...base, config, state })).equal('claude-sonnet-5');
  });

  it('should keep the model on a restart onto the same runtime, whatever its source', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' });

    // Act / Assert
    should(movedModel({ ...base, crossing: { sameRuntime: true }, config, state: launchState({}) })).equal('opus[1m]');
  });

  it('should treat a legacy session with a model other than the source default as a pick', () => {
    // Arrange
    const config = launchConfig({ model: 'claude-sonnet-5' });

    // Act / Assert
    should(movedModel({ ...base, config, state: launchState({}) })).equal('claude-sonnet-5');
  });

  it('should treat a legacy session on the source default as not picked', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]' });

    // Act / Assert
    should(movedModel({ ...base, config, state: launchState({}) })).be.undefined();
  });
});

describe('movedModel for a session that recorded no model (B191/B1, probe P1)', () => {
  const crossing = { sameRuntime: false } as const;

  it('should not read the harness echo of the source default as a pick', () => {
    // Arrange: a plain start (no --model) records no model; the harness then reports the default it ran.
    const config = launchConfig({ model: undefined, launchModelSource: 'account-default' });
    const state = launchState({ observedModel: 'claude-opus-5', observedModelAt: LATER });

    // Act / Assert
    should(movedModel({ config, state, sourceDefault: 'claude-opus-5', crossing, servable: servesAll })).be.undefined();
  });

  it('should still keep a /model switch to another model', () => {
    // Arrange
    const config = launchConfig({ model: undefined, launchModelSource: 'account-default' });
    const state = launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER });

    // Act / Assert
    should(movedModel({ config, state, sourceDefault: 'claude-opus-5', crossing, servable: servesAll })).equal(
      'claude-sonnet-5',
    );
  });
});

describe('movedModelSource (B191/B2, B3, probes P2 and P4)', () => {
  const crossing = { sameRuntime: false } as const;

  it('should record the pick a Restart adopted from /model, so the next crossing keeps it (P2)', () => {
    // Arrange: the session started on the default, the person typed /model sonnet, and Restart adopted it.
    const before = launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' });
    const source = movedModelSource({
      config: before,
      sourceDefault: 'opus[1m]',
      named: false,
      kept: true,
      model: 'claude-sonnet-5',
    });

    // Act: the restart writes model, source and a later move.at; the harness reported before that.
    const after = launchConfig({
      model: 'claude-sonnet-5',
      launchModelSource: source,
      move: { from: 'a', to: 'a', at: '2027-01-15T10:00:00.000Z' },
    });
    const state = launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER });

    // Assert
    should(source).equal('requested');
    should(movedModel({ config: after, state, sourceDefault: 'opus[1m]', crossing, servable: servesAll })).equal(
      'claude-sonnet-5',
    );
  });

  it('should record a --model a Restart named as picked, not the previous account-default', () => {
    // Arrange / Act / Assert
    should(
      movedModelSource({
        config: launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' }),
        sourceDefault: 'opus[1m]',
        named: true,
        kept: false,
        model: 'claude-sonnet-5',
      }),
    ).equal('requested');
  });

  it('should keep a legacy default a default across a Restart (P4)', () => {
    // Arrange: no recorded source; the model is the source default, and the keep path always re-requests it.
    const config = launchConfig({ model: 'opus[1m]' });

    // Act / Assert
    should(movedModelSource({ config, sourceDefault: 'opus[1m]', named: false, kept: true, model: 'opus[1m]' })).equal(
      'account-default',
    );
  });

  it('should keep a plain start that adopted nothing a default across a Restart', () => {
    // Arrange: no model recorded; the keep path re-requested the harness echo of the default.
    const config = launchConfig({ model: undefined, launchModelSource: 'account-default' });

    // Act / Assert
    should(
      movedModelSource({ config, sourceDefault: 'claude-opus-5', named: false, kept: true, model: 'claude-opus-5' }),
    ).equal('account-default');
  });

  it('should carry a recorded pick across a Restart that kept the same model', () => {
    // Arrange / Act / Assert
    should(
      movedModelSource({
        config: launchConfig({ model: 'opus[1m]', launchModelSource: 'requested' }),
        sourceDefault: 'opus[1m]',
        named: false,
        kept: true,
        model: 'opus[1m]',
      }),
    ).equal('requested');
  });

  it('should record the target default as the account default when the keep did not run', () => {
    // Arrange / Act / Assert
    should(
      movedModelSource({
        config: launchConfig({ model: 'opus[1m]', launchModelSource: 'requested' }),
        sourceDefault: 'opus[1m]',
        named: false,
        kept: false,
        model: 'kimi-k3',
      }),
    ).equal('account-default');
  });
});

describe('relaunchModelSource (B191/B4, probe P3) and pickedModelSource (B191/B5)', () => {
  it('should record an adopted /model switch as picked, which the revive overwrites the decision with', () => {
    // Arrange
    const config = launchConfig({ model: 'claude-opus-5', launchModelSource: 'account-default' });

    // Act / Assert
    should(relaunchModelSource({ config, accountDefault: 'claude-opus-5', model: 'claude-sonnet-5' })).equal(
      'requested',
    );
  });

  it('should leave the recorded source alone when the revive keeps the recorded model', () => {
    // Arrange
    const config = launchConfig({ model: 'claude-opus-5', launchModelSource: 'requested' });

    // Act / Assert
    should(relaunchModelSource({ config, accountDefault: 'claude-opus-5', model: 'claude-opus-5' })).be.undefined();
  });

  it('should record a fallback to the account default as the default', () => {
    // Arrange: the recorded model is no longer served, so the planner fell back to the default.
    const config = launchConfig({ model: 'claude-haiku-5', launchModelSource: 'requested' });

    // Act / Assert
    should(relaunchModelSource({ config, accountDefault: 'claude-opus-5', model: 'claude-opus-5' })).equal(
      'account-default',
    );
  });

  it('should keep the pick across the next crossing after a revive adopted it (P3)', () => {
    // Arrange: after the revive, model is the observation and the source says so.
    const config = launchConfig({ model: 'claude-sonnet-5', launchModelSource: 'requested' });
    const state = launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER });

    // Act / Assert
    should(
      movedModel({
        config,
        state,
        sourceDefault: 'claude-opus-5',
        crossing: { sameRuntime: false },
        servable: servesAll,
      }),
    ).equal('claude-sonnet-5');
  });

  it('should call a fork model that is the account default a default, and any other a pick', () => {
    // Arrange / Act / Assert
    should(pickedModelSource('claude-opus-5', 'claude-opus-5')).equal('account-default');
    should(pickedModelSource('claude-sonnet-5', 'claude-opus-5')).equal('requested');
    should(pickedModelSource('claude-sonnet-5', undefined)).equal('requested');
  });
});
