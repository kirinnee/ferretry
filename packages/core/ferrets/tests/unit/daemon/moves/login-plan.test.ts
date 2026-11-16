import { describe, expect, test } from 'bun:test';
import type { RuntimeModelCatalog } from '../../../../contract/view/runtime-control.ts';
import { type LoginPlanRequest, planLoginMove } from '../../../../daemon/lib/moves/login-plan.ts';
import type { SessionConfig, SessionState } from '../../../../daemon/lib/protocol/session.ts';

const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';

const choice = (value: string, context?: number, options: { default?: boolean; efforts?: string[] } = {}) => ({
  value,
  label: value,
  ...(context === undefined ? {} : { context }),
  ...(options.default === true ? { isDefault: true as const } : {}),
  reasoningEfforts: (options.efforts ?? ['low', 'high']).map(effort => ({ value: effort })),
});
const catalog = (choices: RuntimeModelCatalog['choices'], customIds?: boolean): RuntimeModelCatalog => ({
  harness: 'claude',
  source: 'wrapper-inventory',
  choices,
  ...(customIds === undefined ? {} : { catalog: { id: 'models', label: 'Models', customIds } }),
});

/** The source serves opus on 1M and defaults to sonnet; the target serves both on 200k and defaults to opus. */
const SOURCE = catalog([choice(OPUS, 1_000_000), choice(SONNET, 200_000, { default: true })]);
const TARGET = catalog([choice(OPUS, 200_000, { default: true }), choice(SONNET, 200_000)]);

const config = (fields: Partial<SessionConfig> = {}): SessionConfig =>
  ({
    createdAt: '2026-11-01T00:00:00.000Z',
    ...fields,
  }) as SessionConfig;
const state = (fields: Partial<SessionState> = {}): SessionState => ({ ...fields }) as SessionState;

const plan = (fields: Partial<LoginPlanRequest> = {}) =>
  planLoginMove({
    config: config(),
    state: state(),
    requestedModel: undefined,
    allowContextDowngrade: false,
    source: SOURCE,
    target: TARGET,
    ...fields,
  });

describe('planLoginMove: which model a ferret lands on', () => {
  test('a ferret on the source runtime’s default lands on the TARGET’s default: a default does not follow it', () => {
    expect(plan({ config: config({ model: SONNET, launchModelSource: 'account-default' }) })).toMatchObject({
      kind: 'planned',
      model: OPUS,
      modelSource: 'account-default',
      kept: false,
    });
  });

  test('a ferret that recorded no model lands on the target’s default', () => {
    expect(plan()).toMatchObject({ kind: 'planned', model: OPUS, modelSource: 'account-default', kept: false });
  });

  test('a model a person picked is kept when the target serves it, and stays the person’s pick', () => {
    expect(plan({ config: config({ model: SONNET, launchModelSource: 'requested' }) })).toMatchObject({
      kind: 'planned',
      model: SONNET,
      modelSource: 'requested',
      kept: true,
    });
  });

  test('a kept model keeps the selector the ferret records it with', () => {
    const target = catalog([choice(OPUS, 1_000_000, { default: true })]);
    expect(
      plan({ config: config({ model: `${OPUS}[1m]`, launchModelSource: 'requested' }), target, source: undefined }),
    ).toMatchObject({ kind: 'planned', model: `${OPUS}[1m]`, kept: true });
  });

  test('a picked model the target does not serve falls to the target’s default, as a start would', () => {
    expect(plan({ config: config({ model: 'claude-legacy', launchModelSource: 'requested' }) })).toMatchObject({
      kind: 'planned',
      model: OPUS,
      modelSource: 'account-default',
      kept: false,
    });
  });

  test('a model `/model` switched to, reported after the last decision, is the one that goes', () => {
    expect(
      plan({
        config: config({ model: SONNET, launchModelSource: 'account-default' }),
        state: state({ observedModel: OPUS, observedModelAt: '2026-11-02T00:00:00.000Z' }),
        allowContextDowngrade: true,
      }),
    ).toMatchObject({ kind: 'planned', model: OPUS, modelSource: 'requested', kept: true });
  });

  test('the model the request names wins, and is the person’s pick', () => {
    expect(plan({ requestedModel: SONNET })).toMatchObject({
      kind: 'planned',
      model: SONNET,
      modelSource: 'requested',
      kept: false,
    });
  });

  test('a model the target does not serve is refused with what it does serve', () => {
    const refused = plan({ requestedModel: 'gpt-none' });
    expect(refused.kind).toBe('unservable_model');
    expect(refused).toMatchObject({ reason: expect.stringContaining(`${OPUS}, ${SONNET}`) });
  });

  test('a runtime whose catalogue allows custom ids serves a model it does not list', () => {
    const open = catalog([choice(OPUS, 200_000, { default: true })], true);
    expect(plan({ requestedModel: 'anything', target: open })).toMatchObject({ kind: 'planned', model: 'anything' });
  });

  test('a runtime that names no models runs on its own default: no model is recorded, and a named one is refused', () => {
    const bare = catalog([]);
    expect(plan({ config: config({ model: SONNET, launchModelSource: 'requested' }), target: bare })).toMatchObject({
      kind: 'planned',
      model: undefined,
      modelSource: 'account-default',
      kept: false,
    });
    expect(plan({ requestedModel: SONNET, target: bare }).kind).toBe('unservable_model');
  });
});

