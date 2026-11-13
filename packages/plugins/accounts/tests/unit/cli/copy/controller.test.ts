import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import should from 'should';
import {
  type CopyMeta,
  PASTE_RULES_SCREEN_PATH,
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleList,
  type PasteRuleSettings,
  type PasteRuleSettingsView,
  type PasteRuleStaged,
  type PasteRuleStageView,
  RUNS_WHAT_IT_READS_WARNING,
} from '../../../../contract/routes/index.ts';
import {
  CopyController,
  PROFILE_TARGETS_NEEDS_PASSKEY,
  PROFILE_TARGETS_WARNING,
  parseFrom,
  parseTo,
} from '../../../../cli/lib/copy/controller.ts';
import type { CopyPorts, ICopyGateway } from '../../../../cli/lib/copy/ports.ts';
import { OWNER_COMMAND_REFUSAL, parseLifetime } from '../../../../cli/lib/shared.ts';
import { FyHttpError } from '../../../../cli/shell.ts';

const RULE: PasteRule = {
  id: 'a1b2c3d4'.padEnd(32, '0'),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  remaining: 2,
  used: 1,
  createdAt: '2026-10-31T12:00:00.000Z',
  createdBy: { kind: 'host' },
};

const COPY: CopyMeta = {
  handle: 'sealed:vercel',
  name: 'vercel',
  from: { kind: 'command', program: 'vercel' },
  length: 24,
  lines: 1,
  capturedAt: '2026-10-31T12:00:00.000Z',
  expiresAt: '2026-10-31T13:00:00.000Z',
  state: 'live',
  exposure: { transcript: 'found' },
  uses: 0,
};

class FakeGateway implements ICopyGateway {
  readonly removed: string[] = [];
  readonly changed: PasteRuleSettings[] = [];
  /** What the settings write answers: the settings as given, unless a test says the daemon refused. */
  refuseSettings: unknown;
  async copies(): Promise<readonly CopyMeta[]> {
    return [COPY];
  }
  async rules(): Promise<PasteRuleList> {
    return { rules: [RULE] };
  }
  /** A daemon with no settings to give answers 404: the fake does, unless a test says otherwise. */
  async ruleSettings(): Promise<PasteRuleSettingsView> {
    throw new FyHttpError('not found', 404, 'not_found');
  }
  async changeRuleSettings(settings: PasteRuleSettings): Promise<PasteRuleSettings> {
    this.changed.push(settings);
    if (this.refuseSettings !== undefined) throw this.refuseSettings;
    return settings;
  }
  async removeRule(id: string): Promise<void> {
    this.removed.push(id);
  }
  readonly staged: PasteRuleCreate[] = [];
  /** The states the stage reads as, one per poll; the last repeats. */
  states: PasteRuleStageView['state'][] = ['approved'];
  async stageRule(rule: PasteRuleCreate): Promise<PasteRuleStaged> {
    this.staged.push(rule);
    return STAGED;
  }
  profileStaged = 0;
  async stageProfileTargets(): Promise<PasteRuleStaged> {
    this.profileStaged += 1;
    return PROFILE_STAGED;
  }
  async ruleStage(): Promise<PasteRuleStageView> {
    const state =
      this.states.length > 1 ? (this.states.shift() as PasteRuleStageView['state']) : (this.states[0] ?? 'waiting');
    return { ...STAGED, state, ...(state === 'approved' ? { rule: RULE.id } : {}) };
  }
}

const STAGED: PasteRuleStaged = {
  stage: `prs_${'1'.repeat(24)}`,
  kind: 'rule',
  does: 'Ferretry pastes what gh prints into bash in a terminal, for any ferret on this machine, without asking.',
  rows: [
    { label: 'From', value: 'what gh prints' },
    { label: 'To', value: 'bash in a terminal' },
    { label: 'Who', value: 'Any ferret on this machine' },
    { label: 'Pastes', value: 'Any number' },
    { label: 'Until', value: 'No end: until you remove it' },
  ],
  runsAnything: true,
  expiresAt: '2026-10-31T12:02:00.000Z',
};

