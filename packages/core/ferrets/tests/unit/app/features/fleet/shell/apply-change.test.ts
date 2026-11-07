import { describe, expect, it } from 'bun:test';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import { z } from 'zod';
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
      sentence: 'This machine didn’t answer (no route /v1/fleet/proposals). Check it is awake and try again.',
    });
  });
});

describe('changeRefusalSentence', () => {
  it('uses the daemon’s words, and a status when it gave none', () => {
    expect(changeRefusalSentence(new FyHttpError('No.', 409, 'fleet_change_refused'))).toBe('No.');
    expect(changeRefusalSentence(new FyHttpError(' ', 500, undefined))).toBe('This machine refused the change (500).');
    expect(changeRefusalSentence('boom')).toContain('didn’t answer');
  });

  it('says a refused field limit in plain words, and keeps the daemon’s text for Details elsewhere', () => {
    const raw = 'the request body is invalid — idea: Too big: expected string to have <=500 characters';
    expect(changeRefusalSentence(new FyHttpError(raw, 400, 'invalid_request'))).toBe(
      'Your idea can hold at most 500 characters on this machine.',
    );
    const unknownField = 'the request body is invalid — nickname: Invalid input';
    expect(changeRefusalSentence(new FyHttpError(unknownField, 400, 'invalid_request'))).toBe(unknownField);
  });

  /** A named error, as the carrier and the device-key store throw them. */
  const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

  it('says a request that timed out may still have been applied', () => {
    const late = new FyTransportError('fyd did not answer', '/v1/fleet/login', true, new Error('TimeoutError'));
    expect(changeRefusalSentence(late)).toBe(
      'This machine didn’t answer in time, so this browser stopped waiting. It may still have made the change — check before trying again.',
    );
  });

  it('names why a machine could not be reached, and says less when nothing says why', () => {
    const refused = new FyTransportError('could not reach fyd', '/v1/fleet/login', false, new Error('Load failed.'));
    expect(changeRefusalSentence(refused)).toBe(
      'This browser couldn’t reach this machine (Load failed). Check it is awake and online, then try again.',
    );
    expect(changeRefusalSentence(new FyTransportError('x', '/p', false, 'opaque'))).toBe(
      'This browser couldn’t reach this machine. Check it is awake and online, then try again.',
    );
  });

  it('calls an answer this app cannot read a version mismatch, not silence', () => {
    const unreadable = z.object({ state: z.literal('starting') }).safeParse({ state: 'later' });
    if (unreadable.success) throw new Error('the probe value parsed');
    expect(changeRefusalSentence(unreadable.error)).toContain('different versions');
  });

  it('passes a carrier refusal that is already worded for a person through unchanged', () => {
    const revoked = named('DeviceNotAcceptedError', 'This machine no longer accepts this browser.');
    expect(changeRefusalSentence(revoked)).toBe('This machine no longer accepts this browser.');
    expect(changeRefusalSentence(named('AppOutdatedError', ' '))).toBe(
      'This machine didn’t answer. Check it is awake and try again.',
    );
  });

  it('says a relay connection that broke mid-request may have carried the change', () => {
    expect(changeRefusalSentence(named('RelaySessionError', 'the rendezvous closed.'))).toBe(
      'The connection to this machine broke before it answered (the rendezvous closed). It may still have made the change — check before trying again.',
    );
  });
});
