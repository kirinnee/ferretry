/**
 * The app's answered set for ferrets' rule suggestions (R1, C2): a suggestion the owner answered here leaves the Inbox.
 * The sweep that read the owner's suggestion list (`GET /v1/sign-in-rules/suggestions`) is Accounts' route and is not
 * read by this half; the set itself is the Inbox's.
 */

import { describe, expect, it } from 'bun:test';
import { AnsweredSuggestions } from '../../../../app/lib/answered-suggestions.ts';
import { daemonId } from '../../../../app/shell.ts';

const STUDIO = daemonId('studio');
const OPEN = 'srg_0000000000000001';
const ANSWERED = 'srg_0000000000000002';

const answeredOf = (answered: AnsweredSuggestions, machine: string, id: string): boolean =>
  answered.has(answered.getSnapshot(), daemonId(machine), id);

describe('the app’s answered set', () => {
  it('tells its listeners once per new answer, and stops telling one that left', () => {
    const answered = new AnsweredSuggestions();
    let told = 0;
    const leave = answered.subscribe(() => {
      told += 1;
    });
    answered.mark(STUDIO, [ANSWERED]);
    answered.mark(STUDIO, [ANSWERED]);
    leave();
    answered.mark(STUDIO, [OPEN]);
    expect(told).toBe(1);
    expect(answeredOf(answered, 'studio', OPEN)).toBe(true);
  });
});
