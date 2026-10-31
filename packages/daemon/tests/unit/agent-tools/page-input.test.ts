import { describe, it } from 'bun:test';
import { type AgendaId, type InputTarget, type InputTargetFacts, padInputValue } from '@ferretry/protocol';
import should from 'should';
import { BrowserTransportError } from '../../../src/lib/browser/transport/worker-protocol.ts';
import type { AgentToolError } from '../../../src/lib/index.ts';
import { EphemeralAwareRedactor } from '../../../src/lib/input-requests/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import type { InputCaller, InputFieldValue, ObserveResult } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { InputTargetRouter } from '../../../src/lib/input-requests/target-router.ts';
import type { TextRedactor } from '../../../src/lib/secrets/redaction.ts';
import { FACTS } from '../input-requests/support.ts';
import { agent, agentToolWorld, person } from './support.ts';

/**
 * A PAGE'S HOLD, end to end through the agent tools and the REAL input service: the owner's password goes into a
 * page; the agent cannot read or picture the page while it is held; once the page has moved on, its text comes
 * back MASKED (a page that echoes the password shows a mask), and a picture still waits for the window to end.
 */

const SESSION = 's1';
const PASSWORD = 'hunter2-UNIQUE-page';
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };

const NO_REDACTION: TextRedactor = {
  redact: async text => text,
  redactData: async value => value,
  batch: async work => work({ text: text => text, data: value => value, cover: () => [] }),
};

const page = (navigationId: string): InputTargetFacts => ({
  kind: 'browser',
  pageId: 'page-1',
  origin: 'https://accounts.example.test',
  secure: true,
  navigationId,
  fields: [
    {
      fieldId: 'email',
      frameOrigin: 'https://accounts.example.test',
      frameId: 'main',
      backendNodeId: 11,
      field: { tag: 'input', type: 'email' },
      box: { x: 10, y: 10, w: 300, h: 40 },
      visible: true,
    },
    {
      fieldId: 'password',
      frameOrigin: 'https://accounts.example.test',
      frameId: 'main',
      backendNodeId: 12,
      field: { tag: 'input', type: 'password' },
      box: { x: 10, y: 60, w: 300, h: 40 },
      visible: true,
    },
  ],
});

function world() {
  const clock = { ms: Date.parse('2026-10-31T12:00:00.000Z'), now: () => clock.ms };
  const values = new EphemeralValues(clock);
  const typed: { values: readonly InputFieldValue[]; submit: boolean }[] = [];
  const browser = { document: 'loader-1' };
  let card = 1;
  let id = 1;
  const pages = {
    observe: async (): Promise<ObserveResult> => ({ ok: true, facts: page('loader-1'), names: ['app'] }),
    type: async (_session: string, _target: InputTarget, written: readonly InputFieldValue[], submit: boolean) => {
      typed.push({ values: written, submit });
      return 'typed' as const;
    },
    shoot: async () => ({ pngBase64: 'iVBORw0KGgo=', clip: { x: 0, y: 0, w: 320, h: 120 } }),
    document: async () => browser.document,
  };
  const terminal = {
    observe: async (): Promise<ObserveResult> => ({ ok: true, facts: FACTS }),
    type: async () => 'typed' as const,
  };
  const service = new InputRequestService({
    target: new InputTargetRouter(terminal, pages),
    agenda: {
      raise: async () => ({ ok: true, id: `A${card++}` as AgendaId }),
      close: async () => undefined,
      promptOf: async () => undefined,
    },
    notifier: { tell: async () => undefined },
    journal: {
      publish: async () => undefined,
      history: async () => [],
      quarantine: async () => {
        throw new Error('a page hold is never journalled');
      },
      quarantines: async () => [],
    },
    audit: { record: async () => undefined, saved: async () => undefined, stored: async () => undefined },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== SESSION, all: async () => [SESSION] },
    values,
    quarantine: new QuarantineRegistry(clock),
    redact: async text => values.scrubAll(text),
  });
  const tools = agentToolWorld({
    input: {
      raise: async (sessionId, raise) => await service.raise(sessionId, raise),
      agentView: async (sessionId, card, waitMs) => await service.agentView(sessionId, card, waitMs),
      pendingOn: (sessionId, target, options) => service.pendingOn(sessionId, target, options),
      exclusive: async (sessionId, work) => await service.exclusive(sessionId, work),
      pageHeld: (sessionId, names) => service.pageHeld(sessionId, names),
      pageDocument: async (sessionId, key) => await service.pageDocument(sessionId, key),
    },
    redactor: new EphemeralAwareRedactor(NO_REDACTION, values),
  });
  return { service, tools, typed, browser, clock };
}