const PROFILE_STAGED: PasteRuleStaged = {
  stage: `prs_${'2'.repeat(24)}`,
  kind: 'profile-targets',
  does: 'Paste rules may then paste into programs from your own profile (~/.nix-profile), which any ferret can swap; it widens one paste rule now.',
  rows: [
    { label: 'Widens', value: 'what gh prints → vercel in a terminal' },
    { label: 'Staged', value: 'At this machine, 2026-10-31 12:00 UTC' },
  ],
  runsAnything: false,
  expiresAt: '2026-10-31T12:02:00.000Z',
};

function rig(overrides: Partial<CopyPorts> = {}) {
  const gateway = new FakeGateway();
  const said: string[] = [];
  const warned: string[] = [];
  const controller = new CopyController({
    gateway,
    out: { success: message => void said.push(message), diagnostic: message => void warned.push(message) },
    ownSessionId: undefined,
    agentCredential: undefined,
    sleep: async () => undefined,
    nowMs: () => 0,
    ...overrides,
  });
  return { gateway, said, warned, controller };
}

const failure = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'no error',
    (error: Error) => error.message,
  );

describe('fy copy rules profile', () => {
  it('should turn programs in your own profile off in one step, without a warning', async () => {
    const off = rig();
    await off.controller.profile(' OFF ', { json: true });

    should(off.gateway.changed).eql([{ allowProfileTargets: false }]);
    should(JSON.parse(off.said[0] as string)).eql({ allowProfileTargets: false });
    should(off.warned).eql([]);
  });

  it('should send nothing for a word that is not on or off', async () => {
    const { controller, gateway } = rig();

    should(await failure(controller.profile('yes', {}))).equal('say on or off, not "yes"');
    should(gateway.changed).eql([]);
  });

  it('should point to the app when the daemon wants a passkey, and pass any other failure on', async () => {
    const stepUp = rig();
    stepUp.gateway.refuseSettings = new FyHttpError('needs a passkey', 403, STEP_UP_REQUIRED_CODE);

    should(await failure(stepUp.controller.profile('off', {}))).equal(PROFILE_TARGETS_NEEDS_PASSKEY);
    should(PROFILE_TARGETS_NEEDS_PASSKEY).containEql('Settings › Secure copy › Pastes approved in advance');
    should(stepUp.warned).eql([]);
    const down = rig();
    down.gateway.refuseSettings = new Error('the daemon went away');
    should(await failure(down.controller.profile('off', {}))).equal('the daemon went away');
  });

  it('should refuse inside a ferret pane in the one neutral sentence, before any call', async () => {
    const { controller, gateway } = rig({ ownSessionId: 's1' });

    should(await failure(controller.profile('off', {}))).equal(OWNER_COMMAND_REFUSAL);
    should(gateway.changed).eql([]);
  });
});

