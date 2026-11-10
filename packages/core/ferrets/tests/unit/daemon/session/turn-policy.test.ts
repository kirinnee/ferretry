import { describe, expect, test } from 'bun:test';
import type { HarnessDialog } from '../../../../daemon/lib/protocol/session-dialog.ts';
import { eventOfRecord } from '../../../../daemon/adapters/session/live/harness-transcript.ts';
import {
  limitPatch,
  observeTurn,
  parseContinueAt,
  transcriptTurnPhase,
  type TurnEvidence,
  usageLimitOf,
} from '../../../../daemon/lib/session/peers/turn.ts';

type Pane = NonNullable<TurnEvidence['pane']>;

const evidence = (overrides: {
  readonly transcript?: TurnEvidence['transcript'];
  readonly pane?: Partial<Pane>;
}): TurnEvidence => ({
  state: { status: 'running', turn: 1 } as TurnEvidence['state'],
  transcript: overrides.transcript ?? 'unknown',
  pane: { working: false, atPrompt: false, permission: false, ...overrides.pane },
});

const dialog = (overrides: Partial<HarnessDialog> = {}): HarnessDialog =>
  ({
    id: '0123456789abcdef',
    harness: 'claude',
    selected: 1,
    kind: 'usage-limit',
    title: 'What do you want to do?',
    body: "You've hit your org's usage limit\nmore words",
    options: [{ number: 1, label: 'Wait here, then continue automatically at Nov 1, 12am', grantsTrust: false }],
    ...overrides,
  }) as HarnessDialog;

describe('what the pane and the transcript say about whose turn it is', () => {
  test('a harness dialog parks the session on a person and carries the prompt words when there are some', () => {
    const shown = dialog({ kind: 'hooks' as never });
    expect(observeTurn(evidence({ pane: { dialog: shown } }))).toEqual({
      state: 'needs-input',
      confirmed: true,
      dialog: shown,
    });
    expect(observeTurn(evidence({ pane: { dialog: shown, prompt: 'Trust this folder?' } }))).toEqual({
      state: 'needs-input',
      confirmed: true,
      dialog: shown,
      prompt: 'Trust this folder?',
    });
  });

  test('a spinner-shaped line alone is overruled by a transcript that says the turn ended, but only weakly', () => {
    expect(observeTurn(evidence({ transcript: 'ended', pane: { working: true, spinnerOnly: true } }))).toEqual({
      state: 'your-turn',
      confirmed: false,
    });
    expect(observeTurn(evidence({ transcript: 'working', pane: { working: true, spinnerOnly: true } }))).toEqual({
      state: 'working',
      confirmed: true,
    });
  });
});

describe('when a harness says it continues by itself', () => {
  const now = new Date(2026, 9, 30, 10, 0).getTime();

  test('reads the nearest instant at or after now, with minutes and pm', () => {
    expect(parseContinueAt('continue automatically at Nov 1, 3:30pm', now)).toBe(
      new Date(2026, 10, 1, 15, 30).getTime(),
    );
    expect(parseContinueAt('continue automatically at Nov 1, 12am', now)).toBe(new Date(2026, 10, 1, 0, 0).getTime());
  });

  test('moves to next year when the day has already passed this year', () => {
    expect(parseContinueAt('continue automatically at Jan 5, 9am', now)).toBe(new Date(2027, 0, 5, 9, 0).getTime());
  });

  test('is nothing for a label with no time, a day that does not exist or an hour out of range', () => {
    expect(parseContinueAt('wait here', now)).toBeUndefined();
    expect(parseContinueAt('continue automatically at Feb 30, 3am', now)).toBeUndefined();
    expect(parseContinueAt('continue automatically at Nov 1, 13am', now)).toBeUndefined();
    expect(parseContinueAt('continue automatically at Xyz 1, 3am', now)).toBeUndefined();
    expect(parseContinueAt('continue automatically at Nov 32, 3am', now)).toBeUndefined();
    expect(parseContinueAt('continue automatically at Nov 1, 3:75am', now)).toBeUndefined();
  });
});

describe('the usage limit a dialog reports', () => {
  const now = new Date(2026, 9, 30, 10, 0).getTime();

  test('is nothing for a dialog that is not the usage-limit one', () => {
    expect(usageLimitOf(undefined, now)).toBeUndefined();
    expect(usageLimitOf(dialog({ kind: 'update' as never }), now)).toBeUndefined();
  });

  test('is the first line of the body, whether it is a spend limit, and when it continues', () => {
    expect(usageLimitOf(dialog(), now)).toEqual({
      notice: "You've hit your org's usage limit",
      spend: false,
      retryAt: new Date(2026, 10, 1, 0, 0).getTime(),
    });
    expect(usageLimitOf(dialog({ body: 'Monthly spend limit reached', options: [] }), now)).toEqual({
      notice: 'Monthly spend limit reached',
      spend: true,
    });
  });
});

describe('the status and quota to record beside a turn change', () => {
  const now = new Date(2026, 9, 30, 10, 0).getTime();

  test('a running session whose quota still carries the notice a send left behind loses it', () => {
    const patch = limitPatch(
      {
        status: 'running',
        quota: { limitNotice: 'old notice', atLimit: true, usageBased: true } as never,
        harnessDialog: undefined,
      },
      undefined,
      now,
    );
    expect(patch).toEqual({ status: 'running', quota: { usageBased: true } });
  });

  test('a running session with a clean quota is left alone', () => {
    expect(
      limitPatch({ status: 'running', quota: undefined, harnessDialog: undefined }, undefined, now),
    ).toBeUndefined();
  });

  test('a session this module limited goes back to running once no limit shows', () => {
    const patch = limitPatch(
      { status: 'rate_limited', quota: { limitNotice: 'n', atLimit: true } as never, harnessDialog: undefined },
      undefined,
      now,
    );
    expect(patch).toEqual({ status: 'running', quota: undefined });
  });

  test('BG-041 a developer note alone reads no phase (so a cut window holding only it must be marked), and the mark makes one idle frame unable to end the turn', () => {
    const note = eventOfRecord('codex', { kind: 'message', role: 'developer' });
    const mark = eventOfRecord('codex', { kind: 'work' });
    const idleFrame = { frame: 'f', working: false, atPrompt: true, permission: false } as never;
    const state = { status: 'running', turn: 3 } as TurnEvidence['state'];

    // The fold skips a developer or system note: alone it says nothing, so one idle frame ended the turn.
    expect(transcriptTurnPhase([note])).toBe('unknown');
    expect(observeTurn({ state, transcript: 'unknown', pane: idleFrame })).toEqual({
      state: 'your-turn',
      confirmed: true,
    });
    // With the mark the harnesses add for a window that holds no deciding record, the turn is at work and the lone
    // idle frame is not confirmed: the transcript and the pane disagree, so it needs its second look.
    expect(transcriptTurnPhase([note, mark])).toBe('working');
    expect(observeTurn({ state, transcript: 'working', pane: idleFrame })).toMatchObject({ confirmed: false });
  });

  test('a limit the dialog shows limits the session and records the notice', () => {
    const patch = limitPatch({ status: 'running', quota: undefined, harnessDialog: undefined }, dialog(), now);
    expect(patch?.status).toBe('rate_limited');
    expect(patch?.quota).toMatchObject({ atLimit: true, limitNotice: "You've hit your org's usage limit" });
  });
});
