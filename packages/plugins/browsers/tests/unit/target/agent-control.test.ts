/**
 * S2 (findings-browsers-agent-control): "What agents may control › Browsers" at the PAGE TARGET, the one boundary every
 * write into a page on a ferret's behalf passes — a page input card (T-0024 `browser_request_input`), a secure paste into
 * a page (T-0042 `secure_paste`, through the Vault's `admit` → `observe`) and a grant fill. Today's `switchOf` gated
 * `secure.paste` to a browser with the Browsers switch (rebuild-ref agent-tools/service.ts:349-362) and refused with
 * `forbidden` and `controlRefusal('browser')` (policy.ts:96-101). No caller in the Vault or Accounts checks it again.
 */
import { afterEach, describe, it } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { InputTargetAdapter, InputTargetFacts } from '@ferretry/core-vault/contract';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import {
  type AgentControlKind,
  type AgentControlReader,
  agentControlRefusal,
  ApiError,
  type FerretId,
} from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import daemon, { buildBrowsers } from '../../../daemon/index.ts';
import { type PageControl, type PageInputHost, PageInputTarget } from '../../../daemon/target/adapter.ts';
import type { BrowserInputFacts, BrowserInputFieldsPort } from '../../../daemon/target/lib/contracts.ts';
import { TypedIdentities } from '../../../daemon/target/sign-in/identities.ts';
import { Tabs } from '../../support/tabs.ts';

/** Today's sentence when Browsers is off, word for word (rebuild-ref agent-tools/policy.ts:96-101). */
const BROWSERS_OFF =
  'This machine does not let agents control browsers: "What agents may control › Browsers" is off in this machine\'s settings. Ask the person to turn it on if you need it.';

const F1 = 'f1' as FerretId;
const APP = { kind: 'page', key: 'app' } as const;
const FIELDS = [{ id: 'password', element: { kind: 'ref', ref: 'e3' } }] as const;
const FACTS: BrowserInputFacts = {
  kind: 'page',
  pageId: 'page-1',
  origin: 'https://example.test',
  secure: true,
  navigationId: 'loader-1',
  fields: [
    {
      fieldId: 'password',
      frameOrigin: 'https://example.test',
      frameId: 'main',
      backendNodeId: 9,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
    },
  ],
};
const CLEAR_JOB = { navigationId: 'loader-1', fields: [{ frameId: 'main', backendNodeId: 9 }] };

/** The owner's switches: on for the kinds named, read afresh on each call; every ask is recorded. */
function switches(...on: AgentControlKind[]) {
  const kinds = new Set<AgentControlKind>(on);
  const asked: [string, AgentControlKind][] = [];
  const reader: AgentControlReader = {
    allows: async (who, kind) => {
      asked.push([who, kind]);
      return kinds.has(kind);
    },
  };
  return {
    reader,
    asked,
    set: (kind: AgentControlKind, value: boolean) => (value ? kinds.add(kind) : kinds.delete(kind)),
  };
}

/** A page that records every look, picture and write it is asked for, and answers each one. */
function page() {
  const calls: string[] = [];
  const port: BrowserInputFieldsPort = {
    inputObserve: async pageId => {
      calls.push(`observe:${pageId}`);
      return { ok: true, facts: FACTS };
    },
    inputRefind: async pageId => {
      calls.push(`refind:${pageId}`);
      return { ok: true, facts: FACTS };
    },
    inputType: async pageId => {
      calls.push(`type:${pageId}`);
      return 'typed';
    },
    inputProbe: async pageId => {
      calls.push(`probe:${pageId}`);
      return 'hidden';
    },
    inputShot: async pageId => {
      calls.push(`shot:${pageId}`);
      return { pngBase64: 'AAAA', clip: { x: 0, y: 0, w: 10, h: 10 } };
    },
    inputDocument: async pageId => {
      calls.push(`document:${pageId}`);
      return { navigationId: 'loader-1', host: 'example.test' };
    },
    inputText: async pageId => {
      calls.push(`text:${pageId}`);
      return 'Welcome';
    },
    inputClear: async pageId => {
      calls.push(`clear:${pageId}`);
      return 'cleared';
    },
  };
  const host: PageInputHost = { inputOnPage: async (_ferret, _key, work) => await work(port, 'page-1') };
  return { host, calls };
}

