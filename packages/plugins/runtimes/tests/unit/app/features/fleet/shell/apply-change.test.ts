import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  applyAccountChange,
  applyStagedChange,
  changeRefusalSentence,
  fleetApplyAuthority,
  readChangeAuthority,
  settleOutcome,
  stageAccountChange,
} from '../../../../../../app/features/fleet/shell/apply-change.ts';
import { AccountChangeViewSchema } from '../../../../../../contract/index.ts';
import {
  APPLIED,
  BACKUP_PATH,
  CHANGE_ID,
  COMMITTED,
  type Call,
  LANDED_FILE,
  machineWith,
  machine,
  ROLLBACK_INCOMPLETE,
  ROLLED_BACK,
  scripted,
  stagedFrom,
  UNRESTORED_PATH,
} from '../account-support.ts';

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

describe('R3-M1: an apply that did not finish is not applied', () => {
  const answer = (outcome: unknown) => scripted({ ...ROUTES, [APPLY]: outcome });

  it('R3-M1: a rolled-back apply is its own result, with the landed files, in plain words, outcome first', async () => {
    const result = await applyAccountChange(answer(ROLLED_BACK), CHANGE);
    expect(result).toMatchObject({ kind: 'rolled-back', landed: [LANDED_FILE], unrestored: [] });
    if (result.kind !== 'rolled-back') throw new Error('expected rolled-back');
    expect(result.sentence).toBe(
      `This change was not applied: the fleet apply failed and was rolled back. Publishing the fleet failed: fleet/bin is a file, not a directory. This configuration change stayed and goes live at the next apply: ${LANDED_FILE}. Fix the cause and apply again. To undo the change instead, put that file back as it was, or delete it if it did not exist before.`,
    );
    expect(result.sentence).not.toMatch(/remove (it|that file)/u);
  });

  it('BG-028 R2-M1 a rolled-back REMOVAL never says the removed file stayed on disk', async () => {
    // The shape the composed daemon answers for `runtime.remove`: the path is the file the change just removed
    // (its state is absent now), and the runtime is no longer listed.
    const removal = {
      outcome: 'applied',
      apply: { ...ROLLED_BACK.apply, configurationLanded: ['/home/kirin/.ferretry/config/runtimes/claude-work.yaml'] },
    };
    const result = await applyAccountChange(answer(removal), { kind: 'runtime.remove', name: 'claude-work' });
    if (result.kind !== 'rolled-back') throw new Error('expected rolled-back');
    expect(result.sentence).not.toMatch(/on disk/u);
    expect(result.sentence).not.toMatch(/file stayed/u);
    expect(result.sentence).toContain(
      'This configuration change stayed and goes live at the next apply: /home/kirin/.ferretry/config/runtimes/claude-work.yaml.',
    );
  });

  it('R3-M1: a rolled-back apply with no landed file says none was left', async () => {
    const bare = { outcome: 'applied', apply: { outcome: 'rolled-back', failedOperation: 'Publishing', reason: 'x.' } };
    const result = await applyAccountChange(answer(bare), CHANGE);
    if (result.kind !== 'rolled-back') throw new Error('expected rolled-back');
    expect(result.landed).toEqual([]);
    expect(result.sentence).toContain('No configuration file was left on disk.');
    expect(result.sentence).toContain('Publishing failed: x.');
  });

  it('BG-028 a rolled-back apply with no landed file still says what to do', async () => {
    const bare = { outcome: 'applied', apply: { outcome: 'rolled-back', failedOperation: 'Publishing', reason: 'x.' } };
    const result = await applyAccountChange(answer(bare), CHANGE);
    if (result.kind !== 'rolled-back') throw new Error('expected rolled-back');
    expect(result.sentence).toEndWith('No configuration file was left on disk. Fix the cause and apply again.');
  });

  it('BG-028 a rollback-incomplete apply that only moved things aside has no empty "partly changed" list', async () => {
    const displaced = {
      outcome: 'applied',
      apply: {
        outcome: 'rollback-incomplete',
        failedOperation: 'Publishing',
        reason: 'x',
        unrestored: [],
        displaced: [{ path: '/h/a', movedTo: '/h/a.moved' }],
      },
    };
    const result = await applyAccountChange(answer(displaced), CHANGE);
    if (result.kind !== 'rollback-incomplete') throw new Error('expected rollback-incomplete');
    expect(result.sentence).not.toContain('partly changed');
    expect(result.sentence).not.toContain(': .');
    expect(result.sentence).toContain('Moved aside: /h/a (moved to /h/a.moved).');
    expect(result.sentence).toEndWith('Check these paths and files, fix the cause, then apply again.');
  });

  it('R3-M1: several landed files are all named', async () => {
    const two = {
      outcome: 'applied',
      apply: { ...ROLLED_BACK.apply, configurationLanded: [LANDED_FILE, '/home/kirin/.ferretry/config/model.yaml'] },
    };
    const result = await applyAccountChange(answer(two), CHANGE);
    if (result.kind !== 'rolled-back') throw new Error('expected rolled-back');
    expect(result.sentence).toContain(
      `These configuration changes stayed and go live at the next apply: ${LANDED_FILE}, /home/kirin/.ferretry/config/model.yaml.`,
    );
    expect(result.sentence).toContain('put those files back as they were, or delete any that did not exist before');
    expect(result.sentence).not.toContain('remove those files');
  });

  it('R3-M1: a rollback-incomplete apply names the unrestored paths, their backups, what was moved aside, and the landed files', async () => {
    const moved = {
      outcome: 'applied',
      apply: { ...ROLLBACK_INCOMPLETE.apply, displaced: [{ path: '/h/a', movedTo: '/h/a.moved' }] },
    };
    const result = await applyAccountChange(answer(moved), CHANGE);
    expect(result).toMatchObject({
      kind: 'rollback-incomplete',
      landed: [LANDED_FILE],
      unrestored: [UNRESTORED_PATH],
    });
    if (result.kind !== 'rollback-incomplete') throw new Error('expected rollback-incomplete');
    expect(result.sentence).toStartWith(
      'This change was not applied, and the fleet could not be fully put back, so this machine needs a look.',
    );
    expect(result.sentence).toContain(`${UNRESTORED_PATH} (the original is at ${BACKUP_PATH})`);
    expect(result.sentence).toContain('Moved aside: /h/a (moved to /h/a.moved).');
    expect(result.sentence).toContain(LANDED_FILE);
    expect(result.sentence).toContain('This path was left partly changed:');
    expect(result.sentence).toContain('Check these paths and files, fix the cause, then apply again.');
  });

  it('R3-M1: a login removal whose moved runtimes rolled back is not applied either', async () => {
    const login = { outcome: 'login-changed', result: 'applied', moved: ROLLED_BACK.apply };
    expect(await applyAccountChange(answer(login), CHANGE)).toMatchObject({ kind: 'rolled-back' });
  });

  it('R3-M1: a finished apply, a history failure and a change with no apply are still applied', async () => {
    expect(await applyAccountChange(answer(COMMITTED), CHANGE)).toMatchObject({ kind: 'applied' });
    const history = {
      outcome: 'applied',
      apply: {
        outcome: 'committed-with-history-failure',
        failedHarness: 'codex',
        reason: 'x',
        committed: {
          ...COMMITTED.apply.result,
          manifest: { version: 1, generatedAt: '2026-10-13T08:00:00.000Z', accounts: [] },
        },
      },
    };
    expect(await applyAccountChange(answer(history), CHANGE)).toMatchObject({ kind: 'applied' });
    expect(await applyAccountChange(answer(APPLIED), CHANGE)).toMatchObject({ kind: 'applied' });
  });

  it('R3-M1: an outcome this app does not know is a refusal, never a save', async () => {
    const unknown = { outcome: 'applied', apply: { outcome: 'half-done', failedOperation: 'x', reason: 'y' } };
    const result = await applyAccountChange(answer(unknown), CHANGE);
    expect(result.kind).toBe('refused');
  });

  it('R3-M1: settleOutcome refuses an apply outcome that got past the parser', () => {
    const staged = stagedFrom({ body: { change: CHANGE } });
    const strange = { outcome: 'applied', apply: { outcome: 'half-done' } } as never;
    const result = settleOutcome(AccountChangeViewSchema.parse(staged), strange);
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' ? result.sentence : '').toContain('doesn’t understand');
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
