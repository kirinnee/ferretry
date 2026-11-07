import { describe, expect, test } from 'bun:test';
import { FERRET_ROUTE, readRuntimeSessionView } from '../../../app/lib/runtime-switch.ts';
import { type Call, scripted } from './support/client.ts';

/**
 * The shell's client matches a route key by its exact string, so the ferret detail read must be written with the
 * parameter name Ferrets declares (`:ferretId`) and send its value under that name. That every route key this half
 * writes is declared by a compiled manifest is proved in the app's `plugin-calls` suite.
 */
describe('the ferret detail read', () => {
  test('uses the parameter name Ferrets declares, and sends the id under that name', async () => {
    expect(FERRET_ROUTE).toBe('GET /v1/ferrets/:ferretId');
    const calls: Call[] = [];
    const client = scripted(
      { [FERRET_ROUTE]: { config: { id: 'f-1', harness: 'codex' }, state: { status: 'running' } } },
      calls,
    );
    await readRuntimeSessionView(client, 'f-1');
    expect(calls).toEqual([
      { route: 'GET /v1/ferrets/:ferretId', params: { ferretId: 'f-1' }, query: undefined, body: undefined },
    ]);
  });
});
