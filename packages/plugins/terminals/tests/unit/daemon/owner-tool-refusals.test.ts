import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { FERRET, type Half, terminalsHalf } from '../../support/daemon/half.ts';

/**
 * The owner's terminal tools route (`POST /v1/ferrets/:ferretId/surfaces/terminals/tools`) answers a refusal the way the
 * ferret's own MCP path does: in words, with a status a client can branch on. A refused call is a normal answer (an
 * unknown terminal, a tool only an agent may use), never "the daemon failed to handle this request".
 */
describe('the owner’s terminal tools route refuses in words, never as a bare 500', () => {
  let half: Half | undefined;
  afterEach(async () => {
    await half?.host.stop();
    half = undefined;
  });

  const call = async (body: Record<string, unknown>) => {
    half ??= await terminalsHalf();
    half.as('owner');
    return await half.host.request('POST', `/v1/ferrets/${FERRET}/surfaces/terminals/tools`, { body });
  };

  const missing: readonly (readonly [string, Record<string, unknown>])[] = [
    ['terminal.read', {}],
    ['terminal.send', { text: 'ls', keys: ['enter'] }],
    ['terminal.close', {}],
  ];
  for (const [tool, extra] of missing)
    it(`${tool} on a terminal that is not there is a 404 that says so`, async () => {
      const answer = await call({ tool, name: 'nope', ...extra });

      should(answer.status).equal(404);
      should(answer.json<{ code: string }>().code).equal('not_found');
      should(answer.json<{ error: string }>().error).match(/nope/u);
    });

  it('terminal.ask_owner is a 400 for the owner, who already has the terminal', async () => {
    const opened = await call({ tool: 'terminal.open', name: 'dev' });
    should(opened.status).equal(200);

    const answer = await call({ tool: 'terminal.ask_owner', name: 'dev', message: 'sign in please' });

    should(answer.status).equal(400);
    should(answer.json<{ code: string }>().code).equal('bad_request');
    should(answer.json<{ error: string }>().error).equal(
      'Only an agent hands a surface to its owner; you already have it.',
    );
  });
});