describe('planLoginMove: the window', () => {
  const onOpus = config({ model: OPUS, launchModelSource: 'requested' });

  test('a smaller window is refused with both windows, unless it is accepted', () => {
    expect(plan({ config: onOpus })).toMatchObject({
      kind: 'context_downgrade',
      downgrade: { model: OPUS, targetWindow: 200_000, currentWindow: 1_000_000 },
    });
    expect(plan({ config: onOpus, allowContextDowngrade: true }).kind).toBe('planned');
  });

  test('the window the harness reports about itself is ground truth over what the catalogue says', () => {
    expect(plan({ config: onOpus, state: state({ contextWindow: 150_000 }) }).kind).toBe('planned');
    expect(plan({ config: config({ model: SONNET }), state: state({ contextWindow: 1_000_000 }) }).kind).toBe(
      'context_downgrade',
    );
  });

  test('an equal or larger window is no downgrade', () => {
    const big = catalog([choice(OPUS, 1_000_000, { default: true })]);
    expect(plan({ config: onOpus, target: big }).kind).toBe('planned');
  });

  test('a window either side does not state is not a downgrade: nothing is cut off on a guess', () => {
    const unstated = catalog([choice(OPUS, undefined, { default: true })]);
    expect(plan({ config: onOpus, target: unstated }).kind).toBe('planned');
    expect(plan({ config: onOpus, source: undefined }).kind).toBe('planned');
  });
});

describe('planLoginMove: the effort', () => {
  const picked = (effort: string) =>
    config({ model: SONNET, launchModelSource: 'requested', launchReasoningEffort: effort });

  test('goes with the ferret when the target’s model takes it', () => {
    expect(plan({ config: picked('high') })).toMatchObject({ kind: 'planned', effort: 'high' });
  });

  test('is dropped (the login’s own) when the target’s model lists efforts without it', () => {
    expect(plan({ config: picked('xhigh') })).toMatchObject({ kind: 'planned', effort: undefined });
  });

  test('is dropped when a catalogue that describes the model says it takes none', () => {
    const none = catalog([choice(SONNET, 200_000, { default: true, efforts: [] })], false);
    expect(plan({ config: picked('high'), target: none })).toMatchObject({ kind: 'planned', effort: undefined });
  });

  test('is carried when the catalogue says nothing about efforts (it is not asked to prove a negative)', () => {
    const silent = catalog([choice(SONNET, 200_000, { default: true, efforts: [] })]);
    expect(plan({ config: picked('high'), target: silent })).toMatchObject({ kind: 'planned', effort: 'high' });
  });

  test('none recorded is none carried', () => {
    expect(plan()).toMatchObject({ kind: 'planned', effort: undefined });
  });
});
