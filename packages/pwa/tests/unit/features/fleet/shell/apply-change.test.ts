import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  applyAccountChange,
  applyStagedChange,
  changeRefusalSentence,
  fleetApplyAuthority,
  readChangeAuthority,
  stageAccountChange,
} from '../../../../../src/features/fleet/shell/apply-change.ts';
import { APPLY_PATH, type Call, machineAnswer, OUTCOME, STAGED, scriptedClient } from './change-support.ts';

const CHANGE = {
  kind: 'machine.settings',
  agentPermissions: 'skip',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
} as const;
const ROUTES = { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME };

const paths = (calls: readonly Call[]): string[] => calls.map(call => call.path);

describe('fleetApplyAuthority', () => {
  it('maps what the machine says to what a panel does', () => {
    expect(fleetApplyAuthority({ mayApply: true, applyRefusal: 'granted' })).toEqual({ kind: 'open' });
    expect(fleetApplyAuthority({ mayApply: false, applyRefusal: 'step-up-required' })).toEqual({ kind: 'step-up' });
    expect(fleetApplyAuthority({ mayApply: false, applyRefusal: 'not-granted' })).toEqual({
      kind: 'refused',
      refusal: 'not-granted',
    });
    expect(fleetApplyAuthority({ mayApply: false, applyRefusal: 'undetermined' })).toEqual({
      kind: 'refused',
      refusal: 'undetermined',
    });
  });
});

describe('readChangeAuthority', () => {
  it('reads what this browser may change, and calls a failed read unreadable', async () => {
    expect(await readChangeAuthority(scriptedClient({ '/v1/fleet/machine': machineAnswer() }))).toEqual({
      kind: 'open',
    });
    expect(
      await readChangeAuthority(
        scriptedClient({
          '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'step-up-required' }),
        }),
      ),
    ).toEqual({ kind: 'step-up' });
    expect(
      await readChangeAuthority(
        scriptedClient({ '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'not-granted' }) }),
      ),
    ).toEqual({ kind: 'refused', refusal: 'not-granted' });
    expect(await readChangeAuthority(scriptedClient({}))).toEqual({ kind: 'unreadable' });
  });
});

describe('applyAccountChange', () => {
  it('stages then applies, with an empty apply body: the passkey step-up is the confirmation', async () => {
    const calls: Call[] = [];
    const result = await applyAccountChange(scriptedClient(ROUTES, calls), CHANGE);
    expect(result).toEqual({ kind: 'applied', staged: STAGED, outcome: OUTCOME });
    expect(paths(calls)).toEqual(['/v1/fleet/proposals', APPLY_PATH]);
    expect(calls[0]?.body).toEqual({ change: CHANGE });
    expect(calls[1]?.body).toEqual({});
    expect(calls.every(call => Object.keys(call.headers).every(name => name === 'content-type'))).toBe(true);
  });

  it('a refused stage stops there, in the daemon’s own words, with its code', async () => {
    const calls: Call[] = [];
    const off = new FyHttpError('This change conflicts with the setup on this machine.', 409, 'fleet_change_conflict');
    expect(await applyAccountChange(scriptedClient({ '/v1/fleet/proposals': off }, calls), CHANGE)).toEqual({
      kind: 'refused',
      sentence: 'This change conflicts with the setup on this machine.',
      code: 'fleet_change_conflict',
    });
    expect(paths(calls)).toEqual(['/v1/fleet/proposals']);
  });

  it('a failed apply is one sentence too', async () => {
    const stale = new FyHttpError('The setup changed since this was staged.', 409, 'fleet_change_stale');
    expect(await applyAccountChange(scriptedClient({ ...ROUTES, [APPLY_PATH]: stale }), CHANGE)).toEqual({
      kind: 'refused',
      sentence: 'The setup changed since this was staged.',
      code: 'fleet_change_stale',
    });
  });
});

describe('stage then apply, separately', () => {
  it('stages for a confirm card, then applies exactly that change', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(ROUTES, calls);
    expect(await stageAccountChange(client, CHANGE)).toEqual({ kind: 'staged', staged: STAGED });
    expect(await applyStagedChange(client, STAGED)).toMatchObject({ kind: 'applied', outcome: OUTCOME });
    expect(paths(calls)).toEqual(['/v1/fleet/proposals', APPLY_PATH]);
  });

  it('an unreachable machine is a sentence too', async () => {
    expect(await stageAccountChange(scriptedClient({}), CHANGE)).toMatchObject({
      kind: 'refused',
      sentence: 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.',
    });
  });
});

describe('changeRefusalSentence', () => {
  it('uses the daemon’s words, and a status when it gave none', () => {
    expect(changeRefusalSentence(new FyHttpError('No.', 409, 'fleet_change_refused'))).toBe('No.');
    expect(changeRefusalSentence(new FyHttpError(' ', 500, undefined))).toBe('This machine refused the change (500).');
    expect(changeRefusalSentence('boom')).toContain('didn’t answer');
  });
});
