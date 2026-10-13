import { describe, expect, it } from 'bun:test';
import { OPERATOR_UNLOCK_HEADER } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  applyAccountChange,
  applyStagedChange,
  authorizeChange,
  type ChangeAttempt,
  changeNeedsPassword,
  changeRefusalSentence,
  readChangeAuthority,
  stageAccountChange,
} from '../../../../../src/features/fleet/shell/apply-change.ts';
import { daemonId } from '../../../../../src/lib/daemon-connection.ts';
import {
  APPLY_PATH,
  type Call,
  machineAnswer,
  OUTCOME,
  STAGED,
  scriptedClient,
  UNLOCK_TOKEN,
  UNLOCKED,
} from './change-support.ts';

const HERE = daemonId('studio');
const CHANGE = { kind: 'machine.settings', agentPermissions: 'skip' } as const;
const NOW = () => Date.parse('2026-10-13T08:00:00.000Z');
const ROUTES = { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME, '/v1/grants/unlock': UNLOCKED };

const attempt = (overrides: Partial<ChangeAttempt> = {}): ChangeAttempt => ({
  daemonId: HERE,
  authority: { kind: 'open' },
  now: NOW,
  ...overrides,
});

const paths = (calls: readonly Call[]): string[] => calls.map(call => call.path);

