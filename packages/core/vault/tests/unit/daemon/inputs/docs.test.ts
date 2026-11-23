import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';

const DOC = await readFile(join(import.meta.dir, '../../../../../../../docs/input-requests.md'), 'utf8');
const row = (cell: string): string => DOC.split('\n').find(line => line.startsWith(cell)) ?? '';

describe('docs/input-requests.md says what the bridge does and does not promise', () => {
  it('should not claim a secret never reaches the agent, a log or disk without saying whose promise that is', () => {
    const sensitivity = row('| `secret`');

    should(DOC).not.containEql('Never reaches the agent, a log or disk');
    should(sensitivity).containEql('bridge never carries');
    should(sensitivity).containEql('no lock after an answer');
    should(sensitivity).containEql('best effort');
  });

  it('should open its promise as the bridge’s own, and say nothing holds the target back after an answer', () => {
    should(DOC).containEql('The bridge itself never carries a `secret` value');
    should(DOC).containEql('It is **not** a promise that the value can never be read off the target');
    should(DOC).containEql('no lock after an answer');
  });

  it('should declare the GAP: a page that echoes a password is readable by the ferret straight after an answer', () => {
    should(DOC).containEql('### No lock after an answer');
    should(DOC).containEql('Declared GAP: a page or program that echoes a password is now readable by the ferret');
    should(DOC).containEql('Declared GAP: nothing is held from the ferret after an answer');
    should(DOC).not.containEql('### The pane quarantine');
    should(DOC).not.containEql('### How long the lock lasts');
  });

  it('should describe the risk flag instead of a refusal or a trust tick', () => {
    for (const stale of ['echo_on', 'I trust this program', 'trusted-program', 'trust set'])
      should(DOC).not.containEql(stale);
    for (const level of ['green', 'amber', 'red']) should(DOC).containEql(`| ${level}`);
    should(DOC).containEql('Send is available at every level');
  });

  it('should describe a private code as allowed and flagged amber, never refused', () => {
    const sensitivity = row('| `private`');

    should(sensitivity).containEql('Never refused');
    should(sensitivity).containEql('amber');
    should(DOC).not.containEql('Refused at raise');
    should(DOC).not.containEql('deferred `private`');
  });

  it('should say sudo goes through the app', () => {
    should(DOC).containEql('terminal_request_input');
  });

  it('should say what stays after an answer: value masking, the pending-input rules and the restart replay lock', () => {
    should(DOC).containEql('_Value masking_');
    should(DOC).containEql('_The restart replay lock_');
  });
});
