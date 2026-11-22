import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

/** The Notify rule a lead ferret reads (`instructions/notify.md`), pinned exactly; the runtimes wrapper says the same words. */
const NOTIFY_RULE = readFileSync(new URL('../../instructions/notify.md', import.meta.url), 'utf8').trim();

const notify = manifest.actions?.cli?.find(entry => entry.verb === 'notify');

describe('the Notify instruction', () => {
  test('says exactly this', () => {
    expect(NOTIFY_RULE).toBe(
      'Notify: the owner reads their notices, not your replies. To tell them something worth their time (a result, a blocker, a decision you made for them) run `fy notify "<summary>" [--body "<detail>"]`: a quiet notice. Add `--buzz` only when it must reach their phone now. Never notify progress or chatter.',
    );
  });

  test('is for leads only: a helper reports to its lead, never to the owner', () => {
    expect(manifest.instructions?.find(entry => entry.id === 'notify')?.when).toEqual({ role: 'lead' });
  });

  test('names a verb and a flag that are real', () => {
    expect(notify).toBeDefined();
    expect(notify?.options?.map(option => option.flag.split(/[ ,]+/u))).toEqual(
      expect.arrayContaining([expect.arrayContaining(['--buzz'])]),
    );
    expect(NOTIFY_RULE).not.toContain('--ping');
  });
});
