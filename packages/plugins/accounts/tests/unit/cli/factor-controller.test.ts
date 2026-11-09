import { describe, it } from 'bun:test';
import should from 'should';
import {
  LOGIN_TOTP_WARNING,
  padInputValue,
  TOTP_INPUT_PROBLEMS,
  TWO_FACTOR_ERROR_CODES,
  TWO_FACTOR_STAGE_TTL_SECONDS,
  type TwoFactorSeedStaged,
  type TwoFactorSeedStageView,
} from '../../../contract/routes/index.ts';
import { TwoFactorSeedController } from '../../../cli/lib/factor-controller.ts';
import type { ITwoFactorSeedGateway } from '../../../cli/lib/factor-gateway.ts';
import { FyHttpError } from '../../../cli/shell.ts';
import { AT, DAMAGED, LIST, rejection } from './accounts-rig.ts';

const KEY = 'JBSWY3DPEHPK3PXP';
const STAGE = `st_${'5'.repeat(24)}`;

const STAGED: TwoFactorSeedStaged = {
  stage: STAGE as TwoFactorSeedStaged['stage'],
  account: 'GITHUB_WORK',
  label: 'authenticator',
  expiresAt: AT,
  parsed: { params: { algorithm: 'SHA1', digits: 6, period: 30 } },
};

const view = (state: TwoFactorSeedStageView['state']): TwoFactorSeedStageView => ({
  stage: STAGE as TwoFactorSeedStageView['stage'],
  account: 'GITHUB_WORK',
  label: 'authenticator',
  state,
  expiresAt: AT,
});

interface Rig {
  readonly ownSessionId?: string;
  readonly interactive?: boolean;
  readonly typed?: readonly string[];
  readonly hidden?: readonly string[];
  /** What each `stage` call does, in order: an answer or something to throw. */
  readonly stages?: readonly (TwoFactorSeedStaged | Error)[];
  /** What each `view` call does, in order; the last repeats. */
  readonly views?: readonly (TwoFactorSeedStageView | Error)[];
  readonly accountsFail?: unknown;
  readonly list?: typeof LIST;
}