describe('readChangeAuthority', () => {
  it('reads what this browser may change, and calls a failed read unreadable', async () => {
    const calls: Call[] = [];
    expect(await readChangeAuthority(scriptedClient({ '/v1/fleet/machine': machineAnswer() }, calls))).toEqual({
      kind: 'open',
    });
    expect(
      await readChangeAuthority(
        scriptedClient({ '/v1/fleet/machine': machineAnswer({ confirmation: 'operator-password' }) }, calls),
        UNLOCK_TOKEN,
      ),
    ).toEqual({ kind: 'confirm' });
    expect(calls[1]?.headers[OPERATOR_UNLOCK_HEADER]).toBe(UNLOCK_TOKEN);
    expect(
      await readChangeAuthority(
        scriptedClient({ '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'locked' }) }),
      ),
    ).toEqual({ kind: 'locked', alsoConfirms: false });
    expect(
      await readChangeAuthority(
        scriptedClient({
          '/v1/fleet/machine': machineAnswer({
            mayApply: false,
            applyRefusal: 'locked',
            confirmation: 'operator-password',
          }),
        }),
      ),
    ).toEqual({ kind: 'locked', alsoConfirms: true });
    expect(
      await readChangeAuthority(
        scriptedClient({ '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'not-granted' }) }),
      ),
    ).toEqual({ kind: 'refused', refusal: 'not-granted' });
    expect(await readChangeAuthority(scriptedClient({}))).toEqual({ kind: 'unreadable' });
  });

  it('says when a password is owed', () => {
    expect(changeNeedsPassword({ kind: 'open' })).toBe(false);
    expect(changeNeedsPassword({ kind: 'confirm' })).toBe(true);
    expect(changeNeedsPassword({ kind: 'locked', alsoConfirms: false })).toBe(true);
    expect(changeNeedsPassword({ kind: 'unreadable' })).toBe(false);
  });
});

describe('applyAccountChange', () => {
  it('stages then applies, asking for nothing when nothing is owed', async () => {
    const calls: Call[] = [];
    const result = await applyAccountChange(scriptedClient(ROUTES, calls), CHANGE, attempt());
    expect(result).toEqual({ kind: 'applied', staged: STAGED, outcome: OUTCOME, held: null });
    expect(paths(calls)).toEqual(['/v1/fleet/proposals', APPLY_PATH]);
    expect(calls[0]?.body).toEqual({ change: CHANGE });
    expect(calls[1]?.body).toEqual({});
  });

  it('sends the password as the confirmation only where it is owed', async () => {
    const calls: Call[] = [];
    const result = await applyAccountChange(
      scriptedClient(ROUTES, calls),
      CHANGE,
      attempt({ authority: { kind: 'confirm' }, operatorPassword: 'correct-horse-battery' }),
    );
    expect(result.kind).toBe('applied');
    expect(paths(calls)).toEqual(['/v1/fleet/proposals', APPLY_PATH]);
    expect(calls[1]?.body).toEqual({ operatorPassword: 'correct-horse-battery' });
  });

  it('a locked browser mints an unlock first and keeps it for the next change', async () => {
    const calls: Call[] = [];
    const result = await applyAccountChange(
      scriptedClient(ROUTES, calls),
      CHANGE,
      attempt({ authority: { kind: 'locked', alsoConfirms: true }, operatorPassword: 'correct-horse-battery' }),
    );
    const held = { daemonId: HERE, token: UNLOCK_TOKEN, expiresAtMs: Date.parse(UNLOCKED.expiresAt) };
    expect(result).toEqual({ kind: 'applied', staged: STAGED, outcome: OUTCOME, held });
    expect(paths(calls)).toEqual(['/v1/grants/unlock', '/v1/fleet/proposals', APPLY_PATH]);
    expect(calls[0]?.body).toEqual({ password: 'correct-horse-battery' });
    expect(calls[1]?.headers[OPERATOR_UNLOCK_HEADER]).toBe(UNLOCK_TOKEN);
    expect(calls[2]?.headers[OPERATOR_UNLOCK_HEADER]).toBe(UNLOCK_TOKEN);
    expect(calls[2]?.body).toEqual({ operatorPassword: 'correct-horse-battery' });
    expect(JSON.stringify(result)).not.toContain('correct-horse-battery');

    // A held unlock is reused: no second mint, and no password owed when only the unlock was.
    const again: Call[] = [];
    const next = await applyAccountChange(
      scriptedClient(ROUTES, again),
      CHANGE,
      attempt({ authority: { kind: 'locked', alsoConfirms: false }, held }),
    );
    expect(next.kind).toBe('applied');
    expect(paths(again)).toEqual(['/v1/fleet/proposals', APPLY_PATH]);
    expect(again[1]?.body).toEqual({});
  });

  it('refuses before sending anything when an owed password is missing', async () => {
    const calls: Call[] = [];
    const sentence = 'Type this machine’s operator password to make this change.';
    expect(
      await applyAccountChange(
        scriptedClient(ROUTES, calls),
        CHANGE,
        attempt({ authority: { kind: 'locked', alsoConfirms: false } }),
      ),
    ).toEqual({ kind: 'refused', sentence, passwordRejected: false, held: null });
    expect(calls).toEqual([]);
    expect(
      await applyAccountChange(scriptedClient(ROUTES, calls), CHANGE, attempt({ authority: { kind: 'confirm' } })),
    ).toEqual({ kind: 'refused', sentence, passwordRejected: false, held: null });
    // Staging needed no password, so it went out; the apply did not.
    expect(paths(calls)).toEqual(['/v1/fleet/proposals']);
  });

  it('a refused change is one sentence in the daemon’s own words, with its code', async () => {
    const off = new FyHttpError(
      'This change conflicts with the setup on this machine.',
      409,
      'fleet_change_conflict',
    );
    expect(await applyAccountChange(scriptedClient({ '/v1/fleet/proposals': off }), CHANGE, attempt())).toEqual({
      kind: 'refused',
      sentence: 'This change conflicts with the setup on this machine.',
      code: 'fleet_change_conflict',
      passwordRejected: false,
      held: null,
    });
  });

  it('a wrong password says so and stops at the unlock', async () => {
    const calls: Call[] = [];
    const wrong = new FyHttpError(
      'That is not this machine’s operator password. 4 attempts remaining.',
      403,
      'grant_wrong_password',
    );
    const result = await applyAccountChange(
      scriptedClient({ ...ROUTES, '/v1/grants/unlock': wrong }, calls),
      CHANGE,
      attempt({ authority: { kind: 'locked', alsoConfirms: false }, operatorPassword: 'not-the-password' }),
    );
    expect(result).toMatchObject({ kind: 'refused', code: 'grant_wrong_password', passwordRejected: true });
    expect(result.kind === 'refused' ? result.sentence : '').toContain('4 attempts remaining');
    expect(paths(calls)).toEqual(['/v1/grants/unlock']);
  });

  it('a failed apply keeps the unlock it minted', async () => {
    const stale = new FyHttpError('The setup changed since this was staged.', 409, 'fleet_change_stale');
    const result = await applyAccountChange(
      scriptedClient({ ...ROUTES, [APPLY_PATH]: stale }),
      CHANGE,
      attempt({ authority: { kind: 'locked', alsoConfirms: false }, operatorPassword: 'correct-horse-battery' }),
    );
    expect(result).toMatchObject({
      kind: 'refused',
      code: 'fleet_change_stale',
      sentence: 'The setup changed since this was staged.',
      held: { token: UNLOCK_TOKEN },
    });
  });
});

describe('a typed password the daemon could never accept', () => {
  it('is refused here with the rule, before anything is sent', async () => {
    const calls: Call[] = [];
    const result = await applyAccountChange(
      scriptedClient(ROUTES, calls),
      CHANGE,
      attempt({ authority: { kind: 'confirm' }, operatorPassword: 'short' }),
    );
    expect(result).toMatchObject({ kind: 'refused', passwordRejected: true });
    expect(result.kind === 'refused' ? result.sentence : '').toMatch(
      /^An operator password must be at least \d+ characters\.$/u,
    );
    expect(
      await stageAccountChange(scriptedClient(ROUTES), CHANGE, attempt({ operatorPassword: 'short' })),
    ).toMatchObject({
      kind: 'refused',
      passwordRejected: true,
    });
    expect(calls).toEqual([]);
  });
});

describe('stage then apply, separately', () => {
  it('stages for a confirm card, then applies exactly that change', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(ROUTES, calls);
    const stage = await stageAccountChange(client, CHANGE, attempt());
    expect(stage).toEqual({ kind: 'staged', staged: STAGED, held: null });
    expect(await applyStagedChange(client, STAGED, attempt())).toMatchObject({ kind: 'applied', outcome: OUTCOME });
    expect(paths(calls)).toEqual(['/v1/fleet/proposals', APPLY_PATH]);
  });

  it('a locked stage with no password and no unlock asks for it first', async () => {
    expect(
      await stageAccountChange(
        scriptedClient(ROUTES),
        CHANGE,
        attempt({ authority: { kind: 'locked', alsoConfirms: true } }),
      ),
    ).toMatchObject({ kind: 'refused', passwordRejected: false });
  });

  it('an unreachable machine is a sentence too', async () => {
    expect(await stageAccountChange(scriptedClient({}), CHANGE, attempt())).toMatchObject({
      kind: 'refused',
      sentence: 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.',
    });
  });
});

describe('authorizeChange', () => {
  it('hands back nothing extra when nothing is owed, the confirmation when it is, and mints for a locked browser', async () => {
    expect(await authorizeChange(scriptedClient(ROUTES), attempt())).toEqual({ kind: 'authorized', held: null });
    expect(
      await authorizeChange(
        scriptedClient(ROUTES),
        attempt({ authority: { kind: 'confirm' }, operatorPassword: 'correct-horse-battery' }),
      ),
    ).toEqual({ kind: 'authorized', operatorPassword: 'correct-horse-battery', held: null });
    const calls: Call[] = [];
    const locked = await authorizeChange(
      scriptedClient(ROUTES, calls),
      attempt({ authority: { kind: 'locked', alsoConfirms: false }, operatorPassword: 'correct-horse-battery' }),
    );
    expect(locked).toMatchObject({ kind: 'authorized', unlock: UNLOCK_TOKEN, held: { token: UNLOCK_TOKEN } });
    expect(locked).not.toHaveProperty('operatorPassword');
    expect(paths(calls)).toEqual(['/v1/grants/unlock']);
  });

  it('refuses a missing or malformed password, and a wrong one in the unlock’s words', async () => {
    expect(await authorizeChange(scriptedClient(ROUTES), attempt({ authority: { kind: 'confirm' } }))).toMatchObject({
      kind: 'refused',
      passwordRejected: false,
    });
    expect(
      await authorizeChange(scriptedClient(ROUTES), attempt({ authority: { kind: 'confirm' }, operatorPassword: 'x' })),
    ).toMatchObject({ kind: 'refused', passwordRejected: true });
    const wrong = new FyHttpError('Wrong. 3 attempts remaining.', 403, 'grant_wrong_password');
    expect(
      await authorizeChange(
        scriptedClient({ '/v1/grants/unlock': wrong }),
        attempt({ authority: { kind: 'locked', alsoConfirms: true }, operatorPassword: 'not-the-password' }),
      ),
    ).toMatchObject({ kind: 'refused', code: 'grant_wrong_password', passwordRejected: true });
  });
});

describe('changeRefusalSentence', () => {
  it('uses the daemon’s words, a status when it gave none, and the unlock’s own wording', () => {
    expect(changeRefusalSentence(new FyHttpError('No.', 409, 'fleet_change_refused'))).toBe('No.');
    expect(changeRefusalSentence(new FyHttpError(' ', 500, undefined))).toBe('This machine refused the change (500).');
    expect(changeRefusalSentence(new FyHttpError('', 429, 'grant_rate_limited'))).not.toBe('');
    expect(changeRefusalSentence('boom')).toContain('didn’t answer');
  });
});
