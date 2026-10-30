import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';

const DOC = readFileSync(join(import.meta.dir, '../../../../../docs/input-requests.md'), 'utf8');
const row = (cell: string): string => DOC.split('\n').find(line => line.startsWith(cell)) ?? '';

describe('docs/input-requests.md says what the bridge does and does not promise', () => {
  it('should not claim a secret never reaches the agent, a log or disk without saying whose promise that is', () => {
    const sensitivity = row('| `secret`');

    should(DOC).not.containEql('Never reaches the agent, a log or disk');
    should(sensitivity).containEql('bridge never carries');
    should(sensitivity).containEql('quarantine');
    should(sensitivity).containEql('best effort');
  });

  it('should open its promise as the bridge’s own, and name the window in which the pane is held back', () => {
    should(DOC).containEql('The bridge itself never carries a `secret` value');
    should(DOC).containEql('It is **not** a promise that the value can never be read off the target');
  });

  it('should describe the risk flag instead of a refusal or a trust tick', () => {
    for (const stale of ['echo_on', 'I trust this program', 'trusted-program', 'trust set'])
      should(DOC).not.containEql(stale);
    for (const level of ['green', 'amber', 'red']) should(DOC).containEql(`| ${level}`);
    should(DOC).containEql('Send is available at every level');
  });

  it('should say sudo goes through the app', () => {
    should(DOC).containEql('terminal_request_input');
  });

  it('should describe unresolved holds and the one publication gate', () => {
    should(DOC).containEql('A hold stays unresolved until its settlement is recorded');
    should(DOC).containEql('ONE publication gate');
    should(DOC).containEql('exactly the');
  });
});