function rig(options: Rig = {}) {
  const calls: unknown[][] = [];
  const said: string[] = [];
  const asked: string[] = [];
  const askedHidden: string[] = [];
  const typed = [...(options.typed ?? ['yes'])];
  const hidden = [...(options.hidden ?? [KEY])];
  const stages = [...(options.stages ?? [STAGED])];
  const views = [...(options.views ?? [view('saved')])];
  let clock = 0;
  const sleeps: number[] = [];
  const gateway: ITwoFactorSeedGateway = {
    stage: async (account, body) => {
      calls.push(['stage', account, body]);
      const next = stages.shift();
      if (next === undefined) throw new Error('unexpected stage');
      if (next instanceof Error) throw next;
      return next;
    },
    confirmInApp: async (account, stage, body) => {
      calls.push(['confirmInApp', account, stage, body]);
      return { stage: stage as never, session: body.session ?? 'newest-session', agendaItemId: 'A7' };
    },
    view: async (account, stage) => {
      calls.push(['view', account, stage]);
      const next = views.length > 1 ? views.shift() : views[0];
      if (next === undefined) throw new Error('unexpected view');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const controller = new TwoFactorSeedController({
    gateway,
    accounts: {
      list: async () => {
        calls.push(['list']);
        if (options.accountsFail !== undefined) throw options.accountsFail;
        return options.list ?? LIST;
      },
    },
    out: { success: message => void said.push(message) },
    prompt: {
      ask: async message => {
        asked.push(message);
        const answer = typed.shift();
        if (answer === undefined) throw new Error(`unexpected question: ${message}`);
        return answer;
      },
      askHidden: async message => {
        askedHidden.push(message);
        const answer = hidden.shift();
        if (answer === undefined) throw new Error(`unexpected hidden question: ${message}`);
        return answer;
      },
    },
    interactive: options.interactive ?? true,
    ownSessionId: options.ownSessionId,
    sleep: async ms => {
      sleeps.push(ms);
      clock += ms;
    },
    nowMs: () => clock,
  });
  return { controller, calls, said, asked, askedHidden, sleeps };
}

describe('TwoFactorSeedController add', () => {
  it('should warn, ask for yes, read the key hidden, stage it padded and wait for the passkey in the app', async () => {
    const { controller, calls, said, asked, askedHidden, sleeps } = rig({
      ownSessionId: ' session-one ',
      views: [view('waiting'), view('waiting'), view('saved')],
    });
    await controller.add(' GITHUB_WORK ', { totp: true, label: ' authenticator ' });
    should(said[0]).equal(`Saving a 2FA key: ${LOGIN_TOTP_WARNING}`);
    should(asked).eql(['Type yes to save it anyway: ']);
    should(askedHidden).eql(['2FA key, or its otpauth://totp link (hidden): ']);
    should(calls.map(call => call[0])).eql(['list', 'stage', 'confirmInApp', 'view', 'view', 'view']);
    should(calls[1]).eql([
      'stage',
      'GITHUB_WORK',
      { padded: padInputValue(KEY), totpAcknowledged: true, label: 'authenticator' },
    ]);
    should(calls[2]).eql(['confirmInApp', 'GITHUB_WORK', STAGE, { session: 'session-one' }]);
    should(said[1]).containEql('!A7').and.containEql('(session session-one)');
    should(sleeps).eql([1_000, 1_000]);
    should(said.at(-1)).equal('Saved: Ferretry makes the codes for GITHUB_WORK now.');
    should(said.join('\n')).not.containEql(KEY);
  });

  it('should skip the question with --i-understand-totp, and use --session over the session it runs in', async () => {
    const { controller, calls, asked } = rig({ ownSessionId: 'inside', typed: [] });
    await controller.add('GITHUB_WORK', { totp: true, iUnderstandTotp: true, session: ' named ' });
    should(asked).eql([]);
    should(calls.find(call => call[0] === 'confirmInApp')).eql([
      'confirmInApp',
      'GITHUB_WORK',
      STAGE,
      { session: 'named' },
    ]);
  });

  it("should leave the session out when there is none, so the daemon picks the owner's newest", async () => {
    const { controller, calls, said } = rig({ ownSessionId: '  ' });
    await controller.add('GITHUB_WORK', { totp: true, session: ' ' });
    should(calls.find(call => call[0] === 'confirmInApp')).eql(['confirmInApp', 'GITHUB_WORK', STAGE, {}]);
    should(calls.find(call => call[0] === 'stage')?.[2]).eql({ padded: padInputValue(KEY), totpAcknowledged: true });
    should(said[1]).containEql('(session newest-session)');
  });

  it('should say each way the wait ends: denied, expired, and still waiting when its time is up', async () => {
    const denied = rig({ views: [view('dropped')] });
    await denied.controller.add('GITHUB_WORK', { totp: true });
    should(denied.said.at(-1)).equal('Denied: nothing was saved.');

    const expired = rig({ views: [view('expired')] });
    await expired.controller.add('GITHUB_WORK', { totp: true });
    should(expired.said.at(-1)).equal('Timed out: nothing was saved. Run it again to save the key.');

    const gone = rig({ views: [new FyHttpError('no such stage', 404, 'stage_not_found')] });
    await gone.controller.add('GITHUB_WORK', { totp: true });
    should(gone.said.at(-1)).equal('Timed out: nothing was saved. Run it again to save the key.');

    const waiting = rig({ views: [view('waiting')] });
    await waiting.controller.add('GITHUB_WORK', { totp: true });
    should(waiting.said.at(-1)).startWith('Still waiting: nothing is saved until you confirm it');
    should(waiting.sleeps.length).be.greaterThan(TWO_FACTOR_STAGE_TTL_SECONDS - 1);
  });

  it('should let any other failure while waiting through', async () => {
    const { controller } = rig({ views: [new FyHttpError('server broke', 500, undefined)] });
    should(await rejection(() => controller.add('GITHUB_WORK', { totp: true }))).equal('server broke');
  });

  it('should print the amount of time the owner has to confirm', async () => {
    const { controller, said } = rig();
    await controller.add('GITHUB_WORK', { totp: true });
    should(said[1]).containEql(`waiting up to ${String(TWO_FACTOR_STAGE_TTL_SECONDS / 60)} minutes`);
  });
});

describe('TwoFactorSeedController add refusals', () => {
  it('should refuse a handle that is not one, and a run that does not say --totp, before reading anything', async () => {
    const { controller, calls } = rig();
    should(await rejection(() => controller.add('lower', { totp: true }))).containEql('not a usable account handle');
    should(await rejection(() => controller.add('GITHUB_WORK', {}))).containEql('name the kind of 2FA key: --totp');
    should(calls).eql([]);
  });

  it('should refuse a bad label before reading anything', async () => {
    const { controller, calls } = rig();
    should(await rejection(() => controller.add('GITHUB_WORK', { totp: true, label: ' ' }))).containEql(
      '--label must be one line',
    );
    should(calls).eql([]);
  });

  it('should refuse a caller who may not read accounts before the warning or the prompt', async () => {
    const { controller, said, asked, askedHidden } = rig({
      accountsFail: new FyHttpError('owner only', 403, 'owner_only'),
    });
    const message = await rejection(() => controller.add('GITHUB_WORK', { totp: true }));
    should(message).containEql("this is the owner's command").and.containEql('(owner only)');
    should([said, asked, askedHidden]).eql([[], [], []]);
  });

  it('should refuse a store it cannot read and an account that does not exist', async () => {
    const damaged = rig({ list: DAMAGED });
    should(await rejection(() => damaged.controller.add('GITHUB_WORK', { totp: true }))).containEql('NOT gone');
    const noDiagnosis = rig({ list: { ...DAMAGED, diagnosis: undefined as never } });
    should(await rejection(() => noDiagnosis.controller.add('GITHUB_WORK', { totp: true }))).containEql(
      'no diagnosis was given',
    );
    const missing = rig();
    should(await rejection(() => missing.controller.add('NOPE', { totp: true }))).equal(
      'no account NOPE (see `account ls`)',
    );
    for (const made of [damaged, noDiagnosis, missing]) should(made.asked).eql([]);
  });

  it('should refuse away from a terminal, before staging anything', async () => {
    const { controller, calls } = rig({ interactive: false });
    should(await rejection(() => controller.add('GITHUB_WORK', { totp: true }))).containEql(
      'this needs a terminal you are sitting at',
    );
    should(calls.map(call => call[0])).eql(['list']);
  });

  it('should stage nothing when the owner does not type yes', async () => {
    const { controller, calls, askedHidden } = rig({ typed: ['no'] });
    should(await rejection(() => controller.add('GITHUB_WORK', { totp: true }))).equal(
      'no 2FA key was staged: nothing was changed',
    );
    should(askedHidden).eql([]);
    should(calls.map(call => call[0])).eql(['list']);
  });

  it('should refuse a key that is too long or is not a key, without staging it', async () => {
    const long = rig({ hidden: ['A'.repeat(1_025)] });
    should(await rejection(() => long.controller.add('GITHUB_WORK', { totp: true }))).equal(
      'that is too long to be a 2FA key',
    );
    const notAKey = rig({ hidden: ['not a key!'] });
    should(await rejection(() => notAKey.controller.add('GITHUB_WORK', { totp: true }))).equal(
      TOTP_INPUT_PROBLEMS.notAKey,
    );
    for (const made of [long, notAKey]) should(made.calls.map(call => call[0])).not.containEql('stage');
  });
});

describe('TwoFactorSeedController a key for another account', () => {
  const mismatch = () =>
    new FyHttpError(
      'That key says it is for kirin@example.com, not this account.',
      409,
      TWO_FACTOR_ERROR_CODES.mismatch,
    );

  it("should show the daemon's warning and, on yes, stage again with the second tick", async () => {
    const { controller, calls, said, asked } = rig({ typed: ['yes', 'YES'], stages: [mismatch(), STAGED] });
    await controller.add('GITHUB_WORK', { totp: true });
    should(said).containEql('That key says it is for kirin@example.com, not this account.');
    should(asked.at(-1)).equal('Save it to this account anyway? Type yes: ');
    const staged = calls.filter(call => call[0] === 'stage');
    should(staged).have.length(2);
    should(staged[0]?.[2]).not.have.property('mismatchAcknowledged');
    should(staged[1]?.[2]).have.property('mismatchAcknowledged', true);
    should(said.at(-1)).startWith('Saved:');
  });

  it('should stage nothing when the owner does not say yes to it', async () => {
    const { controller, calls } = rig({ typed: ['yes', 'no'], stages: [mismatch()] });
    should(await rejection(() => controller.add('GITHUB_WORK', { totp: true }))).equal(
      'no 2FA key was staged: nothing was changed',
    );
    should(calls.filter(call => call[0] === 'stage')).have.length(1);
  });

  it("should put a refusal of the second stage in the owner's words", async () => {
    const { controller } = rig({
      typed: ['yes', 'yes'],
      stages: [mismatch(), new FyHttpError('owner only', 403, 'owner_only')],
    });
    should(await rejection(() => controller.add('GITHUB_WORK', { totp: true }))).containEql(
      "this is the owner's command",
    );
  });
});

describe('TwoFactorSeedController a refused stage', () => {
  it('should say a daemon refusal as its message alone, and let any other failure through', async () => {
    const refused = rig({
      stages: [new FyHttpError('too many keys are staged', 429, TWO_FACTOR_ERROR_CODES.tooManyStages)],
    });
    should(await rejection(() => refused.controller.add('GITHUB_WORK', { totp: true }))).equal(
      'too many keys are staged',
    );
    const plain = rig({ stages: [new Error('offline')] });
    should(await rejection(() => plain.controller.add('GITHUB_WORK', { totp: true }))).equal('offline');
  });

  it("should say a ferret's credential was refused in the owner's words", async () => {
    const { controller } = rig({ stages: [new FyHttpError('owner only', 403, 'owner_only')] });
    const message = await rejection(() => controller.add('GITHUB_WORK', { totp: true }));
    should(message).containEql("this is the owner's command").and.containEql('(owner only)');
  });
});