/** The refusal an `observe` or a `refind` throws: today's code and sentence. */
async function refusalOf(work: () => Promise<unknown>): Promise<ApiError> {
  const thrown = await work().then(
    () => undefined,
    (error: unknown) => error,
  );
  should(thrown).be.instanceOf(ApiError);
  return thrown as ApiError;
}

describe('S2 the page target reads "What agents may control › Browsers" (AgentControlPort)', () => {
  it('T-0042 should refuse a secure paste (or any card) into a page with today’s forbidden and sentence while Browsers is off, touching no page', async () => {
    // Arrange — every other switch on, Browsers off.
    const { reader, asked } = switches('terminal', 'files', 'settings', 'scripts');
    const { host, calls } = page();
    const target = new PageInputTarget(host, () => reader);

    // Act — the Vault's `admit` looks first; a fill re-finds, then types; a secret's card probes.
    const looked = await refusalOf(async () => await target.observe(F1, APP, FIELDS));
    const refound = await refusalOf(async () => await target.refind(F1, APP, FIELDS, FACTS));
    const typed = await target.type(F1, APP, [{ field: 'password', text: 'hunter2' }], false, FACTS);
    const probed = await target.probe(F1, APP, FACTS, ['password']);

    // Assert
    for (const refusal of [looked, refound]) {
      should(refusal.status).equal(403);
      should(refusal.code).equal('forbidden');
      should(refusal.message).equal(BROWSERS_OFF);
      should(refusal.message).equal(agentControlRefusal('browser'));
    }
    should(typed).equal('target_gone');
    should(probed).equal('aborted');
    should(calls).eql([]);
    should(asked).eql([
      ['f1', 'browser'],
      ['f1', 'browser'],
      ['f1', 'browser'],
      ['f1', 'browser'],
    ]);
  });

  it('T-0024 should let a card into a page through while Browsers is on, asking for the ferret the card is for', async () => {
    // Arrange
    const { reader, asked } = switches('browser');
    const { host, calls } = page();
    const target = new PageInputTarget(host, () => reader);

    // Act
    const looked = await target.observe(F1, APP, FIELDS);
    const typed = await target.type(F1, APP, [{ field: 'password', text: 'hunter2' }], false, FACTS);

    // Assert
    should(looked).eql({ ok: true, facts: FACTS, names: ['page-1'] });
    should(typed).equal('typed');
    should(calls).eql(['observe:page-1', 'type:page-1']);
    should(asked).eql([
      ['f1', 'browser'],
      ['f1', 'browser'],
    ]);
  });

  it('should fail closed: the port unbound, a lookup that throws, a reader that throws, or an answer that is not a plain yes', async () => {
    // Arrange
    const controls: Record<string, PageControl> = {
      unbound: () => undefined,
      'lookup throws': () => {
        throw new TypeError('browsers: an optional port is unbound during build');
      },
      'reader throws': () => ({
        allows: async () => {
          throw new Error('plugin_unavailable');
        },
      }),
      'truthy, not true': () => ({ allows: async () => 'yes' as unknown as boolean }),
    };

    for (const [why, control] of Object.entries(controls)) {
      const { host, calls } = page();
      const target = new PageInputTarget(host, control);

      // Act
      const refusal = await refusalOf(async () => await target.observe(F1, APP, FIELDS));
      const typed = await target.type(F1, APP, [{ field: 'password', text: 'hunter2' }], false, FACTS);

      // Assert
      should(refusal.code).equal('forbidden', why);
      should(refusal.message).equal(BROWSERS_OFF, why);
      should(typed).equal('target_gone', why);
      should(calls).eql([], why);
    }
  });

  it('should read the switch afresh at the write: Browsers turned off after the look types nothing', async () => {
    // Arrange
    const owner = switches('browser');
    const { host, calls } = page();
    const target = new PageInputTarget(host, () => owner.reader);
    const looked = await target.observe(F1, APP, FIELDS);
    should(looked.ok).be.true();

    // Act
    owner.set('browser', false);
    const typed = await target.type(F1, APP, [{ field: 'password', text: 'hunter2' }], false, FACTS);

    // Assert
    should(typed).equal('target_gone');
    should(calls).eql(['observe:page-1']);
  });

  it('should leave the owner’s protections running while Browsers is off: the clear, the quarantine’s document, the card’s picture and the daemon’s own looks', async () => {
    // Arrange
    const { reader } = switches();
    const { host, calls } = page();
    const target = new PageInputTarget(host, () => reader);

    // Act
    const cleared = await target.arm(F1, APP, CLEAR_JOB);
    const document = await target.document(F1, 'app');
    const shot = await target.shoot(F1, APP, FACTS as InputTargetFacts);
    const where = await target.where(F1, 'app', ['page-1']);
    const text = await target.text(F1, 'app', ['page-1']);

    // Assert — an emptied field and a held quarantine never wait on the switch; turning it off must not loosen either.
    should(cleared).equal('cleared');
    should(document).equal('loader-1');
    should(shot).not.be.undefined();
    should(where).eql({ navigationId: 'loader-1', host: 'example.test' });
    should(text).equal('Welcome');
    should(calls).eql(['clear:page-1', 'document:page-1', 'shot:page-1', 'document:page-1', 'text:page-1']);
  });
});