const refusal = async (work: Promise<unknown>): Promise<AgentToolError> =>
  (await work.then(
    () => undefined,
    (failure: unknown) => failure,
  )) as AgentToolError;

async function delivered() {
  const built = world();
  await built.tools.service.call(agent, { tool: 'browser.open', name: 'app' });
  await built.tools.service.call(agent, {
    tool: 'browser.request_input',
    name: 'app',
    prompt: 'log in to the console',
    fields: [
      { id: 'email', label: 'Email', sensitivity: 'plain', selector: '#email' },
      { id: 'password', sensitivity: 'secret', ref: 'e12' },
    ],
  });
  const [request] = await built.service.list(HOST);
  if (request === undefined) throw new Error('no request');
  return { ...built, request };
}

describe('a page the owner was asked about', () => {
  it('should refuse the agent typing into it while the request waits', async () => {
    const { tools } = await delivered();

    const error = await refusal(
      tools.service.call(agent, { tool: 'browser.type', name: 'app', ref: 'e12', text: 'x' }),
    );

    should(error.code).equal('conflict');
    should(error.message).containEql('an input request is pending on %browser:app');
  });

  it('should let the agent type into a page whose only card asks for a one-time code: it may type a code itself', async () => {
    // Arrange — the ferret asked the owner for a code, then read it from an inbox it has.
    const built = world();
    await built.tools.service.call(agent, { tool: 'browser.open', name: 'app' });
    await built.tools.service.call(agent, {
      tool: 'browser.request_input',
      name: 'app',
      prompt: 'the code GitHub sent',
      fields: [{ id: 'code', label: 'Code', sensitivity: 'code', ref: 'e12' }],
    });

    // Act
    const typed = await built.tools.service.call(agent, {
      tool: 'browser.type',
      name: 'app',
      ref: 'e12',
      text: '481516',
    });

    // Assert — nothing refused it, and the card is still there for the owner or input.wait.
    should(typed.summary).not.containEql('pending');
    should((await built.service.list(HOST))[0]?.state).equal('pending');
  });
  it('should refuse a page script while the request waits: a script can fill the field as well as type can', async () => {
    const { tools } = await delivered();

    const error = await refusal(tools.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }));

    should(error.message).containEql('an input request is pending on %browser:app');
  });

  it('should picture the fields for the owner before anything is typed, and let the picture go with the request', async () => {
    const { service, request } = await delivered();

    should(request.pictured).be.true();
    should(service.shot(HOST, SESSION, request.id).clip).eql({ x: 0, y: 0, w: 320, h: 120 });
    should(() => service.shot({ kind: 'agent', sessionId: SESSION }, SESSION, request.id)).throw(/only the owner/u);
    await service.cancel(SESSION, request.id, HOST);
    should(() => service.shot(HOST, SESSION, request.id)).throw(/no picture/u);
  });
});

describe('a page the owner’s password was just typed into', () => {
  async function typedIn() {
    const built = await delivered();
    await built.service.deliver(
      SESSION,
      built.request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: built.request.observedDigest ?? '',
        submit: true,
        fields: [
          { field: 'email', padded: padInputValue('kirin@example.test') },
          { field: 'password', padded: padInputValue(PASSWORD) },
        ],
      },
      HOST,
    );
    return built;
  }

  it('should refuse reading or picturing it while it is still on the document the password went into', async () => {
    const { tools, typed } = await typedIn();

    const read = await refusal(tools.service.call(agent, { tool: 'browser.read', name: 'app' }));
    const shot = await refusal(tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' }));

    should(typed).have.length(1);
    should(read.message).containEql('%browser:app is quarantined until');
    should(shot.message).containEql('%browser:app is quarantined until');
  });

  it('should refuse a page script on the held page until it has moved on', async () => {
    const { tools } = await typedIn();

    const error = await refusal(tools.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }));

    should(error.message).containEql('%browser:app is quarantined until');
  });

  it('should hand text back MASKED once the page has moved on, even a page that echoes the password', async () => {
    const { tools, browser } = await typedIn();
    browser.document = 'loader-2';
    tools.browser.document = 'loader-2';
    tools.browser.readText = `Signed in. Your password is ${PASSWORD} — keep it safe.`;

    const read = await tools.service.call(agent, { tool: 'browser.read', name: 'app' });

    should(JSON.stringify(read)).not.containEql(PASSWORD);
    should(read.output).containEql('[redacted');
  });

  it('should keep pictures refused until the window ends, even after the page moved on', async () => {
    const { tools, browser, clock } = await typedIn();
    browser.document = 'loader-2';
    tools.browser.document = 'loader-2';

    const early = await refusal(tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' }));
    clock.ms += 121_000;
    const later = await tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' });

    should(early.message).containEql('quarantined');
    should(later.screenshotBase64).be.a.String();
  });

  it('should tell a person reading the held page through the tools where to look instead', async () => {
    const { tools } = await typedIn();

    const read = await refusal(tools.service.call(person, { tool: 'browser.read', name: 'app' }));

    should(read.message).containEql('Look at it in the browser view');
  });

  it('should never journal a page hold, and never list it among the terminals the owner’s viewer covers', async () => {
    const { service } = await typedIn();

    should(service.quarantines(HOST, SESSION)).eql([]);
    should(service.pageHeld(SESSION, ['app'])?.documents).eql(['loader-1']);
    should(service.quarantinedUntil(SESSION, ['app'])).be.undefined();
  });
});

