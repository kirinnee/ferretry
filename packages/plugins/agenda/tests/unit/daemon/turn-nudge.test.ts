import { describe, expect, test } from 'bun:test';
import type { TranscriptEvent } from '@ferretry/plugin-conversation/contract';
import {
  AGENDA_NUDGE_MARK,
  AGENDA_NUDGE_SETTLE_MS,
  AGENDA_NUDGE_TAIL,
  AgendaTurnNudge,
  NudgeSendFailure,
  agendaNudgeMessage,
  agendaNudgeSendId,
  agendaSends,
  attentionNudge,
  finishedTurn,
  nudgeSpent,
  raisesAgendaItem,
  startedByNudge,
  type NudgeMark,
  type NudgeSend,
  type NudgeSubject,
} from '../../../daemon/lib/turn-nudge.ts';

const said = (role: 'user' | 'assistant', text: string, inputSource?: 'harness'): TranscriptEvent =>
  ({ kind: 'message', role, text, ...(inputSource === undefined ? {} : { inputSource }) }) as TranscriptEvent;
const call = (name: string, input: unknown): TranscriptEvent =>
  ({ kind: 'tool-call', role: 'assistant', call: { id: 'c1', name, input } }) as TranscriptEvent;
const result = (): TranscriptEvent =>
  ({
    kind: 'tool-result',
    role: 'tool',
    result: { callId: 'c1', content: null, isError: false },
  }) as TranscriptEvent;

const send = (sendId: string, acceptedAt: string, agenda: boolean): NudgeSend => ({
  sendId,
  acceptedAt,
  message: 'words',
  agenda,
});

const ASKING = 'Done.\n\n## Waiting on you\n- Approve the deploy\n- Pick a region\n';
const subject: NudgeSubject = { parent: false, mode: 'interactive', agenda: true };

describe('what counts as a raised item', () => {
  test('a shell command running agenda add, edit or answer, or notify', () => {
    for (const command of ['fy agenda add --title x', 'fy agenda edit A1', 'fy agenda answer A1 hi', 'fy notify "x"'])
      expect(raisesAgendaItem(call('Bash', { command }))).toBe(true);
    expect(raisesAgendaItem(call('Bash', { command: 'ls' }))).toBe(false);
  });

  test('an ask_owner tool, the harness question tool, or a page opened with askOwner', () => {
    expect(raisesAgendaItem(call('mcp__ferretry__terminal_ask_owner', {}))).toBe(true);
    expect(raisesAgendaItem(call('AskUserQuestion', {}))).toBe(true);
    expect(raisesAgendaItem(call('mcp__ferretry__browser_open', { askOwner: 'log in' }))).toBe(true);
    expect(raisesAgendaItem(call('mcp__ferretry__browser_open', { url: 'x' }))).toBe(false);
  });

  test('only a tool call counts', () => {
    expect(raisesAgendaItem(said('assistant', 'fy agenda add'))).toBe(false);
    expect(raisesAgendaItem(result())).toBe(false);
  });
});

describe('the last finished turn of a transcript tail', () => {
  test('is the reply after the last tool call, the opener that started it, and how many items it raised', () => {
    const turn = finishedTurn([
      said('user', 'old'),
      said('assistant', 'older reply'),
      said('user', 'deploy it'),
      call('Bash', { command: 'fy agenda add --title x' }),
      result(),
      said('assistant', 'part one'),
      said('assistant', ASKING),
    ]);
    expect(turn).toEqual({ opener: 'deploy it', reply: `part one\n${ASKING}`.trim(), raised: 1 });
  });

  test('the harness’s own records are never openers or replies', () => {
    const turn = finishedTurn([
      said('user', 'real opener'),
      said('user', 'compact summary', 'harness'),
      said('assistant', 'the reply'),
      said('assistant', 'harness chatter', 'harness'),
    ]);
    expect(turn).toMatchObject({ opener: 'real opener', reply: 'the reply' });
  });

  test('a tail with no opener has an empty one', () => {
    expect(finishedTurn([said('assistant', 'hello')])).toEqual({ opener: '', reply: 'hello', raised: 0 });
  });

  test('is nothing when the turn ended on a tool call or said nothing', () => {
    expect(finishedTurn([said('user', 'go'), said('assistant', 'ok'), call('Bash', {})])).toBeUndefined();
    expect(finishedTurn([said('user', 'go'), said('assistant', '  ')])).toBeUndefined();
    expect(finishedTurn([])).toBeUndefined();
  });
});

