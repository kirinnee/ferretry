import { describe, expect, it } from 'bun:test';
import {
  FERRET_ROUTE,
  parseRuntimeSessionView,
  RUNTIME_SWITCH_ROUTE,
  readRuntimeSessionView,
  runtimeControlApi,
} from '../../../app/lib/runtime-switch.ts';
import { launchedModel } from '../../../app/lib/session-view.ts';
import { type Call, scripted } from './support/client.ts';

const FERRET = {
  config: { id: 's-1', harness: 'codex', model: 'gpt-5.6', harnessFlags: ['--model=gpt-6'], launchFast: true },
  state: { status: 'running', turnState: 'your-turn', observedModel: 'gpt-6', unrelated: 1 },
};

describe('runtimeControlApi', () => {
  it('sends the command to the ferret through the route key and the session parameter', async () => {
    const calls: Call[] = [];
    const api = runtimeControlApi(scripted({ [RUNTIME_SWITCH_ROUTE]: {} }, calls));
    await api.runtime('s-1', { action: 'model', model: 'gpt-6', effort: 'high' }, 'req-1');
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets/:sessionId/runtime',
        params: { sessionId: 's-1' },
        query: undefined,
        body: { action: 'model', model: 'gpt-6', effort: 'high' },
      },
    ]);
  });

  it('lets a refusal through for the picker to say', async () => {
    const api = runtimeControlApi(scripted({ [RUNTIME_SWITCH_ROUTE]: new Error('pane is busy') }));
    await expect(api.runtime('s-1', { action: 'fast', fast: true }, 'req-2')).rejects.toThrow('pane is busy');
  });
});

describe('readRuntimeSessionView', () => {
  it('keeps only the fields the pickers read', async () => {
    const view = await readRuntimeSessionView(scripted({ [FERRET_ROUTE]: FERRET }), 's-1');
    expect(view.config.id).toBe('s-1');
    expect(view.config.harness).toBe('codex');
    expect(view.state.turnState).toBe('your-turn');
    expect(view.state.observedModel).toBe('gpt-6');
    expect(view.state).not.toHaveProperty('unrelated');
    expect(launchedModel(view.config)).toBe('gpt-6');
  });

  it('refuses a document that is not a ferret, or whose harness is not one Ferretry runs', () => {
    expect(() => parseRuntimeSessionView(null)).toThrow('invalid ferret');
    expect(() => parseRuntimeSessionView({ config: { id: 's', harness: 'claude' }, state: { status: 'x' } })).toThrow(
      'invalid ferret',
    );
    expect(() => parseRuntimeSessionView({ config: { id: 's', harness: 'codex' }, state: {} })).toThrow(
      'invalid ferret',
    );
  });
});

describe('launchedModel', () => {
  it('reads the last --model flag, else the configured model, else the hint', () => {
    const base = { id: 's', harness: 'claude-code' } as const;
    expect(launchedModel({ ...base, harnessFlags: ['--model', 'a', '-m', 'b'], model: 'c' })).toBe('b');
    expect(launchedModel({ ...base, model: ' c ', modelHint: 'd' })).toBe('c');
    expect(launchedModel({ ...base, modelHint: 'd' })).toBe('d');
    expect(launchedModel(base)).toBeUndefined();
  });
});
