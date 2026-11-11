import { describe, it } from 'bun:test';
import should from 'should';
import {
  currentLaunchEffort,
  currentLaunchFast,
  currentLaunchModel,
  movedModel,
  recordedModelSource,
} from '../../../../src/lib/session/launch/index.ts';
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

  it('should ignore a report older than the last migration, which described the account it left', () => {
    // Arrange
    const config = launchConfig({
      model: 'claude-opus-5',
      migration: { from: 'claude-auto-old', to: 'claude-auto-boot', at: LATER },
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

describe('recordedModelSource', () => {
  it('should record only a requested model as requested', () => {
    // Act / Assert
    should(recordedModelSource('requested')).equal('requested');
    should(recordedModelSource('account-default')).equal('account-default');
    should(recordedModelSource('harness')).equal('account-default');
  });
});

describe('movedModel', () => {
  // The target serves BOTH models, so only the picked-or-not rule decides.
  const servesBoth = (model: string) => model === 'opus[1m]' || model === 'kimi-k3';
  const move = (
    config: ReturnType<typeof launchConfig>,
    state = launchState(),
    crossing = true,
    sourceDefault = 'opus[1m]',
  ) => movedModel({ config, state, sourceDefault, crossing, servable: servesBoth });

  it("should take the target's default for a model that was only the source login's default", () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' });

    // Act / Assert
    should(move(config)).be.undefined();
  });

  it('should keep a model the person picked when the session crosses runtimes', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'requested' });

    // Act / Assert
    should(move(config)).equal('opus[1m]');
  });

  it('should keep a model switched with /model after the decision, even one recorded as the default', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' });
    const state = launchState({ observedModel: 'kimi-k3', observedModelAt: LATER });

    // Act / Assert
    should(move(config, state)).equal('kimi-k3');
  });

  it('should keep the model on a Restart, which stays on the same runtime', () => {
    // Arrange
    const config = launchConfig({ model: 'opus[1m]', launchModelSource: 'account-default' });

    // Act / Assert
    should(move(config, launchState(), false)).equal('opus[1m]');
  });

  it("should read a document with no record by comparing its model with the source login's default", () => {
    // Arrange
    const config = launchConfig({ model: 'kimi-k3' });
    const defaulted = launchConfig({ model: 'opus[1m]' });

    // Act / Assert
    should(move(config)).equal('kimi-k3');
    should(move(defaulted)).be.undefined();
    should(move(defaulted, launchState(), true, 'opus')).be.undefined();
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
