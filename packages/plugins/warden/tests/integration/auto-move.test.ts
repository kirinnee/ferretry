import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretId, FerretSummary, MoveOptions } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { err, ok, type Result } from '@ferretry/std';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { LoginFactsApi } from '../../contract/others.ts';
import { sourceKey } from '@ferretry/core-asks/contract/testing';
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

function world(
  options: {
    readonly held?: boolean | undefined;
    readonly accounts?: boolean;
    /** The runtimes on the machine: the ferret's own, and by default one with room. */
    readonly runtimes?: typeof RUNTIMES;
    /** When the limit resets (epoch ms) as the pane shows it. */
    readonly retryAt?: number;
    readonly config?: Parameters<typeof wardenConfig>[0];
    /** What Logins answers; a function the test can flip to model an outage and its recovery. */
    readonly logins?: () => LoginFactsApi | undefined;
  } = {},
) {
  const fake = fakeKernel({
    config: wardenConfig(options.config ?? { enabled: true, autoMove: { enabled: true, when: ['rate_limited'] } }),
    start: '2026-11-07T12:00:00.000Z',
  });
  const ferrets = new MovingFerrets();
  ferrets.add({ id: ferretId('f1'), mode: 'auto', state: 'working', runtime: LIMITED });
  ferrets.setPaneLimits([
    {
      ferret: ferretId('f1'),
      login: 'claude-a-login',
      notice: "You've hit your usage limit",
      spend: false,
      ...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
    },
  ]);
  const runtimes = {
    catalog: async () => options.runtimes ?? RUNTIMES,
    tools: async () => [tool('claude', true)],
    resolve: async () => ({ ok: true }),
  } as unknown as RuntimesApi;
  const asked: string[] = [];
  const asks = new FakeAsks();
  const mount = () =>
    createWardenSubsystem({
      kernel: fake.kernel,
      ferrets,
      conversation: fakeConversation(),
      asks,
      usage: () => undefined,
      board: () => undefined,
      runtimes: () => runtimes,
      logins:
        options.logins ??
        (() => ({ list: async () => ({ logins: [credential('claude-a-login'), credential('claude-b-login')] }) })),
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
  let subsystem = mount();
  return {
    ...fake,
    ferrets,
    asks,
    asked,
    /** A new daemon process: nothing in memory, the same state on disk. */
    restart: () => {
      subsystem = mount();
    },
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

  it('should move by default when warden.yaml writes nothing about moving, and not when it says false', async () => {
    // Arrange: a warden.yaml that names neither autoMove nor anything else, and one that switches moving off.
    const absent = world({ config: { enabled: true } });
    const off = world({ config: { enabled: true, autoMove: { enabled: false } } });

    // Act
    await absent.sweep();
    await off.sweep();

    // Assert
    should(absent.ferrets.moves.map(move => move.runtime)).eql(['claude-b-wrapper']);
    should(off.ferrets.moves).eql([]);
  });
});

describe('a Logins outage while a ferret sits on a limit', () => {
  const both = { list: async () => ({ logins: [credential('claude-a-login'), credential('claude-b-login')] }) };
  const down: LoginFactsApi = {
    list: async () => {
      throw new Error('logins is down');
    },
  };
  const outageItems = async (w: ReturnType<typeof world>) =>
    (await w.asks.open({ source: sourceKey('daemon') })).filter(item => item.entry === 'warden:auto-move-failed');

  it('C-110 holds without moving and lists it once, then moves the same ferret on the sweep after Logins is back', async () => {
    // Arrange
    let logins: LoginFactsApi | undefined = down;
    const w = world({ held: false, logins: () => logins });

    // Act
    const first = await w.sweep();
    const second = await w.sweep();
    const listed = await outageItems(w);
    logins = both;
    const recovered = await w.sweep();

    // Assert: a hold, never an error; one record, not one per sweep; no move until the facts exist.
    should(w.ferrets.moves.length).equal(1);
    should(first.actions.filter(action => action.outcome === 'held')).have.length(1);
    should(first.actions.some(action => action.outcome === 'failed')).equal(false);
    should(first.actions[0]?.detail).containEql('the logins could not be read');
    should(second.actions.filter(action => action.outcome === 'held' || action.outcome === 'failed')).have.length(1);
    should(listed).have.length(1);
    should(w.ferrets.moves.map(move => [move.ferret, move.runtime])).eql([['f1', 'claude-b-wrapper']]);
    should(recovered.actions.some(action => action.outcome === 'done' && action.actor === 'auto')).equal(true);
    should(await outageItems(w)).have.length(0);
  });

  it('C-110 still moves it after Logins recovers when the daemon restarted in between, with one notice in all', async () => {
    // Arrange
    let logins: LoginFactsApi | undefined = down;
    const w = world({ held: false, logins: () => logins });

    // Act
    await w.sweep();
    w.restart();
    await w.sweep();
    const listed = await outageItems(w);
    w.restart();
    logins = both;
    await w.sweep();

    // Assert
    should(listed).have.length(1);
    should(w.ferrets.moves.map(move => [move.ferret, move.runtime])).eql([['f1', 'claude-b-wrapper']]);
  });

  it('never moves on unknown facts: an absent Logins holds too, and moves nothing', async () => {
    // Arrange
    const w = world({ held: false, logins: () => undefined });

    // Act
    await w.sweep();
    await w.sweep();

    // Assert
    should(w.ferrets.moves).eql([]);
  });
});

describe('the warden waiting for a limit to reset, with nowhere to move to', () => {
  const RESET = Date.parse('2026-11-07T13:00:00.000Z');
  /** Only the ferret's own login: nothing has room. */
  const alone = { runtimes: [runtime('claude-a')] };

  it('should say when it will resume (Pacific), keep it where it is, and resume it once Ferrets stops showing the limit', async () => {
    // Arrange: Jev and investigations are off (the defaults), so only the rule can act.
    const w = world({ ...alone, retryAt: RESET, held: false });

    // Act
    const waiting = await w.sweep();
    await w.clock.advance(2 * 3_600_000);
    // The reset has passed: Ferrets stops publishing the row, and the prompt still carries the limit with its past reset.
    w.ferrets.setPaneLimits([]);
    w.ferrets.setPrompt(ferretId('f1'), {
      limit: { notice: "You've hit your usage limit", spend: false, retryAt: RESET },
    });
    const resumed = await w.sweep();
    const again = await w.sweep();

    // Assert
    should(w.ferrets.moves).eql([]);
    should(waiting.actions.find(action => action.outcome === 'held')?.detail).match(
      /resumes on its own at Nov 7, 5:00\sAM PST\.$/,
    );
    should(w.ferrets.resumes).have.length(1);
    should(w.ferrets.resumes[0]?.ferret).equal('f1');
    should(w.ferrets.resumes[0]?.message).match(/the usage limit on claude-a-wrapper has reset/);
    should(resumed.actions.some(action => action.action === 'resume' && action.actor === 'auto')).equal(true);
    should(again.actions.filter(action => action.action === 'resume')).have.length(1);
  });

  it('should not resume it while the limit is still published, and not at all once the ferret is off the limit', async () => {
    // Arrange
    const w = world({ ...alone, retryAt: RESET, held: false });

    // Act
    await w.sweep();
    await w.clock.advance(30 * 60_000);
    await w.sweep();
    // It carried on by itself before the reset (no row, no limit on its prompt).
    w.ferrets.setPaneLimits([]);
    await w.clock.advance(2 * 3_600_000);
    await w.sweep();

    // Assert
    should(w.ferrets.resumes).eql([]);
  });

  it('should see no limit, and move or resume nothing, when Ferrets cannot say what the panes show', async () => {
    // Arrange
    const w = world({ ...alone, retryAt: RESET, held: false });
    w.ferrets.paneLimits = async () => {
      throw new Error('the session documents are unreadable');
    };

    // Act
    await w.sweep();

    // Assert
    should(w.ferrets.moves).eql([]);
    should(w.ferrets.resumes).eql([]);
  });

  it('should leave a ferret waiting when its prompt cannot be read, and try nothing', async () => {
    // Arrange
    const w = world({ ...alone, retryAt: RESET, held: false });
    w.ferrets.prompt = async () => {
      throw new Error('the state document is unreadable');
    };

    // Act
    await w.sweep();
    await w.clock.advance(2 * 3_600_000);
    w.ferrets.setPaneLimits([]);
    await w.sweep();

    // Assert
    should(w.ferrets.resumes).eql([]);
  });
});
