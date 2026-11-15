import { describe, expect, test } from 'bun:test';
import type { TranscriptEvent } from '@ferretry/plugin-conversation/contract';
import {
  AGENDA_NUDGE_MARK,
  AGENDA_NUDGE_TAIL,
  AgendaTurnNudge,
  agendaNudgeMessage,
  agendaNudgeSendId,
  attentionNudge,
  finishedTurn,
  raisesAgendaItem,
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

  test('the send id is the ferret’s and the turn’s own', () => {
    expect(agendaNudgeSendId('f1', 'turn-3')).toBe('attention-nudge-f1-turn-3');
  });
});

describe('the check at a turn end', () => {
  const rig = (
    over: Partial<{ enabled: boolean; subject: NudgeSubject | undefined; events: TranscriptEvent[] }> = {},
  ) => {
    const sent: string[][] = [];
    const reads: number[] = [];
    const check = new AgendaTurnNudge(
      {
        enabled: () => over.enabled ?? true,
        subject: async () => ('subject' in over ? over.subject : subject),
        tail: async (_ferret, limit) => {
          reads.push(limit);
          return over.events ?? [said('user', 'go'), said('assistant', ASKING)];
        },
        send: async (ferret, sendId, message) => void sent.push([ferret, sendId, message]),
      },
      'fy',
    );
    return { check, sent, reads };
  };

  test('sends one nudge under the turn’s own send id', async () => {
    const { check, sent, reads } = rig();
    expect(await check.check('f1', 'turn-3')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe('f1');
    expect(sent[0]?.[1]).toBe('attention-nudge-f1-turn-3');
    expect(sent[0]?.[2]).toContain('- Approve the deploy');
    expect(reads).toEqual([AGENDA_NUDGE_TAIL]);
  });

  test('says nothing when the switch is off, the ferret cannot be read, or it is a helper — and reads nothing', async () => {
    for (const over of [{ enabled: false }, { subject: undefined }, { subject: { ...subject, parent: true } }]) {
      const { check, sent, reads } = rig(over);
      expect(await check.check('f1', 't')).toBe(false);
      expect(sent).toEqual([]);
      expect(reads).toEqual([]);
    }
  });

  test('says nothing when there is no turn to read or the reply asks nothing', async () => {
    for (const events of [[], [said('user', 'go'), said('assistant', 'fine')]]) {
      const { check, sent } = rig({ events });
      expect(await check.check('f1', 't')).toBe(false);
      expect(sent).toEqual([]);
    }
  });
});