describe('fy copy', () => {
  it('should refuse every command inside a ferret, before it calls the daemon', async () => {
    const inPane = rig({ ownSessionId: 's1' });
    const withCredential = rig({ agentCredential: 'cap' });

    const refusals = await Promise.all([
      failure(inPane.controller.rules({})),
      failure(inPane.controller.addRule({ from: 'command:gh', to: 'terminal:vercel' })),
      failure(withCredential.controller.removeRule('a1b2', {})),
      failure(withCredential.controller.list({ session: 's1' })),
    ]);

    should(new Set(refusals)).eql(new Set([OWNER_COMMAND_REFUSAL]));
    should(OWNER_COMMAND_REFUSAL).equal("this is the owner's command; a ferret's pane can't run it");
    should(OWNER_COMMAND_REFUSAL).not.containEql('pastes');
    should([inPane.gateway.staged, withCredential.gateway.removed]).eql([[], []]);
  });

  it('should stage a rule from the routes written as kind:value, with its count and expiry', async () => {
    const { controller, gateway, said } = rig();

    await controller.addRule({ from: 'command:gh', to: 'terminal:vercel', count: '2', expires: '2h', session: 's1' });

    should(gateway.staged).eql([
      {
        from: { kind: 'command', program: 'gh' },
        to: { kind: 'terminal', program: 'vercel' },
        sessionId: 's1',
        count: 2,
        expiresInSeconds: 7200,
      },
    ]);
    should(said.at(-1)).startWith('Approved with your passkey: the paste rule a1b2c3d4');
  });

  it('should refuse a rule with no route, or a count that is not a whole number', async () => {
    const { controller, gateway } = rig();

    should(await failure(controller.addRule({ from: 'command:gh' }))).containEql('needs --from and --to');
    should(await failure(controller.addRule({ from: 'command:gh', to: 'terminal:vercel', count: '1.5' }))).containEql(
      '--count',
    );
    should(gateway.staged).eql([]);
  });

  it('should read routes and times, and refuse what is not one', () => {
    should(parseFrom('browser:https://github.com')).eql({ kind: 'browser', origin: 'https://github.com' });
    should(parseFrom('clipboard:https://x.dev:8443')).eql({ kind: 'clipboard', origin: 'https://x.dev:8443' });
    should(parseTo('secret:VERCEL_TOKEN')).eql({ kind: 'secret', name: 'VERCEL_TOKEN' });
    should(parseTo('browser:https://vercel.com')).eql({ kind: 'browser', origin: 'https://vercel.com' });
    should(() => parseFrom('shell:gh')).throw(/--from "shell:gh"/u);
    should(() => parseTo('terminal:/bin/sh')).throw(/--to/u);
    should([parseLifetime('90'), parseLifetime('30m'), parseLifetime('7d')]).eql([90, 1800, 604_800]);
    should(() => parseLifetime('soon')).throw(/--expires/u);
  });

  it('should list and remove rules by the start of their id', async () => {
    const { controller, gateway, said } = rig();

    await controller.rules({});
    await controller.removeRule('a1b2', {});

    should(said[0]).equal('a1b2c3d4  command:gh → terminal:vercel  any session  2 left  no expiry  used 1');
    should(gateway.removed).eql([RULE.id]);
    should(await failure(controller.removeRule('zzz', {}))).equal('no rule starts with "zzz"');
  });

  it('should say whether profile programs are allowed, and mark a rule one could satisfy', async () => {
    const { controller, gateway, said } = rig();
    gateway.ruleSettings = async () => ({ settings: { allowProfileTargets: false }, profileRules: [RULE.id] });

    await controller.rules({});

    should(said[0]).equal(
      [
        'programs in your own profile: not allowed (they ask you)',
        'a1b2c3d4  command:gh → terminal:vercel  any session  2 left  no expiry  used 1  [your profile — a ferret could swap this program]',
      ].join('\n'),
    );
    gateway.rules = async () => ({ rules: [] });
    gateway.ruleSettings = async () => ({ settings: { allowProfileTargets: true }, profileRules: [] });
    await controller.rules({});
    should(said[1]).equal('programs in your own profile: allowed\nno paste rules: every paste asks you');
  });

  it('should warn when the setting cannot be read for any reason but an older daemon, and still list', async () => {
    const warned: string[] = [];
    const said: string[] = [];
    const { controller, gateway } = rig({
      out: { success: message => void said.push(message), diagnostic: message => void warned.push(message) },
    });
    gateway.ruleSettings = async () => {
      throw new FyHttpError('the daemon fell over', 500, 'internal');
    };

    await controller.rules({});

    should(warned).eql([
      'warning: could not check which rules a program in your own profile could satisfy, so none is marked: the daemon fell over',
    ]);
    should(said[0]).startWith('a1b2c3d4  command:gh → terminal:vercel');
    gateway.ruleSettings = async () => {
      throw new FyHttpError('not found', 404, 'not_found');
    };
    await controller.rules({});
    should(warned).have.length(1);
  });

  it('should say nothing of the setting when the daemon gives none, and mark a rule into a shell', async () => {
    const { controller, gateway, said } = rig();
    gateway.rules = async () => ({ rules: [{ ...RULE, to: { kind: 'terminal', program: 'bash' } }] });

    await controller.rules({});

    should(said[0]).equal(
      'a1b2c3d4  command:gh → terminal:bash  any session  2 left  no expiry  used 1  [runs whatever it reads]',
    );
  });

  it('should list copies with no value', async () => {
    const { controller, said } = rig();

    await controller.list({ session: 's1' });

    should(said[0]).equal(
      'sealed:vercel  live  24 chars from vercel  until 2026-10-31T13:00:00.000Z  pasted 0  [seen by the ferret before it was sealed]',
    );
    should(await failure(controller.list({}))).containEql('--session');
  });

  it('should list a copy by the file that printed it when the daemon found one', async () => {
    const { controller, said, gateway } = rig();
    gateway.copies = async () => [{ ...COPY, from: { ...COPY.from, path: '/home/k/.bun/bin/vercel' } }];

    await controller.list({ session: 's1' });

    should(said[0]).startWith('sealed:vercel  live  24 chars from /home/k/.bun/bin/vercel  until');
  });

  it('should spell out a character in a path that could draw something else on the screen', async () => {
    const { controller, said, gateway } = rig();
    gateway.copies = async () => [{ ...COPY, from: { ...COPY.from, path: '/tmp/\u202eevil' } }];

    await controller.list({ session: 's1' });

    should(said[0]).not.containEql('\u202e');
  });
});