describe('the nudge words', () => {
  test('an agenda-mode interactive ferret may also use its question tool; an auto one may not', () => {
    const interactive = agendaNudgeMessage(['Approve'], 0, { mode: 'interactive', agenda: true }, 'fy');
    const auto = agendaNudgeMessage(['Approve'], 0, { mode: 'auto', agenda: true }, 'fy');
    expect(interactive.startsWith(AGENDA_NUDGE_MARK)).toBe(true);
    expect(interactive).toContain('- Approve');
    expect(interactive).toContain('or your question tool');
    expect(auto).not.toContain('your question tool');
    expect(auto).toContain('fy agenda add');
  });

  test('without agenda mode the fix is a notice, and what was already raised is said', () => {
    const words = agendaNudgeMessage(['A', 'B'], 1, { mode: 'auto', agenda: false }, 'fy');
    expect(words).toContain('fy notify');
    expect(words).toContain('You raised 1 this turn; raise the rest.');
    expect(words).not.toContain('agenda add');
  });
});

describe('whether a finished turn gets a nudge', () => {
  const turn = (over: Partial<{ opener: string; reply: string; raised: number }> = {}) => ({
    opener: 'go',
    reply: ASKING,
    raised: 0,
    ...over,
  });

  test('a reply that asks the owner for more than the turn raised does', () => {
    const nudge = attentionNudge(turn({ raised: 1 }), subject, 'fy');
    expect(nudge?.asks).toEqual(['Approve the deploy', 'Pick a region']);
    expect(nudge?.message).toContain('You raised 1 this turn');
  });

  test('a turn that raised as many as it asked, or a reply that asks nothing, does not', () => {
    expect(attentionNudge(turn({ raised: 2 }), subject, 'fy')).toBeUndefined();
    expect(attentionNudge(turn({ reply: 'All done, nothing needed.' }), subject, 'fy')).toBeUndefined();
  });

  test('a helper, and a turn the nudge itself started, do not', () => {
    expect(attentionNudge(turn(), { ...subject, parent: true }, 'fy')).toBeUndefined();
    expect(attentionNudge(turn({ opener: `  ${AGENDA_NUDGE_MARK} Your last reply…` }), subject, 'fy')).toBeUndefined();
  });

  test('a turn whose opener says the words of Agenda’s newest send is not checked, bare or pasted', () => {
    const said = 'Your last reply asked the owner to:\n- Approve';
    expect(attentionNudge(turn({ opener: said }), subject, 'fy', said)).toBeUndefined();
    expect(
      attentionNudge(turn({ opener: `<pasted_content id=x>\n${said}\n</pasted_content>` }), subject, 'fy', said),
    ).toBeUndefined();
    expect(attentionNudge(turn({ opener: 'something else' }), subject, 'fy', said)).toBeDefined();
  });

  test('the send id is the ferret’s, the reply’s own digest and how many Agenda sends came before', () => {
    const first = agendaNudgeSendId('f1', 'a reply', 0);
    expect(first).toMatch(/^attention-nudge-f1-[0-9a-f]{16}-0$/u);
    expect(agendaNudgeSendId('f1', 'a reply', 0)).toBe(first);
    expect(agendaNudgeSendId('f1', 'another reply', 0)).not.toBe(first);
    expect(agendaNudgeSendId('f1', 'a reply', 1)).not.toBe(first);
  });
});

describe('the one-nudge cap and the evidence a turn was a nudge’s', () => {
  const send = (over: Partial<NudgeSend> & { sendId: string; acceptedAt: string }): NudgeSend => ({
    message: 'words',
    agenda: false,
    ...over,
  });
  const mark: NudgeMark = { sendId: 'attention-nudge-f1-x-0', at: '2026-11-15T10:00:00.000Z' };

  test('a ferret never nudged is not capped', () => {
    expect(nudgeSpent(undefined, [])).toBe(false);
  });

  test('a nudged ferret stays capped until a send that is not Agenda’s reaches it afterwards', () => {
    const own = send({ sendId: mark.sendId, acceptedAt: '2026-11-15T10:00:00.000Z', agenda: true });
    expect(nudgeSpent(mark, [own])).toBe(true);
    expect(nudgeSpent(mark, [own, send({ sendId: 'old', acceptedAt: '2026-11-15T09:00:00.000Z' })])).toBe(true);
    expect(nudgeSpent(mark, [own, send({ sendId: 'owner', acceptedAt: '2026-11-15T10:00:05.000Z' })])).toBe(false);
  });

  test('the newest Agenda send and how many there are', () => {
    expect(agendaSends([])).toEqual({ newest: undefined, count: 0 });
    expect(
      agendaSends([
        send({ sendId: 'b', acceptedAt: '2026-11-15T10:00:09.000Z', agenda: true, message: 'second' }),
        send({ sendId: 'o', acceptedAt: '2026-11-15T10:00:10.000Z', message: 'owner' }),
        send({ sendId: 'a', acceptedAt: '2026-11-15T10:00:01.000Z', agenda: true, message: 'first' }),
      ]),
    ).toEqual({ newest: 'second', count: 2 });
  });

  test('an opener is a nudge’s when it holds the newest Agenda send’s words, however the whitespace falls', () => {
    expect(startedByNudge('a\n  b', 'a b')).toBe(true);
    expect(startedByNudge('<pasted_content>a b</pasted_content>', 'a   b')).toBe(true);
    expect(startedByNudge('a b', undefined)).toBe(false);
    expect(startedByNudge('a b', '')).toBe(false);
    expect(startedByNudge('', 'a b')).toBe(false);
  });
});

