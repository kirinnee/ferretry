import { describe, it } from 'bun:test';
import should from 'should';
import { registry as generated } from '../../src/generated/commands.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';

const owner = (words: string[]) => {
  const resolved = resolveVerb(buildVerbTable(generated), words);
  return resolved.kind === 'verb' ? resolved.entry.owner : 'unknown';
};

describe('the retained read verbs', () => {
  it('V-0058 V-0311 attach and logs are the Terminals and Conversation verbs, so the shell holds no second copy', () => {
    const table = buildVerbTable(generated);
    should(owner(['attach', 'a'])).equal('terminals');
    should(owner(['logs', 'a'])).equal('conversation');
    should(table.conflicts.filter(conflict => ['attach', 'logs'].includes(conflict.line))).deepEqual([]);
  });

  it('V-0442 V-0258 V-0495 snapshot, events and view are not shell verbs, so no copy can shadow their owners', () => {
    for (const verb of ['snapshot', 'events', 'view']) should(owner([verb, 'ada'])).not.equal('shell');
  });

  it("stream is not a shell verb: today's journal stream is ported once Ferrets declares /v1/events", () => {
    should(owner(['stream'])).not.equal('shell');
  });
});
