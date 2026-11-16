import { describe, expect, test } from 'bun:test';
import type { FerretEndCause } from '@ferretry/core-ferrets/contract';
import { ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { owner } from '@ferretry/kernel/testing';
import { epochMs, err, instantFromEpochMs } from '@ferretry/std';
import { wardenHost } from './host.ts';

const REVIVE_ON = { enabled: true, revive: { enabled: true }, mayActAlone: { resume: true } };

/** One auto helper of an idle lead that stopped for `cause`, and the resumes one sweep spent on it. */
async function resumesAfter(cause: FerretEndCause | undefined, config: unknown = REVIVE_ON) {
  const { host, ferrets } = await wardenHost({ config });
  ferrets.add({ id: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: T0 });
  ferrets.add({
    id: ferretId('f1'),
    mode: 'auto',
    parent: ferretId('lead'),
    state: 'stopped',
    stateAt: T0,
    ...(cause === undefined ? {} : { cause }),
  });
  const ran = await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });
  expect(ran.status).toBe(200);
  return ferrets.resumes.filter(resume => resume.ferret === 'f1');
}

describe('auto-revive in the running daemon half (FerretSummary.cause)', () => {
  test('a ferret whose terminal vanished, or that a signal or a non-zero exit killed, is revived once', async () => {
    for (const cause of [
      { kind: 'terminal_gone' },
      { kind: 'tmux_crashed' },
      { kind: 'signal', signal: 9 },
      { kind: 'agent_crashed', exitCode: 2 },
    ] satisfies FerretEndCause[]) {
      const resumes = await resumesAfter(cause);
      expect(resumes.length).toBe(1);
      expect(resumes[0]?.message).toContain('Ferretry started your terminal again');
    }
  });

  test('a ferret that was stopped, said signal done, exited cleanly or never started is not revived', async () => {
    for (const cause of [
      { kind: 'stopped' },
      { kind: 'completed' },
      { kind: 'clean_exit' },
      { kind: 'start_failed' },
      undefined,
    ] satisfies (FerretEndCause | undefined)[])
      expect(await resumesAfter(cause)).toEqual([]);
  });

  test('a ferret that died is not revived while the owner has not let the Warden resume alone, or revive is off', async () => {
    expect(await resumesAfter({ kind: 'terminal_gone' }, { ...REVIVE_ON, mayActAlone: { resume: false } })).toEqual([]);
    expect(await resumesAfter({ kind: 'terminal_gone' }, { ...REVIVE_ON, revive: { enabled: false } })).toEqual([]);
  });
});

describe('auto-revive when Conversation cannot type the notice (its send refuses on 5.0)', () => {
  const sendRefuses = async () => err({ code: 'unavailable', message: 'This needs the ferret’s terminal' });

  test('a self-crashing ferret whose notice is refused is revived once, then held by crash_repeat', async () => {
    // Arrange
    const { host, ferrets, conversation, clock } = await wardenHost({ config: REVIVE_ON });
    (conversation as { send: unknown }).send = sendRefuses;
    ferrets.add({ id: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: T0 });
    const died = (at: number) =>
      ferrets.add({
        id: ferretId('f1'),
        mode: 'auto',
        parent: ferretId('lead'),
        state: 'stopped',
        stateAt: instantFromEpochMs(at),
        cause: { kind: 'agent_crashed', exitCode: 2 },
      });
    const sweep = async () => {
      const ran = await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });
      expect(ran.status).toBe(200);
    };
    const resumes = () => ferrets.resumes.filter(resume => resume.ferret === 'f1').length;

    // Act — it dies and is revived; the notice is refused; it is relaunched after the cooldown and dies again
    died(epochMs(T0));
    await sweep();
    await clock.advance(32 * 60_000);
    died(epochMs(T0) + 31 * 60_000);
    await sweep();
    await clock.advance(32 * 60_000);
    died(epochMs(T0) + 63 * 60_000);
    await sweep();

    // Assert: the first revive counted although its notice was refused, so the repeats are held
    expect(resumes()).toBe(1);
  });

  test('a death a minute after a refused-notice revive is held by the cooldown', async () => {
    // Arrange
    const { host, ferrets, conversation, clock } = await wardenHost({ config: REVIVE_ON });
    (conversation as { send: unknown }).send = sendRefuses;
    ferrets.add({ id: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: T0 });
    const died = (at: number) =>
      ferrets.add({
        id: ferretId('f1'),
        mode: 'auto',
        parent: ferretId('lead'),
        state: 'stopped',
        stateAt: instantFromEpochMs(at),
        cause: { kind: 'terminal_gone' },
      });

    // Act
    died(epochMs(T0));
    await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });
    await clock.advance(60_000);
    died(epochMs(T0) + 30_000);
    await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });

    // Assert
    expect(ferrets.resumes.filter(resume => resume.ferret === 'f1').length).toBe(1);
  });
});