describe('the check at a turn end', () => {
  const OWNER_AT = '2026-11-15T10:05:00.000Z';
  const rig = (
    over: Partial<{
      enabled: boolean;
      subject: NudgeSubject | undefined;
      events: TranscriptEvent[];
      sends: NudgeSend[];
      mark: NudgeMark;
      failSend: string | Error;
    }> = {},
  ) => {
    const sent: string[][] = [];
    const reads: number[] = [];
    const waits: number[] = [];
    const store = { mark: over.mark as NudgeMark | undefined };
    const released: string[] = [];
    const check = new AgendaTurnNudge(
      {
        enabled: () => over.enabled ?? true,
        subject: async () => ('subject' in over ? over.subject : subject),
        tail: async (_ferret, limit) => {
          reads.push(limit);
          return over.events ?? [said('user', 'go'), said('assistant', ASKING)];
        },
        sends: async () => over.sends ?? [],
        pause: async ms => void waits.push(ms),
        now: () => '2026-11-15T10:00:00.000Z',
        mark: async () => store.mark,
        reserve: async (_ferret, taken, replacing) => {
          if (store.mark?.sendId !== replacing) return false;
          store.mark = taken;
          return true;
        },
        release: async (_ferret, sendId) => {
          if (store.mark?.sendId === sendId) store.mark = undefined;
          released.push(sendId);
        },
        send: async (ferret, sendId, message) => {
          if (over.failSend !== undefined)
            throw typeof over.failSend === 'string' ? new NudgeSendFailure(over.failSend, 'refused') : over.failSend;
          sent.push([ferret, sendId, message]);
        },
      },
      'fy',
    );
    return { check, sent, reads, waits, store, released };
  };

  test('waits for the transcript to settle, then sends one nudge keyed on the reply', async () => {
    const { check, sent, reads, waits, store } = rig();
    expect(await check.check('f1')).toBe(true);
    expect(waits).toEqual([AGENDA_NUDGE_SETTLE_MS]);
    expect(AGENDA_NUDGE_SETTLE_MS).toBe(2000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe('f1');
    expect(sent[0]?.[1]).toBe(agendaNudgeSendId('f1', ASKING.trim(), 0));
    expect(sent[0]?.[2]).toContain('- Approve the deploy');
    expect(reads).toEqual([AGENDA_NUDGE_TAIL]);
    expect(store.mark).toEqual({ sendId: String(sent[0]?.[1]), at: '2026-11-15T10:00:00.000Z' });
  });

  test('the same reply seen twice is one nudge: the second finds the ferret capped', async () => {
    const { check, sent } = rig();
    expect(await check.check('f1')).toBe(true);
    expect(await check.check('f1')).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test('a ferret nudged once is not nudged again whatever its next turn’s opener looks like', async () => {
    // A pointer opener (Codex turn file), a paste wrapper and a queued-message pointer carry none of the nudge’s words.
    for (const opener of [
      'Read the instructions in /state/turns/turn-007.md and follow them.',
      '<pasted_content id="p1">Read the file</pasted_content>',
      'Queued message pointer: see queue/q-12.md',
    ]) {
      const { check, sent, store } = rig();
      expect(await check.check('f1')).toBe(true);
      store.mark = { ...(store.mark as NudgeMark), at: '2026-11-15T10:00:00.000Z' };
      const again = new AgendaTurnNudge(
        {
          enabled: () => true,
          subject: async () => subject,
          tail: async () => [said('user', opener), said('assistant', ASKING)],
          sends: async () => [send('attention-nudge-f1', '2026-11-15T10:00:01.000Z', true)],
          pause: async () => undefined,
          now: () => '2026-11-15T10:00:02.000Z',
          mark: async () => store.mark,
          reserve: async () => true,
          release: async () => undefined,
          send: async (...args) => void sent.push([...args]),
        },
        'fy',
      );
      expect(await again.check('f1')).toBe(false);
      expect(sent).toHaveLength(1);
    }
  });

  test('after the owner (or a peer) sends, the next completed turn may be nudged again', async () => {
    const first = rig();
    expect(await first.check.check('f1')).toBe(true);
    const mark = first.store.mark as NudgeMark;
    const { check, sent, store } = rig({
      mark,
      sends: [
        send(mark.sendId, '2026-11-15T10:00:01.000Z', true),
        { sendId: 'owner-1', acceptedAt: OWNER_AT, message: 'ok do it', agenda: false },
      ],
    });
    expect(await check.check('f1')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toBe(agendaNudgeSendId('f1', ASKING.trim(), 1));
    expect(store.mark?.sendId).toBe(sent[0]?.[1]);
  });

  test('a turn whose opener says the words of Agenda’s newest send is skipped even when the cap is open', async () => {
    const words = 'Your last reply asked the owner to: do things';
    const { check, sent } = rig({
      events: [said('user', `<pasted_content>${words}</pasted_content>`), said('assistant', ASKING)],
      sends: [{ sendId: 'x', acceptedAt: OWNER_AT, message: words, agenda: true }],
    });
    expect(await check.check('f1')).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a send answered with a refusal takes the reservation back, so nothing was nudged and the next turn may try', async () => {
    for (const code of ['send_refused', 'not_found', 'composer_occupied', 'session_launching', 'invalid']) {
      const { check, store, released } = rig({ failSend: code });
      await expect(check.check('f1')).rejects.toThrow('refused');
      expect(store.mark).toBeUndefined();
      expect(released).toHaveLength(1);
    }
  });

  test('a send that may have been typed keeps its mark: send_unconfirmed, a kept session_send_failed, an unknown code, a bare throw', async () => {
    for (const failSend of ['send_unconfirmed', 'session_send_failed', 'something_new', new Error('boom')]) {
      const { check, store, released } = rig({ failSend });
      await expect(check.check('f1')).rejects.toThrow();
      expect(store.mark).toBeDefined();
      expect(released).toEqual([]);
    }
  });

  test('a nudge answered send_unconfirmed is not followed by another on the next completed turn, even with a pointer opener', async () => {
    const first = rig({ failSend: 'send_unconfirmed' });
    await expect(first.check.check('f1')).rejects.toThrow();
    const mark = first.store.mark as NudgeMark;
    const { check, sent } = rig({
      mark,
      events: [
        said('user', 'Read the instructions in /state/turns/turn-008.md and follow them.'),
        said('assistant', ASKING),
      ],
      sends: [send(mark.sendId, '2026-11-15T09:59:59.000Z', true)],
    });
    expect(await check.check('f1')).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a failure to take the reservation back does not hide the send’s own failure', async () => {
    const failing = new AgendaTurnNudge(
      {
        enabled: () => true,
        subject: async () => subject,
        tail: async () => [said('user', 'go'), said('assistant', ASKING)],
        sends: async () => [],
        pause: async () => undefined,
        now: () => 'x',
        mark: async () => undefined,
        reserve: async () => true,
        release: async () => {
          throw new Error('disk');
        },
        send: async () => {
          throw new NudgeSendFailure('send_refused', 'refused');
        },
      },
      'fy',
    );
    await expect(failing.check('f1')).rejects.toThrow('refused');
  });

  test('a check that loses the reservation sends nothing', async () => {
    const lost = new AgendaTurnNudge(
      {
        enabled: () => true,
        subject: async () => subject,
        tail: async () => [said('user', 'go'), said('assistant', ASKING)],
        sends: async () => [],
        pause: async () => undefined,
        now: () => 'x',
        mark: async () => undefined,
        reserve: async () => false,
        release: async () => undefined,
        send: async () => {
          throw new Error('must not send');
        },
      },
      'fy',
    );
    expect(await lost.check('f1')).toBe(false);
  });

  test('says nothing when the switch is off, the ferret cannot be read, or it is a helper — and reads nothing', async () => {
    for (const over of [{ enabled: false }, { subject: undefined }, { subject: { ...subject, parent: true } }]) {
      const { check, sent, reads, waits } = rig(over);
      expect(await check.check('f1')).toBe(false);
      expect(sent).toEqual([]);
      expect(reads).toEqual([]);
      expect(waits).toEqual([]);
    }
  });

  test('says nothing when there is no turn to read or the reply asks nothing', async () => {
    for (const events of [[], [said('user', 'go'), said('assistant', 'fine')]]) {
      const { check, sent, store } = rig({ events });
      expect(await check.check('f1')).toBe(false);
      expect(sent).toEqual([]);
      expect(store.mark).toBeUndefined();
    }
  });
});
