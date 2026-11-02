import { describe, it } from 'bun:test';
import {
  type ConfirmTwoFactorSeedRequest,
  DAEMON_FEATURES,
  LOGIN_TOTP_WARNING,
  type StageTwoFactorSeedRequest,
  type TwoFactorSeedConfirming,
  type TwoFactorSeedStaged,
  type TwoFactorSeedStageView,
  unpadInputValue,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { Command } from 'commander';
import should from 'should';
import { registerAccountCommands } from '../../../src/lib/secrets/account-commands';
import { AccountController } from '../../../src/lib/secrets/account-controller';
import type { IAccountGateway, IAccountPrompt } from '../../../src/lib/secrets/account-ports';
import { FactorKeyController } from '../../../src/lib/secrets/factor-keys-controller';
import { SignInController } from '../../../src/lib/secrets/sign-in-controller';
import { TwoFactorSeedController } from '../../../src/lib/secrets/factor-controller';
import type { ITwoFactorSeedGateway } from '../../../src/lib/secrets/factor-gateway';
import { OLD_DAEMON_MESSAGE, OWNER_ONLY_MESSAGE } from '../../../src/lib/secrets/account-gateway';
import { FakeAccountGateway, LIST } from './account-rig';

/**
 * `fy account factor add --totp` (docs/secrets.md, "2FA keys"): the key is typed at a hidden prompt, STAGED, and put
 * on the owner's agenda; the CLI then waits while the owner confirms it with a passkey in the app. It has no way to
 * save a seed itself, and it never prints one.
 */

const SEED = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/GitHub:kirinnee?secret=${SEED}&issuer=GitHub`;
const STAGE = `st_${'a'.repeat(24)}`;

class FakePrompt implements IAccountPrompt {
  readonly asked: string[] = [];
  readonly hidden: string[] = [];
  constructor(
    private readonly hiddenAnswers: string[],
    private readonly answers: string[] = ['yes'],
  ) {}
  async ask(message: string): Promise<string> {
    this.asked.push(message);
    return this.answers.shift() ?? '';
  }
  async askHidden(message: string): Promise<string> {
    this.hidden.push(message);
    return this.hiddenAnswers.shift() ?? '';
  }
}

class FakeSeeds implements ITwoFactorSeedGateway {
  readonly calls: string[] = [];
  /** What the daemon's health reports: 2FA keys unless a test says the daemon is older. */
  reported: readonly string[] = [DAEMON_FEATURES.twoFactorKeys];
  featureReads = 0;
  readonly staged: StageTwoFactorSeedRequest[] = [];
  readonly confirms: ConfirmTwoFactorSeedRequest[] = [];
  constructor(
    private readonly states: TwoFactorSeedStageView['state'][] = ['waiting', 'saved'],
    private readonly mismatchFirst = false,
    readonly failures: { stage?: unknown[]; view?: unknown } = {},
  ) {}
  async stage(account: string, body: StageTwoFactorSeedRequest): Promise<TwoFactorSeedStaged> {
    this.calls.push(`stage ${account}`);
    this.staged.push(body);
    const failure = this.failures.stage?.shift();
    if (failure !== undefined) throw failure;
    if (this.mismatchFirst && body.mismatchAcknowledged !== true)
      throw new FyHttpError(
        "This key says it is for Okta · bob@x.com, but you're saving it to GitHub · kirinnee.",
        409,
        'factor_mismatch',
      );
    return {
      stage: STAGE,
      account,
      label: 'Authenticator app',
      expiresAt: '2026-01-01T00:02:00.000Z',
      parsed: { params: { algorithm: 'SHA1', digits: 6, period: 30 }, issuer: 'GitHub' },
    };
  }
  async confirmInApp(
    account: string,
    stage: string,
    body: ConfirmTwoFactorSeedRequest,
  ): Promise<TwoFactorSeedConfirming> {
    this.calls.push(`confirm ${account} ${stage}`);
    this.confirms.push(body);
    return { stage: STAGE, session: body.session, agendaItemId: 'A7' };
  }
  async features(): Promise<readonly string[]> {
    this.featureReads += 1;
    return this.reported;
  }
  async view(account: string, stage: string): Promise<TwoFactorSeedStageView> {
    this.calls.push(`view ${account} ${stage}`);
    if (this.failures.view !== undefined) throw this.failures.view;
    const state = this.states.length > 1 ? (this.states.shift() as TwoFactorSeedStageView['state']) : this.states[0];
    return {
      stage: STAGE,
      account,
      label: 'Authenticator app',
      state: state ?? 'waiting',
      expiresAt: '2026-01-01T00:02:00.000Z',
    };
  }
}

function rig(
  options: {
    seeds?: FakeSeeds;
    prompt?: FakePrompt;
    session?: string;
    interactive?: boolean;
    accounts?: FakeAccountGateway;
    appOrigin?: string;
  } = {},
) {
  const seeds = options.seeds ?? new FakeSeeds();
  const accounts = options.accounts ?? new FakeAccountGateway();
  const prompt = options.prompt ?? new FakePrompt([URI]);
  const messages: string[] = [];
  let now = 0;
  const controller = new TwoFactorSeedController({
    gateway: seeds,
    accounts,
    out: { success: message => void messages.push(message) },
    prompt,
    interactive: options.interactive ?? true,
    ownSessionId: options.session,
    sleep: async ms => {
      now += ms;
    },
    nowMs: () => now,
    ...(options.appOrigin === undefined ? {} : { appOrigin: options.appOrigin }),
  });
  return { controller, seeds, prompt, messages, accounts };
}

const fails = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('fy account factor add --totp', () => {
  it('should warn, stage the key padded, put it on the agenda, and wait for the owner’s passkey', async () => {
    // Arrange
    const { controller, seeds, prompt, messages } = rig({ session: 'lead-1' });

    // Act
    await controller.add('GITHUB', { totp: true });

    // Assert — staged once, confirmed on the board, watched until saved; never a commit
    should(messages[0]).containEql(LOGIN_TOTP_WARNING);
    should(prompt.hidden).have.length(1);
    should(unpadInputValue(seeds.staged[0]?.padded ?? '')).equal(URI);
    should(seeds.staged[0]?.totpAcknowledged).equal(true);
    should(seeds.confirms).deepEqual([{ session: 'lead-1' }]);
    should(seeds.calls.filter(call => call.startsWith('view'))).have.length(2);
    should(seeds.calls.some(call => call.includes('commit'))).be.false();
    should(messages.join('\n')).containEql('!A7');
    should(messages.at(-1)).containEql('Saved');
    should(messages.join('\n')).not.containEql(SEED);
  });

  it('should say Denied and Timed out as the daemon saw them', async () => {
    // Arrange
    const denied = rig({ session: 's', seeds: new FakeSeeds(['dropped']) });
    const late = rig({ session: 's', seeds: new FakeSeeds(['waiting']) });

    // Act
    await denied.controller.add('GITHUB', { totp: true });
    await late.controller.add('GITHUB', { totp: true });

    // Assert
    should(denied.messages.at(-1)).containEql('Denied');
    should(late.messages.at(-1)).containEql('Still waiting');
  });

  it('should ask again on a key for another account, and stage it with the second tick only on yes', async () => {
    // Arrange
    const { controller, seeds, prompt } = rig({
      session: 's',
      seeds: new FakeSeeds(['saved'], true),
      prompt: new FakePrompt([URI], ['yes', 'yes']),
    });

    // Act
    await controller.add('GITHUB', { totp: true });

    // Assert
    should(prompt.asked[1]).containEql('anyway');
    should(seeds.staged.map(body => body.mismatchAcknowledged)).deepEqual([undefined, true]);
  });

  it('should refuse, before asking for the key, without --totp, a board, a terminal or the typed yes', async () => {
    // Arrange + Act
    const noKind = await fails(() => rig({ session: 's' }).controller.add('GITHUB', {}));
    const noBoard = await fails(() => rig().controller.add('GITHUB', { totp: true }));
    const piped = rig({ session: 's', interactive: false });
    const noTerminal = await fails(() => piped.controller.add('GITHUB', { totp: true }));
    const declined = rig({ session: 's', prompt: new FakePrompt([URI], ['no']) });
    const no = await fails(() => declined.controller.add('GITHUB', { totp: true }));

    // Assert
    should(noKind).containEql('--totp');
    should(noBoard).containEql('--session');
    should(noBoard).containEql("the app's Inbox");
    should(noTerminal).containEql('terminal');
    should(no).containEql('nothing was changed');
    for (const prompt of [piped.prompt, declined.prompt]) should(prompt.hidden).have.length(0);
    should(declined.seeds.calls).deepEqual([]);
  });

  it('should refuse a paste that is not a key without repeating it, and send nothing', async () => {
    // Arrange
    const bad = 'not-a-key-UNIQUE!';
    const { controller, seeds } = rig({ session: 's', prompt: new FakePrompt([bad]) });

    // Act
    const message = await fails(() => controller.add('GITHUB', { totp: true }));

    // Assert
    should(message).not.containEql(bad);
    should(seeds.calls).deepEqual([]);
  });

  it('should take no value flag on the command line', async () => {
    // Arrange
    const root = new Command().name('fy').exitOverride();
    root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const { controller } = rig({ session: 's' });
    const ports = {
      gateway: {} as IAccountGateway,
      out: { success: () => {} },
      prompt: new FakePrompt([]),
      interactive: true,
      readRecipe: async () => '',
    };
    registerAccountCommands(root, {
      accounts: new AccountController(ports),
      signIns: new SignInController(ports),
      factorKeys: new FactorKeyController(ports),
      seeds: controller,
    });
    const add = root.commands
      .find(command => command.name() === 'account')
      ?.commands.find(command => command.name() === 'factor')
      ?.commands.find(command => command.name() === 'add');

    // Act
    const takesValue = (add?.options ?? []).filter(option => option.required || option.optional).map(o => o.long);

    // Assert
    should(add).not.be.undefined();
    should(takesValue.sort()).deepEqual(['--app', '--ends-with', '--label', '--session', '--to']);
  });
});

describe('fy account factor add --totp, before anything is typed', () => {
  const http = (status: number, code?: string) => new FyHttpError('the daemon says no', status, code);

  it('should read the person-only account list first, so a refused caller never sees the warning or the prompt', async () => {
    // Arrange
    const accounts = new FakeAccountGateway();
    accounts.failures.set('list', http(403, 'owner_only'));
    const { controller, prompt, seeds, messages } = rig({ session: 's', accounts });

    // Act
    const message = await fails(() => controller.add('GITHUB', { totp: true }));

    // Assert
    should(message).containEql(OWNER_ONLY_MESSAGE);
    should(accounts.ops()).deepEqual(['list']);
    should(messages).deepEqual([]);
    should(prompt.asked).deepEqual([]);
    should(prompt.hidden).deepEqual([]);
    should(seeds.calls).deepEqual([]);
  });

  it('should say the daemon needs an update for 2FA keys when it lists accounts but has no 2FA key routes', async () => {
    // Arrange — v4.190 to v4.196: /v1/accounts answers, /factors does not exist yet
    const seeds = new FakeSeeds();
    seeds.reported = [DAEMON_FEATURES.accountsSignIns];
    const accounts = new FakeAccountGateway();
    const { controller, prompt } = rig({ session: 's', seeds, accounts });

    // Act
    const message = await fails(() => controller.add('GITHUB', { totp: true }));

    // Assert — said before anything is read, warned or typed, and never the "older than accounts" sentence
    should(message).equal(
      "this machine's daemon is too old for 2FA keys: update it (fy daemon update), then run this again. Nothing was changed",
    );
    should(message).not.equal(OLD_DAEMON_MESSAGE);
    should(prompt.asked).deepEqual([]);
    should(prompt.hidden).deepEqual([]);
    should(seeds.calls).deepEqual([]);
  });

  it("should point to the card in the app's Inbox, and print its link when the app address is known", async () => {
    // Arrange
    const linked = rig({ session: 'lead-1', appOrigin: 'https://app.example/' });
    const unlinked = rig({ session: 'lead-1' });

    // Act
    await linked.controller.add('GITHUB', { totp: true });
    await unlinked.controller.add('GITHUB', { totp: true });

    // Assert
    should(linked.messages).containEql('Open the card: https://app.example/#agenda/A7?session=lead-1');
    should(linked.messages.join('\n')).containEql("on the card !A7 in the app's Inbox (session lead-1)");
    should(linked.messages.join('\n')).not.containEql('agenda of');
    should(unlinked.messages.some(message => message.startsWith('Open the card'))).be.false();
  });

  it('should name an older daemon before asking for the key', async () => {
    // Arrange
    const accounts = new FakeAccountGateway();
    accounts.failures.set('list', http(404, 'unknown_route'));
    const { controller, prompt } = rig({ session: 's', accounts });

    // Act
    const message = await fails(() => controller.add('GITHUB', { totp: true }));

    // Assert
    should(message).equal(OLD_DAEMON_MESSAGE);
    should(prompt.hidden).deepEqual([]);
  });

  it('should refuse an account that does not exist, and a store that cannot be read, before asking for the key', async () => {
    // Arrange
    const damaged = rig({
      session: 's',
      accounts: new FakeAccountGateway({ ...LIST, health: 'damaged', diagnosis: 'the seal key is gone' }),
    });
    const missing = rig({ session: 's' });

    // Act
    const damagedMessage = await fails(() => damaged.controller.add('GITHUB', { totp: true }));
    const missingMessage = await fails(() => missing.controller.add('NOPE', { totp: true }));

    // Assert
    should(damagedMessage).containEql('NOT gone');
    should(damagedMessage).containEql('the seal key is gone');
    should(missingMessage).containEql('no account NOPE');
    for (const prompt of [damaged.prompt, missing.prompt]) should(prompt.hidden).deepEqual([]);
  });
});

describe('fy account factor add --totp, when things go wrong', () => {
  const http = (status: number, code?: string) => new FyHttpError('the daemon says no', status, code);

  it('should name an older daemon, carry the daemon’s own words, and pass anything else through', async () => {
    // Arrange
    const old = rig({ session: 's', seeds: new FakeSeeds([], false, { stage: [http(404, 'unknown_route')] }) });
    const refused = rig({ session: 's', seeds: new FakeSeeds([], false, { stage: [http(409, 'passkey_required')] }) });
    const broken = rig({ session: 's', seeds: new FakeSeeds([], false, { stage: [new TypeError('socket')] }) });

    // Act
    const oldMessage = await fails(() => old.controller.add('GITHUB', { totp: true }));
    const refusedMessage = await fails(() => refused.controller.add('GITHUB', { totp: true }));
    const brokenMessage = await fails(() => broken.controller.add('GITHUB', { totp: true }));

    // Assert
    should(oldMessage).containEql('fy daemon update');
    should(refusedMessage).equal('the daemon says no');
    should(brokenMessage).equal('socket');
  });

  it('should carry a refusal of the second stage after "save it here anyway"', async () => {
    // Arrange
    const mismatch = new FyHttpError('This key says it is for Okta.', 409, 'factor_mismatch');
    const { controller } = rig({
      session: 's',
      seeds: new FakeSeeds([], false, { stage: [mismatch, http(429, 'too_many_stages')] }),
      prompt: new FakePrompt([URI], ['yes', 'yes']),
    });

    // Act + Assert
    should(await fails(() => controller.add('GITHUB', { totp: true }))).equal('the daemon says no');
  });

  it('should read a stage the daemon no longer has as timed out, and pass another failure through', async () => {
    // Arrange
    const gone = rig({ session: 's', seeds: new FakeSeeds([], false, { view: http(404, 'stage_not_found') }) });
    const broken = rig({ session: 's', seeds: new FakeSeeds([], false, { view: http(500) }) });

    // Act
    await gone.controller.add('GITHUB', { totp: true });
    const message = await fails(() => broken.controller.add('GITHUB', { totp: true }));

    // Assert
    should(gone.messages.at(-1)).containEql('Timed out');
    should(message).equal('the daemon says no');
  });

  it('should take a label of one line, refuse another, and refuse a paste too long to be a key', async () => {
    // Arrange
    const labelled = rig({ session: 's' });
    const long = rig({ session: 's', prompt: new FakePrompt(['A'.repeat(1_100)]) });

    // Act
    await labelled.controller.add('GITHUB', { totp: true, label: ' Authy backup ' });
    const bad = await fails(() => rig({ session: 's' }).controller.add('GITHUB', { totp: true, label: 'a\nb' }));
    const tooLong = await fails(() => long.controller.add('GITHUB', { totp: true }));

    // Assert
    should(labelled.seeds.staged[0]?.label).equal('Authy backup');
    should(bad).containEql('--label');
    should(tooLong).containEql('too long');
    should(long.seeds.calls).deepEqual([]);
  });

  it('should run from the command line: fy account factor add <id> --totp', async () => {
    // Arrange
    const root = new Command().name('fy').exitOverride();
    root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const { controller, seeds } = rig({ session: 'lead-1' });
    const ports = {
      gateway: {} as IAccountGateway,
      out: { success: () => {} },
      prompt: new FakePrompt([]),
      interactive: true,
      readRecipe: async () => '',
    };
    registerAccountCommands(root, {
      accounts: new AccountController(ports),
      signIns: new SignInController(ports),
      factorKeys: new FactorKeyController(ports),
      seeds: controller,
    });

    // Act
    await root.parseAsync(['node', 'fy', 'account', 'factor', 'add', 'GITHUB', '--totp', '--i-understand-totp']);

    // Assert
    should(seeds.calls[0]).equal('stage GITHUB');
  });
});
