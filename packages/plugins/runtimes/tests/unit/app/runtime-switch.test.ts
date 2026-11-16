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
import { ferretSummary } from '@ferretry/core-ferrets/contract/testing';

// What `GET /v1/ferrets/:ferretId` serves: Ferrets' summary, built from the contract (not a hand-written view).
const FERRET = ferretSummary({
  id: 's-1',
  harness: 'codex',
  model: 'gpt-5.6',
  effort: 'high',
  fast: true,
  state: 'idle',
});

describe('runtimeControlApi', () => {
  it('sends the command to the ferret through the route key and the session parameter', async () => {
    const calls: Call[] = [];
    const api = runtimeControlApi(scripted({ [RUNTIME_SWITCH_ROUTE]: {} }, calls));
    await api.runtime('s-1', { action: 'model', model: 'gpt-6', effort: 'high' }, 'req-1');
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets/:id/runtime',
        params: { id: 's-1' },
        query: undefined,
        body: { action: 'model', model: 'gpt-6', effort: 'high' },
        // The route refuses a control without the click's key (`missing_request_id`): it rides as the one header.
        headers: { 'x-fy-request-id': 'req-1' },
      },
    ]);
  });

  it('forwards the id each click supplies, whichever control it is', async () => {
    const calls: Call[] = [];
    const api = runtimeControlApi(scripted({ [RUNTIME_SWITCH_ROUTE]: {} }, calls));
    await api.runtime('s-1', { action: 'effort', effort: 'low' }, 'req-effort');
    await api.runtime('s-1', { action: 'fast', fast: false }, 'req-fast');
    expect(calls.map(call => call.headers)).toEqual([
      { 'x-fy-request-id': 'req-effort' },
      { 'x-fy-request-id': 'req-fast' },
    ]);
  });

  it('lets a refusal through for the picker to say', async () => {
    const api = runtimeControlApi(scripted({ [RUNTIME_SWITCH_ROUTE]: new Error('pane is busy') }));
    await expect(api.runtime('s-1', { action: 'fast', fast: true }, 'req-2')).rejects.toThrow('pane is busy');
  });
});

describe('readRuntimeSessionView', () => {
  it('reads the summary the route serves and keeps what the pickers read of it', async () => {
    const view = await readRuntimeSessionView(scripted({ [FERRET_ROUTE]: FERRET }), 's-1');
    expect(view.config).toEqual({
      id: 's-1',
      harness: 'codex',
      model: 'gpt-5.6',
      launchReasoningEffort: 'high',
      launchFast: true,
    });
    expect(view.state).toEqual({ status: 'running', turnState: 'your-turn' });
    expect(launchedModel(view.config)).toBe('gpt-5.6');
  });

  it('says a live ferret is running with the turn the daemon decided, and a stopped one is stopped', () => {
    expect(parseRuntimeSessionView(ferretSummary({ id: 's-1', state: 'working' })).state).toEqual({
      status: 'running',
      turnState: 'working',
    });
    expect(parseRuntimeSessionView(ferretSummary({ id: 's-1', state: 'starting' })).state).toEqual({
      status: 'starting',
    });
    expect(parseRuntimeSessionView(ferretSummary({ id: 's-1', state: 'stopped' })).state).toEqual({
      status: 'stopped',
    });
  });

  it("refuses a document that is not a ferret summary, including today's { config, state } view no route serves", () => {
    expect(() => parseRuntimeSessionView(null)).toThrow('cannot read as a ferret');
    expect(() =>
      parseRuntimeSessionView({ config: { id: 's', harness: 'codex' }, state: { status: 'running' } }),
    ).toThrow('cannot read as a ferret');
    expect(() => parseRuntimeSessionView({ ...ferretSummary({ id: 's-1' }), harness: 'claude' })).toThrow(
      'cannot read as a ferret',
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
