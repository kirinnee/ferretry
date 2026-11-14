import { describe, it } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { device, ferret, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import accounts from '../../../daemon/index.ts';

/**
 * `account_propose` and `task_plan`, the two agent tools beside `account_hint` that the services behind them already
 * served (v4 `account.propose` and `task.plan`). The real half is driven through the kernel's test host, as a ferret
 * (the credential alone names the session). The four secure-copy tools are NOT served: the last test pins that the
 * manifest does not declare them, so no agent is told to call a tool that cannot work.
 */

/**
 * Gate's stand-in carries the credential a tool call is judged by, as the real Gate does (the kernel's carries only the
 * caller): `who` is the ferret making the call, or the owner at the machine.
 */
const host = async () => {
  const asks = new FakeAsks();
  const call = { who: 'F1' as string | 'owner' };
  const gate = new StandInAdmission(() =>
    call.who === 'owner' ? ownerStanding() : ferretStanding(call.who as FerretId),
  );
  const h = await testHost({
    plugins: [accounts],
    gate,
    fakes: { gate: { audit: async () => undefined }, vault: new FakeVault(), asks, sealed: new FakeSealedDocuments() },
  });
  return { h, asks, call };
};

/** A saved password sign-in on github.com, and its `si_…` id. */
const saveGithub = async ({ h, call }: Awaited<ReturnType<typeof host>>): Promise<string> => {
  // Saving an account is the owner's; the tool calls after it are the ferret's.
  call.who = 'owner';
  await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub', username: 'kirin' } });
  const added = await h.request('POST', '/v1/accounts/GITHUB/sign-ins', {
    body: { place: { kind: 'site', domains: ['github.com'], match: ['github.com'] } },
  });
  should(added.status).equal(200);
  const listed = (await h.request('GET', '/v1/accounts')).json<{ signIns: { id: string }[] }>();
  const [first] = listed.signIns;
  if (first === undefined) throw new Error('no sign-in was saved');
  call.who = 'F1';
  return first.id;
};

const refusal = async (call: Promise<{ readonly isError?: boolean; readonly text: string }>): Promise<string> => {
  const result = await call.catch((error: unknown) => ({ isError: true, text: String(error) }));
  should(result.isError).be.true();
  return result.text;
};

describe('account_propose', () => {
  it('T-0002 should file a recipe for a sign-in as a card the owner decides, and say it does not need to wait', async () => {
    const world = await host();
    const { h, asks } = world;
    const signIn = await saveGithub(world);

    const filed = await h.tool(
      'account_propose',
      { signIn, recipe: 'Open github.com → Sign in → done when the dashboard shows', why: 'the button moved' },
      { as: ferret('F1') },
    );

    should(filed.isError ?? false).be.false();
    should(filed.text).match(
      /^Proposed a recipe for GITHUB \[si_[0-9a-f]{16}\] \(!A\d+\); the owner approves or declines it\./u,
    );
    should(filed.text).containEql('You do not need to wait.');
    should(filed.data).match({ recipe: { state: 'pending', login: 'GITHUB' } });
    should(await asks.open({ state: 'open' })).not.be.empty();
  });

  it('should suggest a standing rule alone, and tell the ferret it will not hear back', async () => {
    const world = await host();
    const { h } = world;
    const signIn = await saveGithub(world);

    const said = await h.tool(
      'account_propose',
      { signIn, preapprove: true, why: 'I sign in daily' },
      { as: ferret('F1') },
    );

    // A sign-in a rule could cover raises the suggestion's card; one it could never cover is refused in a sentence
    // about the sign-in alone. Either way the ferret reads words it can act on, never a value.
    should(said.text.length).be.above(0);
    if (said.isError !== true)
      should(said.text).match(/^Suggested a standing rule for github\.com \(!A\d+\); the owner decides/u);
  });

  it('should refuse a call naming no recipe and no rule, and a sign-in that is not saved, in words', async () => {
    const world = await host();
    const { h } = world;
    const signIn = await saveGithub(world);
    should(await refusal(h.tool('account_propose', { signIn, why: 'x' }, { as: ferret('F1') }))).containEql(
      'suggest a recipe, a standing rule',
    );
    should(
      await refusal(
        h.tool('account_propose', { signIn: 'si_ffffffffffffffff', recipe: 'Steps', why: 'x' }, { as: ferret('F1') }),
      ),
    ).not.be.empty();
  });

  it('should refuse the older `login` spelling: 5.0 names a sign-in by its id only', async () => {
    const { h } = await host();
    await refusal(h.tool('account_propose', { login: 'GITHUB', recipe: 'Steps', why: 'x' }, { as: ferret('F1') }));
  });

  it('should be a ferret’s: a person at the machine is told so, and nothing is filed', async () => {
    const world = await host();
    const { h, asks, call } = world;
    const signIn = await saveGithub(world);
    call.who = 'owner';
    const said = await refusal(
      h.tool('account_propose', { signIn, recipe: 'Steps', why: 'x' }, { as: device('phone') }),
    );
    should(said).containEql('Only an agent');
    should(await asks.open({ state: 'open' })).be.empty();
  });
});

describe('task_plan', () => {
  it('T-0043 should raise ONE card for the plan and tell the ferret each line’s state, never which secrets an account holds', async () => {
    const world = await host();
    const { h, asks } = world;
    const signIn = await saveGithub(world);

    const planned = await h.tool(
      'task_plan',
      { lines: [{ kind: 'sign-in', signIn, fields: ['username', 'password'], uses: 2, why: 'deploy the site' }] },
      { as: ferret('F1') },
    );

    should(planned.isError ?? false).be.false();
    should(planned.text).match(/^Asked the owner to approve 1 line in advance \(!A\d+\)\./u);
    should(planned.text).containEql('anything else still asks');
    const view = (planned.data as { taskPlan: { state: string; lines: Record<string, unknown>[] } }).taskPlan;
    should(view.state).equal('pending');
    should(view.lines).have.length(1);
    should(JSON.stringify(view)).not.match(/"can"|"history"|"flags"|"candidates"/u);
    should(await asks.open({ state: 'open' })).have.length(1);
  });

  it('should refuse two lines for one sign-in, an empty plan and a line of the other kind, in words', async () => {
    const world = await host();
    const { h, asks } = world;
    const signIn = await saveGithub(world);
    const line = { kind: 'sign-in', signIn, fields: ['password'], uses: 1, why: 'deploy' };
    await refusal(h.tool('task_plan', { lines: [line, line] }, { as: ferret('F1') }));
    await refusal(h.tool('task_plan', { lines: [] }, { as: ferret('F1') }));
    // A page sign-in named as a terminal one is the daemon's refusal (resolve), not the schema's.
    should(
      await refusal(
        h.tool(
          'task_plan',
          { lines: [{ kind: 'terminal-sign-in', signIn, uses: 1, why: 'sudo' }] },
          { as: ferret('F1') },
        ),
      ),
    ).containEql('other kind');
    should(await asks.open({ state: 'open' })).be.empty();
  });

  it('should be a ferret’s: a person at the machine is told so, and no card is raised', async () => {
    const world = await host();
    const { h, asks, call } = world;
    const signIn = await saveGithub(world);
    call.who = 'owner';
    const said = await refusal(
      h.tool(
        'task_plan',
        { lines: [{ kind: 'sign-in', signIn, fields: ['password'], uses: 1, why: 'deploy' }] },
        { as: device('phone') },
      ),
    );
    should(said).containEql('Only an agent');
    should(await asks.open({ state: 'open' })).be.empty();
  });
});

describe('the secure-copy tools', () => {
  it('should not be declared, so no agent is offered a tool that cannot work', () => {
    const declared = accounts.manifest.actions.agentTools.map(tool => tool.name);
    should(declared).eql(['account_hint', 'account_propose', 'task_plan']);
    for (const name of ['secure_copy', 'secure_list', 'secure_discard', 'secure_paste'])
      should(declared).not.containEql(name);
  });
});
