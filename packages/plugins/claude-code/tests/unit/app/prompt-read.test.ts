/**
 * A page opening is not an act: the cards above the composer read what the ferret is stopped on by themselves, on mount
 * and on a beat, and that route is `terminal.use` behind a passkey step-up. The read is QUIET, so an agenda item that
 * draws the conversation never greets the owner with "open a terminal" (the daemon's gate is unchanged: a refusal
 * simply reads as "stopped on nothing"). Fixed fake data only.
 */
import { describe, expect, it } from 'bun:test';
import { readStoppedOn } from '../../../app/lib/prompt-read.ts';

const FERRET = 'mvuc7tsf-0c3d50df';

const scripted = (answer: () => Promise<unknown>) => {
  const inits: unknown[] = [];
  const client = {
    call: async (_route: string, init?: unknown) => {
      inits.push(init);
      return await answer();
    },
    subscribe: () => () => undefined,
  };
  return { client: client as never, inits };
};

describe('reading what a ferret is stopped on', () => {
  it('is a quiet read, so no passkey is raised for a page that merely opened', async () => {
    const { client, inits } = scripted(async () => ({ turnState: 'working' }));
    await readStoppedOn(client, FERRET);
    expect(inits).toEqual([{ params: { ferretId: FERRET }, quiet: true }]);
  });

  it('reads a refused read as stopped on nothing, with no card and no throw', async () => {
    const { client } = scripted(async () => {
      throw new Error('grant_step_up_required');
    });
    expect(await readStoppedOn(client, FERRET)).toEqual({ needsInput: false });
  });
});
