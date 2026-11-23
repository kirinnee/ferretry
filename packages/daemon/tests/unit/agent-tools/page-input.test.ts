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
import { agent, agentToolWorld } from './support.ts';

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
      pageShows: (sessionId, names) => service.pageShows(sessionId, names),
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

  /** A page with one card raised on it: its fields by id (`email` is a text field, `password` a password field). */
  const carded = async (fields: readonly { id: string; sensitivity: 'secret' | 'code' | 'plain' }[]) => {
    const built = world();
    await built.tools.service.call(agent, { tool: 'browser.open', name: 'app' });
    await built.tools.service.call(agent, {
      tool: 'browser.request_input',
      name: 'app',
      prompt: 'the code GitHub sent',
      fields: fields.map(field => ({ ...field, selector: `#${field.id}` })),
    });
    return built;
  };
  const typing = async (built: Awaited<ReturnType<typeof carded>>) =>
    await refusal(built.tools.service.call(agent, { tool: 'browser.type', name: 'app', ref: 'e12', text: '481516' }));

  it('should let the agent type into a page whose only card asks for a one-time code: it may type a code itself', async () => {
    // Arrange — the ferret asked the owner for a code, then read it from an inbox it has.
    const built = await carded([{ id: 'email', sensitivity: 'code' }]);

    // Act
    const typed = await built.tools.service.call(agent, {
      tool: 'browser.type',
      name: 'app',
      ref: 'e12',
      text: '481516',
    });

    // Assert — nothing refused it, and the card is still there for the owner or input.wait.
    should(typed.summary).not.containEql('pending');
    should((await built.service.list(HOST))[0]).containDeep({ state: 'pending', sensitivity: 'code' });
  });

  it('should still refuse a script, a key press or a form fill while a code card waits: only typing goes past it', async () => {
    // Arrange
    const built = await carded([{ id: 'email', sensitivity: 'code' }]);

    // Act
    const refusals = [
      await refusal(built.tools.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' })),
      await refusal(built.tools.service.call(agent, { tool: 'browser.press', name: 'app', keys: ['Enter'] })),
      await refusal(
        built.tools.service.call(agent, {
          tool: 'browser.fill_form',
          name: 'app',
          fields: [{ ref: 'e12', text: '1' }],
        }),
      ),
    ];

    // Assert
    for (const error of refusals) should(error.message).containEql('an input request is pending on %browser:app');
  });

  it('should keep the agent from typing while a card mixes a code with a plain value or a secret', async () => {
    // Act
    const plain = await typing(
      await carded([
        { id: 'email', sensitivity: 'plain' },
        { id: 'otp', sensitivity: 'code' },
      ]),
    );
    const secret = await typing(
      await carded([
        { id: 'password', sensitivity: 'secret' },
        { id: 'otp', sensitivity: 'code' },
      ]),
    );

    // Assert
    should(plain.message).containEql('an input request is pending on %browser:app');
    should(secret.message).containEql('an input request is pending on %browser:app');
  });

  it('should handle a code aimed at a password field as a secret: hidden and blocking the agent while it waits, never locked', async () => {
    // Arrange — the ferret called the page's password field a code.
    const built = await carded([{ id: 'password', sensitivity: 'code' }]);
    const [request] = await built.service.list(HOST);

    // Act
    const error = await typing(built);

    // Assert
    should(request?.sensitivity).equal('secret');
    should(request?.fields[0]?.risk?.reason).equal('Treated as a secret: this is a password field.');
    should(request?.lock).be.undefined();
    should(error.message).containEql('an input request is pending on %browser:app');
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

  it('should let the ferret read and picture the page at once after the password was typed: nothing is held', async () => {
    const { tools, typed } = await typedIn();

    const read = await tools.service.call(agent, { tool: 'browser.read', name: 'app' });
    const shot = await tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' });

    should(typed).have.length(1);
    should(JSON.stringify(read)).not.containEql(PASSWORD);
    should(shot.screenshotBase64).be.a.String();
  });

  it('should let a page script run at once after the password was typed', async () => {
    const { tools } = await typedIn();

    const result = await tools.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });

    should(result).not.be.undefined();
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

  it('should never hold a page or journal a hold after the password was typed', async () => {
    const { service } = await typedIn();

    should(service.quarantines(HOST, SESSION)).eql([]);
    should(service.pageHeld(SESSION, ['app'])).be.undefined();
    should(service.quarantinedUntil(SESSION, ['app'])).be.undefined();
  });
});

describe('a value the page shows in the clear (value-level protection, never a lock)', () => {
  const CARD = '4242424242424242';
  async function typedInClear() {
    const built = world();
    await built.tools.service.call(agent, { tool: 'browser.open', name: 'app' });
    // A secret into an input that draws what it holds (the page's email box stands in for a card number).
    await built.tools.service.call(agent, {
      tool: 'browser.request_input',
      name: 'app',
      prompt: 'the card number',
      fields: [{ id: 'email', label: 'Card number', sensitivity: 'secret', selector: '#card' }],
    });
    const [request] = await built.service.list(HOST);
    if (request === undefined) throw new Error('no request');
    await built.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest ?? '',
        submit: false,
        padded: padInputValue(CARD),
      },
      HOST,
    );
    return built;
  }

  it('should withhold a PICTURE of the document that shows the value, and nothing else', async () => {
    const { tools } = await typedInClear();

    const shot = await refusal(tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' }));
    const read = await tools.service.call(agent, { tool: 'browser.read', name: 'app' });
    const eval1 = await tools.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });

    should(shot.message).containEql('is not pictured');
    should(JSON.stringify(read)).not.containEql(CARD);
    should(eval1).not.be.undefined();
  });

  it('should picture the page again once it shows another document', async () => {
    const { tools, browser } = await typedInClear();
    browser.document = 'loader-2';
    tools.browser.document = 'loader-2';

    const shot = await tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' });

    should(shot.screenshotBase64).be.a.String();
  });

  it('should picture the page again once the value’s window has ended', async () => {
    const { tools, clock } = await typedInClear();
    clock.ms += 601_000;

    const shot = await tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' });

    should(shot.screenshotBase64).be.a.String();
  });

  it('should never withhold a picture of a password input, which draws dots', async () => {
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

    const shot = await built.tools.service.call(agent, { tool: 'browser.screenshot', name: 'app' });

    should(shot.screenshotBase64).be.a.String();
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
});
