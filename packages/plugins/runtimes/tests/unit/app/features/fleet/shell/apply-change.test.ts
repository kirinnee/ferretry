import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  applyAccountChange,
  applyStagedChange,
  changeRefusalSentence,
  fleetApplyAuthority,
  readChangeAuthority,
  stageAccountChange,
} from '../../../../../../app/features/fleet/shell/apply-change.ts';
import { APPLIED, CHANGE_ID, type Call, machineWith, machine, scripted, stagedFrom } from '../account-support.ts';

const CHANGE = {
  kind: 'machine.settings',
  agentPermissions: 'skip',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
} as const;
const PROPOSE = 'POST /v1/runtimes/proposals';
const APPLY = `POST /v1/runtimes/proposals/${CHANGE_ID}/apply`;
const ROUTES = { [PROPOSE]: stagedFrom, [APPLY]: APPLIED };

/** What the shell's client throws for a refused answer, read structurally. */
const refusal = (message: string, status: number, code: string): Error =>
  Object.assign(new Error(message), { name: 'DaemonCallError', status, code });

const routes = (calls: readonly Call[]): string[] => calls.map(call => call.route);

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
    expect(await readChangeAuthority(scripted({ 'GET /v1/runtimes/machine': machine() }))).toEqual({ kind: 'open' });
    expect(
      await readChangeAuthority(
        scripted({
          'GET /v1/runtimes/machine': machineWith({ mayApply: false, applyRefusal: 'step-up-required' }),
        }),
      ),
    ).toEqual({ kind: 'step-up' });
    expect(
      await readChangeAuthority(
        scripted({ 'GET /v1/runtimes/machine': machineWith({ mayApply: false, applyRefusal: 'not-granted' }) }),
      ),
    ).toEqual({ kind: 'refused', refusal: 'not-granted' });
    expect(await readChangeAuthority(scripted({}))).toEqual({ kind: 'unreadable' });
  });
});

describe('applyAccountChange', () => {
  it('stages then applies, with an empty apply body: the passkey step-up is the confirmation', async () => {
    const calls: Call[] = [];
    const result = await applyAccountChange(scripted(ROUTES, calls), CHANGE);
    expect(result).toMatchObject({ kind: 'applied', outcome: APPLIED });
    expect(routes(calls)).toEqual([PROPOSE, 'POST /v1/runtimes/proposals/:proposalId/apply']);
    expect(calls[0]?.body).toEqual({ change: CHANGE });
    expect(calls[1]?.params).toEqual({ proposalId: CHANGE_ID });
    expect(calls[1]?.body).toEqual({});
  });

  it('a refused stage stops there, in the daemon’s own words, with its code', async () => {
    const calls: Call[] = [];
    const off = refusal('This change conflicts with the setup on this machine.', 409, 'fleet_change_conflict');
    expect(await applyAccountChange(scripted({ [PROPOSE]: off }, calls), CHANGE)).toEqual({
      kind: 'refused',
      sentence: 'This change conflicts with the setup on this machine.',
      code: 'fleet_change_conflict',
    });
    expect(routes(calls)).toEqual([PROPOSE]);
  });

  it('a failed apply is one sentence too', async () => {
    const stale = refusal('The setup changed since this was staged.', 409, 'fleet_change_stale');
    expect(await applyAccountChange(scripted({ ...ROUTES, [APPLY]: stale }), CHANGE)).toEqual({
      kind: 'refused',
      sentence: 'The setup changed since this was staged.',
      code: 'fleet_change_stale',
    });
  });
});

describe('stage then apply, separately', () => {
  it('stages for a confirm card, then applies exactly that change', async () => {
    const calls: Call[] = [];
    const client = scripted(ROUTES, calls);
    const staged = await stageAccountChange(client, CHANGE);
    if (staged.kind !== 'staged') throw new Error('expected a staged change');
    expect(staged.staged.change).toEqual(CHANGE);
    expect(await applyStagedChange(client, staged.staged)).toMatchObject({ kind: 'applied', outcome: APPLIED });
    expect(routes(calls)).toEqual([PROPOSE, 'POST /v1/runtimes/proposals/:proposalId/apply']);
  });

  it('an unreachable machine is a sentence too', async () => {
    expect(await stageAccountChange(scripted({}), CHANGE)).toMatchObject({
      kind: 'refused',
      sentence: 'This machine didn’t answer (no route POST /v1/runtimes/proposals). Check it is awake and try again.',
    });
  });
});

describe('changeRefusalSentence', () => {
  it('uses the daemon’s words, and a status when it gave none', () => {
    expect(changeRefusalSentence(refusal('No.', 409, 'fleet_change_refused'))).toBe('No.');
    expect(changeRefusalSentence(refusal(' ', 500, 'http_500'))).toBe('This machine refused the change (500).');
    expect(changeRefusalSentence('boom')).toContain('didn’t answer');
  });

  /** A named error, as the carrier and the device-key store throw them. */
  const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

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
