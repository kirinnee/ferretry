import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretId, FerretSummary, MoveOptions } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { err, ok, type Result } from '@ferretry/std';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import { createWardenSubsystem } from '../../daemon/subsystem.ts';
import { fakeKernel, wardenConfig } from '../support/kernel.ts';
import { credential, runtime, tool } from '../support/pack.ts';

/**
 * Automatic moves and a failover verdict, over the ports the daemon hands the Warden (D2 #19): a fake fleet whose ferret
 * sits on a login that hit its limit, Logins' and Runtimes' facts, and Accounts' one owner-hold yes or no. Nothing is
 * moved but through Ferrets' own `move`, and never while something of the owner's is open on the ferret.
 */

/** Ferrets that really change login when moved, and say what each move was asked for. */
class MovingFerrets extends FakeFerrets {
  readonly moves: { readonly ferret: string; readonly runtime: string; readonly options: MoveOptions }[] = [];
  refusal: string | undefined;
  async move(
    ferret: FerretId,
    target: string,
    options: MoveOptions,
  ): Promise<Result<FerretSummary, { code: string; reason: string }>> {
    this.moves.push({ ferret, runtime: target, options });
    const found = await this.get(ferret);
    if (found === undefined) return err({ code: 'not_found', reason: 'no such ferret' });
    if (this.refusal !== undefined) return err({ code: 'in_flight', reason: this.refusal });
    return ok(this.add({ ...found, runtime: target }));
  }
}

const LIMITED = 'claude-a-wrapper';
const RUNTIMES = [runtime('claude-a'), runtime('claude-b')];

function world(options: { readonly held?: boolean | undefined; readonly accounts?: boolean } = {}) {
  const fake = fakeKernel({
    config: wardenConfig({ enabled: true, autoMove: { enabled: true, when: ['rate_limited'] } }),
    start: '2026-11-07T12:00:00.000Z',
  });
  const ferrets = new MovingFerrets();
  ferrets.add({ id: ferretId('f1'), mode: 'auto', state: 'working', runtime: LIMITED });
  ferrets.setPaneLimits([
    { ferret: ferretId('f1'), login: 'claude-a-login', notice: "You've hit your usage limit", spend: false },
  ]);
  const runtimes = {
    catalog: async () => RUNTIMES,
    tools: async () => [tool('claude', true)],
    resolve: async () => ({ ok: true }),
  } as unknown as RuntimesApi;
  const asked: string[] = [];
  const subsystem = createWardenSubsystem({
    kernel: fake.kernel,
    ferrets,
    conversation: fakeConversation(),
    asks: new FakeAsks(),
    usage: () => undefined,
    board: () => undefined,
    runtimes: () => runtimes,
    logins: () => ({ list: async () => ({ logins: [credential('claude-a-login'), credential('claude-b-login')] }) }),
    ...(options.accounts === false
      ? {}
      : {
          accounts: () => ({
            ownerHold: (ferret: string) => {
              asked.push(ferret);
              return options.held === true;
            },
          }),
        }),
  });
  return {
    ...fake,
    ferrets,
    subsystem,
    asked,
    sweep: async () => {
      await subsystem.run(false);
      return await subsystem.status();
    },
  };
}

describe('the warden moving a ferret whose login hit its limit', () => {
  it('should move a ferret over its quota, with nothing held, to a login that has room', async () => {
    // Arrange
    const w = world({ held: false });

    // Act
    const status = await w.sweep();

    // Assert: through Ferrets' own move, as the Warden's, onto the other login, and never forced.
    should(w.ferrets.moves.map(move => [move.ferret, move.runtime])).eql([['f1', 'claude-b-wrapper']]);
    should(w.ferrets.moves[0]?.options.actor).equal('warden');
    should(w.ferrets.moves[0]?.options.forceInflight).be.undefined();
    should(status.actions.some(action => action.outcome === 'done' && action.actor === 'auto')).equal(true);
  });

  it('should not move a ferret the owner has something open on, and say why', async () => {
    // Arrange: an input card, a phone approval, a plan or a copied secret — Accounts answers one yes.
    const w = world({ held: true });

    // Act
    const status = await w.sweep();

    // Assert
    should(w.asked).containEql('f1');
    should(w.ferrets.moves).eql([]);
    const held = status.actions.find(action => action.outcome === 'held');
    should(held?.detail).containEql('something of the owner');
    should(held?.detail).containEql('Not moved');
  });

  it('should move nothing when Accounts cannot say, because a hold that cannot be checked is a hold', async () => {
    // Arrange
    const w = world({ accounts: false });

    // Act
    await w.sweep();

    // Assert
    should(w.ferrets.moves).eql([]);
  });

  it("should say Ferrets' own refusal, never force the move, and not try again on the next sweep", async () => {
    // Arrange: a background job in flight is the move's own refusal.
    const w = world({ held: false });
    w.ferrets.refusal = 'its background jobs are still running';

    // Act
    const first = await w.sweep();
    await w.sweep();

    // Assert
    should(w.ferrets.moves.length).equal(1);
    should(w.ferrets.moves[0]?.options.forceInflight).be.undefined();
    should(first.actions.some(action => action.outcome === 'failed')).equal(true);
  });
});
