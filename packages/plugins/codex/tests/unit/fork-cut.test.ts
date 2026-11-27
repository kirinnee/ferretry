import { describe, expect, test } from 'bun:test';
import { cutRollout, rolloutName } from '../../daemon/lib/fork.ts';

/** The pure cut of a synthetic rollout: nothing is read from disk and nothing is real. */
const ID = '019fab95-c49a-7843-b42f-40a6390eefc3';
const NEW = {
  id: '11111111-2222-3333-4444-555555555555',
  folder: '/work/new',
  marker: '/h/f1/codex-correlation/unreachable',
};
const row = (type: string, payload: object) => `${JSON.stringify({ type, payload })}\n`;
const head = (extra: object = { cli_version: '0.145.0' }) =>
  row('session_meta', { id: ID, cwd: '/work/old', ...extra });
const turn = (n: number) =>
  row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `asked ${n}` }] }) +
  row('event_msg', { type: 'user_message', message: `asked ${n}` }) +
  row('response_item', { type: 'message', role: 'assistant', content: [{ text: `said ${n}` }] });
const file = (turns: number, extra?: object) =>
  head(extra) + Array.from({ length: turns }, (_, index) => turn(index + 1)).join('');
const text = (cut: ReturnType<typeof cutRollout>) => (cut.kind === 'cut' ? cut.text : `refused: ${cut.reason}`);

describe('cutting a rollout at a turn', () => {
  test('keeps the header and turns 1..N, and counts them', () => {
    const cut = cutRollout(file(5), { turn: 2 }, NEW);
    expect(cut).toMatchObject({ kind: 'cut', turns: 2 });
    expect(text(cut).split('\n').length).toBe(1 + 2 * 3 + 1);
    expect(text(cut)).toContain('said 2');
    expect(text(cut)).not.toContain('asked 3');
  });

  test('a turn the conversation does not have refuses, saying how many it has', () => {
    for (const turn of [0, 4, 1.5]) expect(text(cutRollout(file(3), { turn }, NEW))).toContain('which has 3');
  });

  test('an entry names a line inside the turn, or the cut refuses', () => {
    // Lines: 1 header, 2-4 turn 1, 5-7 turn 2, 8-10 turn 3.
    expect(cutRollout(file(3), { turn: 2, entry: `${ID}:7:0:message` }, NEW).kind).toBe('cut');
    for (const entry of [`${ID}:4:0:message`, `${ID}:8:0:message`, `other:7:0:message`, 'nonsense'])
      expect(text(cutRollout(file(3), { turn: 2, entry }, NEW))).toMatch(/is not in turn 2/u);
  });

  test('the unflushed last line is not carried, and a line that is no record refuses the cut', () => {
    expect(text(cutRollout(`${file(2)}{"type":"event_msg","torn`, { turn: 2 }, NEW))).not.toContain('torn');
    expect(text(cutRollout(`${head()}not json\n${turn(1)}`, { turn: 1 }, NEW))).toMatch(/line 2 .* not a record/u);
  });

  test('only the tested rollout writer is cut; an older, newer, unnamed or unreadable one is not', () => {
    for (const cli_version of ['0.145.0'])
      expect(cutRollout(file(2, { cli_version }), { turn: 1 }, NEW).kind).toBe('cut');
    for (const extra of [
      { cli_version: '0.100.2' },
      { cli_version: '0.146.0' },
      { cli_version: 'soon' },
      { cli_version: 7 },
      {},
    ]) {
      expect(text(cutRollout(file(2, extra), { turn: 1 }, NEW))).toMatch(/rollout format Ferretry has not tested/u);
    }
    expect(text(cutRollout(file(2, {}), { turn: 1 }, NEW))).toContain('(unknown version)');
    expect(text(cutRollout(file(2, { cli_version: '0.146.0' }), { turn: 1 }, NEW))).toContain('Codex 0.146.0');
  });

  test('a header Ferretry cannot read, or no header, refuses', () => {
    expect(text(cutRollout(turn(1), { turn: 1 }, NEW))).toMatch(/no header/u);
    expect(text(cutRollout(row('session_meta', { cwd: '/x' }) + turn(1), { turn: 1 }, NEW))).toMatch(/no header/u);
  });

  test('the new header carries the new id and folder, and no copy carries the source home’s correlation path', () => {
    const marked = file(2).replace('asked 2', `see ${NEW.marker}`);
    const cut = cutRollout(marked, undefined, NEW);
    expect(text(cut)).not.toContain(NEW.marker);
    expect(JSON.parse(text(cut).split('\n')[0] as string).payload).toMatchObject({ id: NEW.id, cwd: '/work/new' });
  });

  test('a rollout is filed under the day folder and name Codex uses', () => {
    expect(rolloutName(NEW.id, new Date('2026-11-27T09:05:07.000Z'))).toBe(
      `sessions/2026/11/27/rollout-2026-11-27T09-05-07-${NEW.id}.jsonl`,
    );
  });
});
