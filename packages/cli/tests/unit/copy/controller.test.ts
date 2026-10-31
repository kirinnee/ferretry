import { describe, it } from 'bun:test';
import type { CopyMeta, CopyPlan, PasteRule, PasteRuleCreate } from '@ferretry/protocol';
import should from 'should';
import {
  COPY_FERRET_REFUSAL,
  CopyController,
  parseFrom,
  parseLifetime,
  parseTo,
} from '../../../src/lib/copy/controller';
import type { CopyPorts, ICopyGateway } from '../../../src/lib/copy/ports';

const RULE: PasteRule = {
  id: 'a1b2c3d4'.padEnd(32, '0'),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  remaining: 2,
  used: 1,
  createdAt: '2026-10-31T12:00:00.000Z',
  createdBy: { kind: 'host' },
};

const PLAN: CopyPlan = {
  id: 'feedbeef'.padEnd(32, '0'),
  sessionId: 's1',
  agendaItemId: 'A9',
  items: [
    { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' }, why: 'deploy token' },
    {
      from: { kind: 'browser', origin: 'https://github.com' },
      to: { kind: 'secret', name: 'GH_TOKEN' },
      why: 'keep it',
    },
  ],
  state: 'pending',
  raisedAt: '2026-10-31T12:00:00.000Z',
  expiresAt: '2026-10-31T14:00:00.000Z',
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
  readonly added: PasteRuleCreate[] = [];
  readonly removed: string[] = [];
  readonly approved: { sessionId: string; planId: string; items: readonly number[] }[] = [];
  async copies(): Promise<readonly CopyMeta[]> {
    return [COPY];
  }
  async rules() {
    return { rules: [RULE] };
  }
  async addRule(rule: PasteRuleCreate): Promise<PasteRule> {
    this.added.push(rule);
    return { ...RULE, from: rule.from, to: rule.to };
  }
  async removeRule(id: string): Promise<void> {
    this.removed.push(id);
  }
  async plans() {
    return { plans: [PLAN] };
  }
  async approve(sessionId: string, planId: string, items: readonly number[]): Promise<CopyPlan> {
    this.approved.push({ sessionId, planId, items });
    return items.length === 0 ? { ...PLAN, state: 'declined' } : { ...PLAN, state: 'approved', approved: [...items] };
  }
}

function rig(overrides: Partial<CopyPorts> = {}) {
  const gateway = new FakeGateway();
  const said: string[] = [];
  const controller = new CopyController({
    gateway,
    out: { success: message => void said.push(message), diagnostic: () => undefined },
    ownSessionId: undefined,
    agentCredential: undefined,
    ...overrides,
  });
  return { gateway, said, controller };
}

const failure = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'no error',
    (error: Error) => error.message,
  );

describe('fy copy', () => {
  it('should refuse every command inside a ferret, before it calls the daemon', async () => {
    const inPane = rig({ ownSessionId: 's1' });
    const withCredential = rig({ agentCredential: 'cap' });

    const refusals = await Promise.all([
      failure(inPane.controller.rules({})),
      failure(inPane.controller.addRule({ from: 'command:gh', to: 'terminal:vercel' })),
      failure(withCredential.controller.approve('feed', ['1'], {})),
      failure(withCredential.controller.list({ session: 's1' })),
    ]);

    should(new Set(refusals)).eql(new Set([COPY_FERRET_REFUSAL]));
    should([inPane.gateway.added, withCredential.gateway.approved]).eql([[], []]);
  });

  it('should add a rule from the routes written as kind:value, with its count and expiry', async () => {
    const { controller, gateway, said } = rig();

    await controller.addRule({ from: 'command:gh', to: 'terminal:vercel', count: '2', expires: '2h', session: 's1' });

    should(gateway.added).eql([
      {
        from: { kind: 'command', program: 'gh' },
        to: { kind: 'terminal', program: 'vercel' },
        sessionId: 's1',
        count: 2,
        expiresInSeconds: 7200,
      },
    ]);
    should(said[0]).startWith('Approved in advance: a1b2c3d4  command:gh → terminal:vercel');
  });

  it('should refuse a rule with no route, or a count that is not a whole number', async () => {
    const { controller, gateway } = rig();

    should(await failure(controller.addRule({ from: 'command:gh' }))).containEql('needs --from and --to');
    should(await failure(controller.addRule({ from: 'command:gh', to: 'terminal:vercel', count: '1.5' }))).containEql(
      '--count',
    );
    should(gateway.added).eql([]);
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

  it('should approve the numbered items of a plan, and decline it with none', async () => {
    const { controller, gateway, said } = rig();

    await controller.approve('feed', ['2'], {});
    await controller.approve('feed', [], {});

    should(gateway.approved).eql([
      { sessionId: 's1', planId: PLAN.id, items: [1] },
      { sessionId: 's1', planId: PLAN.id, items: [] },
    ]);
    should(said).eql([
      'Allowed 2 of the plan feedbeef: each goes through once, until 2026-10-31T14:00:00.000Z.',
      'Declined the plan feedbeef.',
    ]);
    should(await failure(controller.approve('feed', ['3'], {}))).containEql('items 1 to 2');
  });

  it("should list plans with the agent's words and copies with no value", async () => {
    const { controller, said } = rig();

    await controller.plans({});
    await controller.list({ session: 's1' });

    should(said[0]).containEql('2. browser:https://github.com → secret:GH_TOKEN  the agent says: keep it');
    should(said[1]).equal(
      'sealed:vercel  live  24 chars from vercel  until 2026-10-31T13:00:00.000Z  pasted 0  [seen by the ferret before it was sealed]',
    );
    should(await failure(controller.list({}))).containEql('--session');
  });
});

describe('fy copy --json and empty listings', () => {
  it('should print each payload as JSON when asked', async () => {
    const { controller, said } = rig();

    await controller.list({ session: 's1', json: true });
    await controller.rules({ json: true });
    await controller.plans({ json: true, session: 's1' });
    await controller.approve('feed', ['1'], { json: true });
    await controller.addRule({ from: 'command:gh', to: 'terminal:vercel', json: true });
    await controller.removeRule('a1b2', { json: true });

    should(said.map(line => Object.keys(JSON.parse(line) as object)[0])).eql([
      'copies',
      'rules',
      'plans',
      'id',
      'id',
      'removed',
    ]);
  });

  it('should say plainly when there is nothing to list', async () => {
    const gateway = new FakeGateway();
    gateway.copies = async () => [];
    gateway.rules = async () => ({ rules: [] });
    gateway.plans = async () => ({ plans: [] });
    const said: string[] = [];
    const controller = new CopyController({
      gateway,
      out: { success: message => void said.push(message), diagnostic: () => undefined },
      ownSessionId: undefined,
      agentCredential: undefined,
    });

    await controller.list({ session: 's1' });
    await controller.rules({});
    await controller.plans({ session: 'other' });

    should(said).eql(['s1 holds no secure copies', 'no pastes are approved in advance', 'no paste plans are waiting']);
  });
});