describe('fy copy --json and empty listings', () => {
  it('should print each payload as JSON when asked', async () => {
    const { controller, said } = rig();

    await controller.list({ session: 's1', json: true });
    await controller.rules({ json: true });
    await controller.addRule({ from: 'command:gh', to: 'terminal:vercel', json: true });
    await controller.removeRule('a1b2', { json: true });

    should(said.map(line => Object.keys(JSON.parse(line) as object)[0])).eql(['copies', 'rules', 'stage', 'removed']);
  });

  it('should say plainly when there is nothing to list', async () => {
    const gateway = new FakeGateway();
    gateway.copies = async () => [];
    gateway.rules = async () => ({ rules: [] });
    const said: string[] = [];
    const controller = new CopyController({
      gateway,
      out: { success: message => void said.push(message), diagnostic: () => undefined },
      ownSessionId: undefined,
      agentCredential: undefined,
      sleep: async () => undefined,
      nowMs: () => 0,
    });

    await controller.list({ session: 's1' });
    await controller.rules({});

    should(said).eql(['s1 holds no secure copies', 'no paste rules: every paste asks you']);
  });
});

describe('fy copy: the last words', () => {
  it('should write a page destination as browser:<origin>, and ask for an id when none is given', async () => {
    const gateway = new FakeGateway();
    gateway.rules = async () => ({ rules: [{ ...RULE, to: { kind: 'browser', origin: 'https://vercel.com' } }] });
    const said: string[] = [];
    const controller = new CopyController({
      gateway,
      out: { success: message => void said.push(message), diagnostic: () => undefined },
      ownSessionId: undefined,
      agentCredential: undefined,
      sleep: async () => undefined,
      nowMs: () => 0,
    });

    await controller.rules({});

    should(said[0]).containEql('command:gh → browser:https://vercel.com');
    should(await failure(controller.removeRule(' ', {}))).equal('name the rule by its id (see `copy rules ls`)');
  });
});