describe('review regressions: what reaches a page while the owner’s value is on its way or just typed', () => {
  const sendValue = async (built: Awaited<ReturnType<typeof delivered>>) => {
    await built.service.deliver(
      SESSION,
      built.request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: built.request.observedDigest ?? '',
        submit: false,
        fields: [
          { field: 'email', padded: padInputValue('kirin@example.test') },
          { field: 'password', padded: padInputValue(PASSWORD) },
        ],
      },
      HOST,
    );
  };
  const raise = async (built: ReturnType<typeof world>) => {
    await built.tools.service.call(agent, {
      tool: 'browser.request_input',
      name: 'app',
      prompt: 'log in to the console',
      fields: [
        { id: 'email', label: 'Email', sensitivity: 'plain', selector: '#email' },
        { id: 'password', sensitivity: 'secret', ref: 'e12' },
      ],
    });
    const [request] = await built.service.list(HOST);
    if (request === undefined) throw new Error('no request');
    return { ...built, request };
  };

  it('should refuse, inside the page’s queue, a script that waited there while the value was asked for and typed', async () => {
    const built = world();
    await built.tools.service.call(agent, { tool: 'browser.open', name: 'app' });
    // The script passed the check before the queue; while it waited, a request was raised and answered.
    built.tools.browser.beforeGuard.push(async () => await sendValue(await raise(built)));

    const error = await refusal(
      built.tools.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }),
    );

    should(error.message).containEql('%browser:app is quarantined until');
    should(built.tools.browser.scripts).have.length(0);
  });

  it('should refuse, inside the page’s queue, typing that waited there while a request was raised', async () => {
    const built = world();
    await built.tools.service.call(agent, { tool: 'browser.open', name: 'app' });
    built.tools.browser.beforeGuard.push(async () => {
      await raise(built);
    });

    const error = await refusal(
      built.tools.service.call(agent, { tool: 'browser.type', name: 'app', ref: 'e12', text: 'x' }),
    );

    should(error.message).containEql('an input request is pending on %browser:app');
    should(built.tools.browser.acts.filter(act => act.endsWith(':type'))).eql([]);
  });

  it('should mask a page’s thrown error once the page has moved on, so a page that throws the password shows a mask', async () => {
    const built = await delivered();
    await sendValue(built);
    built.browser.document = 'loader-2';
    built.tools.browser.document = 'loader-2';
    built.tools.browser.scriptOnPage = async () => {
      throw new BrowserTransportError(
        'upstream_failed',
        `browser action failed: the script threw: Error: ${PASSWORD}`,
        502,
      );
    };

    const error = await refusal(
      built.tools.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => { throw 1; }' }),
    );

    should(error.message).not.containEql(PASSWORD);
    should(error.message).containEql('[redacted');
  });

  it('should answer a read that failed while the value was being typed with the hold, not with what the page said', async () => {
    const built = await delivered();
    built.tools.browser.lifecycleOnPage = async () => {
      // The value lands while the log is being read, and the read then fails with the page's own words.
      await sendValue(built);
      throw new BrowserTransportError('upstream_failed', `browser action failed: console said ${PASSWORD}`, 502);
    };

    const error = await refusal(built.tools.service.call(agent, { tool: 'browser.console', name: 'app' }));

    should(error.message).containEql('%browser:app is quarantined until');
    should(error.message).not.containEql(PASSWORD);
  });
});