describe('S2 the daemon half binds its page target to core’s AgentControlPort', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  /** The half as `build` composes it, with the owner's switches as given (`null`: Ferrets is not serving the port). */
  async function built(control: AgentControlReader | null): Promise<InputTargetAdapter> {
    const tabs = new Tabs();
    let half: ReturnType<typeof buildBrowsers> | undefined;
    const plugin = implementDaemon(daemon.manifest, {
      build: ctx =>
        (half = buildBrowsers(ctx, {
          launcher: { launch: async () => tabs.automation },
          identities: new TypedIdentities(() => Date.parse('2026-11-08T10:00:00.000Z')),
        })),
    });
    host = await testHost({
      plugins: [plugin],
      uses: {
        ferrets: { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) },
        ...(control === null ? {} : { agentControl: control }),
      },
      fakes: { vault: new FakeVault(), gate: new FakeGate() },
      gate: new StandInAdmission(request =>
        request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(F1) : ownerStanding(),
      ),
    });
    const adapter = half?.hooks['input.targets:page'] as InputTargetAdapter | undefined;
    if (adapter === undefined) throw new Error('the half provides no input.targets:page');
    return adapter;
  }

  it('T-0042 should refuse a paste into a page with today’s forbidden and sentence when Browsers is off', async () => {
    // Arrange — the page is opened while Browsers is on, then the owner turns it off.
    const owner = switches('browser', 'files');
    const adapter = await built(owner.reader);
    const opened = await host?.tool(
      'browser_open',
      { name: 'app', url: 'https://example.test/login' },
      {
        as: ferret('f1'),
      },
    );
    should(opened?.isError).not.be.true();
    owner.set('browser', false);

    // Act
    const refusal = await refusalOf(async () => await adapter.observe(F1, APP, FIELDS));

    // Assert
    should(refusal.code).equal('forbidden');
    should(refusal.message).equal(BROWSERS_OFF);
    should(owner.asked.at(-1)).eql(['f1', 'browser']);
  });

  it('should refuse when Ferrets is not serving the agent-control port (fails closed)', async () => {
    // Arrange
    const adapter = await built(null);

    // Act
    const refusal = await refusalOf(async () => await adapter.observe(F1, APP, FIELDS));

    // Assert
    should(refusal.code).equal('forbidden');
    should(refusal.message).equal(BROWSERS_OFF);
  });

  it('should let the look through when Browsers is on (it reaches the page queue, which knows no such page)', async () => {
    // Arrange
    const owner = switches('browser');
    const adapter = await built(owner.reader);

    // Act — no page `app` is open, so the page queue answers it gone: the switch did not refuse it.
    const seen = await adapter.observe(F1, APP, FIELDS);

    // Assert
    should(seen).eql({ ok: false, reason: 'target_gone' });
    should(owner.asked).eql([['f1', 'browser']]);
  });
});