describe('fy copy rules add: a passkey bound to that one rule (!A244)', () => {
  it("should stage the rule, show the daemon's rows, and make nothing itself", async () => {
    const { gateway, said, controller } = rig();
    gateway.states = ['waiting', 'approved'];

    await controller.addRule({ from: 'command:gh', to: 'terminal:bash' });

    should(gateway.staged).eql([
      { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'bash' } },
    ]);
    should(said).containEql(`  ${STAGED.does}`);
    should(said).containEql('  To      bash in a terminal');
    should(said).containEql(`  ${RUNS_WHAT_IT_READS_WARNING}`);
    should(said.join('\n')).containEql(`Confirm it with your passkey in the Ferretry app (${PASTE_RULES_SCREEN_PATH})`);
    should(said.at(-1)).equal(`Approved with your passkey: the paste rule ${RULE.id.slice(0, 8)} is in force.`);
  });

  it('should say a denied or timed-out stage made nothing, and answer the state as JSON', async () => {
    const denied = rig();
    denied.gateway.states = ['denied'];
    await denied.controller.addRule({ from: 'command:gh', to: 'terminal:vercel' });
    should(denied.said.at(-1)).equal('Denied. No paste rule was made.');

    let now = 0;
    const late = rig({
      nowMs: () => now,
      sleep: async ms => {
        now += ms * 1_000;
      },
    });
    late.gateway.states = ['waiting'];
    await late.controller.addRule({ from: 'command:gh', to: 'terminal:vercel', json: true });
    should(JSON.parse(late.said.at(-1) ?? '{}')).eql({ stage: STAGED.stage, state: 'expired' });
    should(late.gateway.staged).have.length(1);
  });
});

describe('fy copy rules add: the wait on a staged paste rule', () => {
  it('should read a stage the daemon no longer has as timed out, and surface any other failure', async () => {
    const gone = rig();
    gone.gateway.ruleStage = async () => {
      throw new FyHttpError('no such stage', 404, 'paste_rule_stage_not_found');
    };
    await gone.controller.addRule({ from: 'command:gh', to: 'terminal:vercel' });
    should(gone.said.at(-1)).equal('Timed out. No paste rule was made; run the command again.');

    const broken = rig();
    broken.gateway.ruleStage = async () => {
      throw new FyHttpError('the daemon fell over', 500, 'internal');
    };
    should(await failure(broken.controller.addRule({ from: 'command:gh', to: 'terminal:vercel' }))).equal(
      'the daemon fell over',
    );
  });
});

describe('fy copy rules profile on: staged with a passkey bound to what it widens (secrev-1334 M2)', () => {
  it('should stage turning it on, show the rules it widens, and change nothing itself', async () => {
    const { gateway, said, warned, controller } = rig();
    gateway.states = ['waiting', 'approved'];

    await controller.profile('on', {});

    should(gateway.profileStaged).equal(1);
    should(gateway.changed).eql([]);
    should(said).containEql('  Widens  what gh prints → vercel in a terminal');
    should(said.join('\n')).containEql(`Confirm it with your passkey in the Ferretry app (${PASTE_RULES_SCREEN_PATH})`);
    should(said.at(-1)).equal('Approved with your passkey. programs in your own profile: allowed');
    should(warned).eql([`warning: ${PROFILE_TARGETS_WARNING}`]);
  });

  it('should say a denied or timed-out stage left it off, and still turn it off in one step', async () => {
    const denied = rig();
    denied.gateway.states = ['denied'];
    await denied.controller.profile('on', {});
    should(denied.said.at(-1)).equal('Denied. programs in your own profile: not allowed (they ask you)');

    let now = 0;
    const late = rig({
      nowMs: () => now,
      sleep: async ms => {
        now += ms * 1_000;
      },
    });
    late.gateway.states = ['waiting'];
    await late.controller.profile('on', {});
    should(late.said.at(-1)).equal(
      'Timed out. programs in your own profile: not allowed (they ask you); run the command again.',
    );

    const off = rig();
    await off.controller.profile('off', {});
    should(off.gateway.changed).eql([{ allowProfileTargets: false }]);
    should(off.gateway.profileStaged).equal(0);
  });
});
