import { describe, expect, test } from 'bun:test';
import { AgendaContext, AskDeliveries } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

describe('the hooks Asks offers', () => {
  test('agenda.context is on the security path: only ferrets and board may take it, under their own keys', () => {
    expect(AgendaContext.mode).toBe('provide');
    expect(AgendaContext.takers).toEqual(['ferrets', 'board']);
    expect(AgendaContext.key.safeParse('ferrets').success).toBe(true);
    expect(AgendaContext.key.safeParse('board').success).toBe(true);
    expect(AgendaContext.key.safeParse('machine').success).toBe(false);
    expect(manifest.hooks?.offers?.map(o => o.hook)).toContain(AgendaContext);
  });

  test('ask.delivery types into a ferret, so one named plugin (conversation) may provide it', () => {
    expect(AskDeliveries.takers).toEqual(['conversation']);
  });
});
