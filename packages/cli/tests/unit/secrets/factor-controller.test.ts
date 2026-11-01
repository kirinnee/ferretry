import { describe, it } from 'bun:test';
import {
  type ConfirmTwoFactorSeedRequest,
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
import { registerAccountCommands } from '../../../src/lib/secrets/entry-commands';
import { LoginEntryController } from '../../../src/lib/secrets/entry-controller';
import type { ILoginEntryGateway, ILoginEntryPrompt } from '../../../src/lib/secrets/entry-ports';
import { TwoFactorSeedController } from '../../../src/lib/secrets/factor-controller';
import type { ITwoFactorSeedGateway } from '../../../src/lib/secrets/factor-gateway';

/**
 * `fy account factor add --totp` (docs/secrets.md, "2FA keys"): the key is typed at a hidden prompt, STAGED, and put
 * on the owner's agenda; the CLI then waits while the owner confirms it with a passkey in the app. It has no way to
 * save a seed itself, and it never prints one.
 */

const SEED = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/GitHub:kirinnee?secret=${SEED}&issuer=GitHub`;
const STAGE = `st_${'a'.repeat(24)}`;

class FakePrompt implements ILoginEntryPrompt {
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
  readonly staged: StageTwoFactorSeedRequest[] = [];
  readonly confirms: ConfirmTwoFactorSeedRequest[] = [];
  constructor(
    private readonly states: TwoFactorSeedStageView['state'][] = ['waiting', 'saved'],
    private readonly mismatchFirst = false,
  ) {}
  async stage(account: string, body: StageTwoFactorSeedRequest): Promise<TwoFactorSeedStaged> {
    this.calls.push(`stage ${account}`);
    this.staged.push(body);
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
  async view(account: string, stage: string): Promise<TwoFactorSeedStageView> {
    this.calls.push(`view ${account} ${stage}`);
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

function rig(options: { seeds?: FakeSeeds; prompt?: FakePrompt; session?: string; interactive?: boolean } = {}) {
  const seeds = options.seeds ?? new FakeSeeds();
  const prompt = options.prompt ?? new FakePrompt([URI]);
  const messages: string[] = [];
  let now = 0;
  const controller = new TwoFactorSeedController({
    gateway: seeds,
    out: { success: message => void messages.push(message) },
    prompt,
    interactive: options.interactive ?? true,
    ownSessionId: options.session,
    sleep: async ms => {
      now += ms;
    },
    nowMs: () => now,
  });
  return { controller, seeds, prompt, messages };
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
    registerAccountCommands(
      root,
      new LoginEntryController({
        gateway: {} as ILoginEntryGateway,
        out: { success: () => {} },
        prompt: new FakePrompt([]),
        interactive: true,
        readRecipe: async () => '',
      }),
      controller,
    );
    const add = root.commands
      .find(command => command.name() === 'account')
      ?.commands.find(command => command.name() === 'factor')
      ?.commands.find(command => command.name() === 'add');

    // Act
    const takesValue = (add?.options ?? []).filter(option => option.required || option.optional).map(o => o.long);

    // Assert
    should(add).not.be.undefined();
    should(takesValue.sort()).deepEqual(['--label', '--session']);
  });
});
