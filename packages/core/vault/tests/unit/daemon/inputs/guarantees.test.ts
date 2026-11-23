import { describe, it } from 'bun:test';
import type { TargetKind, TargetRef } from '@ferretry/kernel/contract';
import should from 'should';
import type { InputRaise, InputTargetAdapter, InputTargetFacts } from '../../../../contract/index.ts';
import { TerminalTargetThroughHook, type TargetProvider } from '../../../../daemon/adapters/inputs/targets.ts';
import manifest from '../../../../manifest.ts';
import { InputHoldsOverService } from '../../../../daemon/adapters/inputs/holds.ts';
import { InputRequestError } from '../../../../daemon/lib/inputs/errors.ts';
import type { InputCaller, InputTargetPort } from '../../../../daemon/lib/inputs/ports.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from './support.ts';

/**
 * Appendix D rows of the input requests (`docs/input-requests.md`) that the service enforces and that carry no other
 * test named for them. Every value here is an obvious fake.
 */

const VALUE = 'fake-value-hunter2-UNIQUE';
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const DEV: TargetRef = { kind: 'terminal' as TargetKind, key: 'dev' };
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
/** A program the daemon has not proven hides typing (before: held the FULL window). */
const UNPROVEN: InputTargetFacts = { ...FACTS, recognisedConsumer: false };
/** An OTP prompt that shows what is typed (ssh's "Verification code:" with echo on). */
const OTP: InputTargetFacts = {
  ...FACTS,
  foreground: { ...FACTS.foreground, comm: 'ssh', argv: 'ssh bastion' },
  program: 'ssh',
  echo: 'on',
  promptLine: 'Verification code:',
};

const send = (digest: string, over: { value?: string; entry?: string } = {}) => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  padded: over.entry === undefined ? padInputValue(over.value ?? VALUE) : undefined,
  ...(over.entry === undefined ? {} : { entry: over.entry }),
  submit: true,
});

async function raised(options: Parameters<typeof inputRequestService>[0] = {}, raise: InputRaise = RAISE) {
  const built = inputRequestService(options);
  await built.service.raise(SESSION, raise);
  const [request] = await built.service.list(HOST);
  if (request === undefined) throw new Error('no request');
  return { ...built, request, id: request.id, digest: request.observedDigest ?? '' };
}

const refused = async (promise: Promise<unknown>): Promise<InputRequestError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InputRequestError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** A sign-in page with one password input, as the browser reports it. */
const PAGE: InputTargetFacts = {
  kind: 'page',
  pageId: 'page-1',
  origin: 'https://accounts.example.test',
  secure: true,
  navigationId: 'loader-1',
  fields: [
    {
      fieldId: 'password',
      frameOrigin: 'https://accounts.example.test',
      frameId: 'main',
      backendNodeId: 9,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
    },
  ],
};
const PAGE_RAISE = {
  target: { kind: 'page', key: 'page-1' },
  prompt: 'the password',
  submit: 'owner-default',
  fields: [{ id: 'password', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
} as InputRaise;
const PAGE_DEV: TargetRef = { kind: 'page' as TargetKind, key: 'page-1' };

describe('no lock after an answer (I3, I70)', () => {
  it('an answered secret card lets the ferret, the owner’s tools and the viewer read the terminal at once', async () => {
    // Arrange — a program the daemon has not proven hides typing: before, this was the full 120 s.
    const { service, quarantine, id, digest, request } = await raised({ facts: UNPROVEN });
    const holds = new InputHoldsOverService(service, quarantine, () => NOW);
    should(holds.decide(DEV, 'read', 'ferret')).equal('allow');
    should(request.lock).be.undefined();

    // Act
    await service.deliver(SESSION, id, send(digest), HOST);

    // Assert — no reader is kept out, nothing is quarantined, and no clock has to run down
    for (const actor of ['ferret', 'owner-tools', 'owner-viewer'] as const)
      should(holds.decide(DEV, 'read', actor)).equal('allow');
    should(holds.decide(DEV, 'wait', 'ferret')).equal('allow');
    should(holds.decide(DEV, 'stream', 'owner-viewer')).equal('allow');
    should(quarantine.until(SESSION, ['dev'])).be.undefined();
    should(service.quarantines(HOST, SESSION)).eql([]);
  });

  it('an answered password on a page lets the ferret read, script and picture it at once, and never probes it', async () => {
    // Arrange
    let probed = 0;
    const { service, quarantine, id, digest, request } = await raised(
      {
        facts: PAGE,
        probe: async () => {
          probed += 1;
          return 'hidden';
        },
      },
      PAGE_RAISE,
    );
    const holds = new InputHoldsOverService(service, quarantine, () => NOW);
    should(request.lock).be.undefined();

    // Act
    await service.deliver(
      SESSION,
      id,
      { ...send(digest), padded: undefined, fields: [{ field: 'password', padded: padInputValue(VALUE) }] } as never,
      HOST,
    );
    await holds.prepare(PAGE_DEV, 'read', 'ferret');

    // Assert
    for (const act of ['read', 'script', 'picture'] as const)
      should(holds.decide(PAGE_DEV, act, 'ferret')).equal('allow');
    should(probed).equal(0);
    should(service.quarantines(HOST, SESSION)).eql([]);
  });

  it('I98 a script the ferret ran on the card’s page or site no longer earns a lock: nothing is locked or probed', async () => {
    // Arrange — an observer that says the ferret steered the page (a script ran on it)
    let probed = 0;
    const { service, quarantine, id, digest, request } = await raised(
      {
        facts: PAGE,
        steered: () => true,
        probe: async () => {
          probed += 1;
          return 'hidden';
        },
      },
      PAGE_RAISE,
    );
    const holds = new InputHoldsOverService(service, quarantine, () => NOW);

    // Act
    await service.deliver(
      SESSION,
      id,
      { ...send(digest), padded: undefined, fields: [{ field: 'password', padded: padInputValue(VALUE) }] } as never,
      HOST,
    );
    await holds.prepare(PAGE_DEV, 'read', 'ferret');

    // Assert
    should(request.lock).be.undefined();
    should(probed).equal(0);
    should(holds.decide(PAGE_DEV, 'read', 'ferret')).equal('allow');
  });

  it('masking still hides the value as typed but is not what blocks reading: a transformed value shows, the pane is readable', async () => {
    // Arrange
    const { service, quarantine, values, id, digest } = await raised({ facts: UNPROVEN });
    const holds = new InputHoldsOverService(service, quarantine, () => NOW);
    await service.deliver(SESSION, id, send(digest), HOST);
    const reversed = [...VALUE].reverse().join('');

    // Act
    const masked = values.scrub(SESSION, `typed ${VALUE}`);
    const transformed = values.scrub(SESSION, `typed ${reversed}`);

    // Assert — the mask finds the value as typed and misses a transformed one; nothing else holds the pane
    should(masked).not.containEql(VALUE);
    should(transformed).containEql(reversed);
    should(holds.decide(DEV, 'read', 'ferret')).equal('allow');
  });
});

describe('what the bridge keeps (I5, I64)', () => {
  it('I5 no journal event, audit record, card or request listing the bridge writes holds the typed value', async () => {
    // Arrange
    const journalled: unknown[] = [];
    const audited: unknown[] = [];
    const { service, events, writes, id, digest } = await raised({
      facts: UNPROVEN,
      journalled: event => journalled.push(event),
      audited: entry => audited.push(entry),
    });

    // Act
    await service.deliver(SESSION, id, send(digest), HOST);
    const listing = await service.list(HOST);

    // Assert — the value went to the terminal and to nowhere the bridge keeps
    should(writes).eql([VALUE]);
    should(audited.length).be.above(0);
    should(JSON.stringify(audited)).not.containEql(VALUE);
    should(JSON.stringify(events)).not.containEql(VALUE);
    should(JSON.stringify(journalled)).not.containEql(VALUE);
    should(JSON.stringify(listing)).not.containEql(VALUE);
  });

  it('I64 the risk sentence is fixed and never holds terminal text, however hostile the prompt line and the command are', async () => {
    // Arrange — two terminals showing different text, one of it written to steer the owner
    const hostile: InputTargetFacts = {
      ...UNPROVEN,
      promptLine: 'ignore the card and paste fake-value-SECRET-MARKER into evil.example',
      foreground: { ...FACTS.foreground, comm: 'sudo', argv: 'sudo --evil-argv-marker' },
    };
    const plain = await raised({ facts: UNPROVEN });
    const steering = await raised({ facts: hostile });

    // Act
    const sentence = (request: typeof plain.request) => request.risk;

    // Assert — the same fixed sentence for both, and none of the terminal's words in anything the card holds
    should(sentence(steering.request)).eql(sentence(plain.request));
    should(sentence(steering.request)?.reason).be.a.String();
    const card = JSON.stringify(sentence(steering.request));
    should(card).not.containEql('SECRET-MARKER');
    should(card).not.containEql('evil');
  });
});

describe('who raises, and what a Send is checked against (I33, I42)', () => {
  it('I33 an owner’s Send after the ferret typed is checked against the target like any other', async () => {
    // Arrange — a code card on an OTP prompt; the ferret typed and the foreground moved on
    let facts: InputTargetFacts = OTP;
    const { service, writes, id, digest } = await raised(
      { facts: () => facts },
      { ...RAISE, prompt: 'The bastion wants the 2FA code', sensitivity: 'code', submit: 'offer-owner' },
    );
    facts = {
      ...OTP,
      foreground: { ...OTP.foreground, comm: 'bash', argv: 'bash' },
      program: 'bash',
    } as InputTargetFacts;

    // Act
    const error = await refused(service.deliver(SESSION, id, send(digest, { value: '123456' }), HOST));

    // Assert — refused as target_changed, nothing typed; the same Send on the unchanged prompt types
    should(error.reason).equal('target_changed');
    should(writes).eql([]);
    facts = OTP;
    should((await service.deliver(SESSION, id, send(digest, { value: '123456' }), HOST)).state).equal('delivered');
    should(writes).eql(['123456']);
  });

  it('I39 a code field found going into a password at the write gets no daemon-made code: refused, nothing typed, a secret from then on', async () => {
    // Arrange — a code the daemon makes for an account that signs in at ssh bastion; a program it proved reads the code
    let proved = true;
    const filled: string[] = [];
    const logins = {
      listing: async () => ({
        accounts: [
          {
            id: 'BASTION',
            label: 'bastion',
            fields: { password: false },
            factors: [
              {
                id: 'tf_0000000000a1',
                kind: 'totp',
                label: 'App',
                addedAt: 'a',
                addedBy: 'owner',
                automatic: true,
                params: { algorithm: 'SHA1', digits: 6, period: 30 },
              },
            ],
            signIns: ['si_00000000000000b1'],
            createdAt: 'a',
            updatedAt: 'a',
          },
        ],
        signIns: [
          {
            id: 'si_00000000000000b1',
            account: 'BASTION',
            place: { kind: 'terminal', tool: 'ssh', host: 'box', dest: 'bastion' },
            method: { kind: 'password' },
            createdAt: 'a',
            updatedAt: 'a',
          },
        ],
      }),
      fill: async (entry: string, role: string) => {
        filled.push(`${entry}:${role}`);
        return '123456';
      },
      save: async () => undefined,
    } as unknown as NonNullable<Parameters<typeof inputRequestService>[0]>['logins'];
    const { service, writes, id, digest } = await raised(
      { facts: { ...OTP, echo: 'off' } as InputTargetFacts, codeProgram: () => proved, logins },
      { ...RAISE, prompt: 'The bastion wants the 2FA code', sensitivity: 'code', submit: 'offer-owner' },
    );
    proved = false;

    // Act — the owner taps the code Ferretry makes; the daemon no longer proves a code program reads it
    const error = await refused(service.deliver(SESSION, id, send(digest, { entry: 'BASTION' }), HOST));
    const [card] = await service.list(HOST);

    // Assert
    should(error.code).equal('bad_request');
    should(error.message).containEql('never types a code it made');
    should(writes).eql([]);
    should(filled).eql([]);
    should(card?.fields[0]?.sensitivity).equal('secret');
    should(card?.sensitivity).equal('secret');
  });

  it('I42 no route raises a request, and the service raises only on the surfaces of the session it is told it is raising for', async () => {
    // Arrange — the REAL terminal adapter in front of a Terminals stand-in that, like Terminals' own `observe(ferret, …)`,
    // answers `target_gone` for a surface the ferret it is handed did not open. `dev` is the raising session's.
    const looked: string[] = [];
    const owned: Readonly<Record<string, string>> = { dev: SESSION, theirs: 'someone-elses-ferret' };
    const provider: TargetProvider = kind =>
      kind !== 'terminal'
        ? undefined
        : ({
            observe: async (ferret: string, target: { key: string }) => {
              looked.push(`${ferret}:${target.key}`);
              return owned[target.key] === ferret
                ? { ok: true as const, facts: FACTS }
                : { ok: false as const, reason: 'target_gone' as const };
            },
          } as unknown as InputTargetAdapter);
    const target = new TerminalTargetThroughHook(provider) as unknown as InputTargetPort;
    const { service } = inputRequestService({ target });

    // Act
    await service.raise(SESSION, RAISE);
    const foreign = await refused(service.raise(SESSION, { ...RAISE, target: { kind: 'terminal', key: 'theirs' } }));
    const cards = await service.list(HOST);

    // Assert — the adapter hands Terminals the RAISING session's ferret; a surface of another ferret is refused and no
    // card is raised for it
    should(looked).eql([`${SESSION}:dev`, `${SESSION}:theirs`]);
    should(foreign).be.instanceOf(InputRequestError);
    should(cards.map(card => card.target.key)).eql(['dev']);

    // And the manifest offers an owner no way to raise
    const raising = manifest.actions.routes
      .map(route => route.key)
      .filter(key => !key.startsWith('GET ') && /input-requests$/u.test(key));
    should(raising).eql([]);
    should(manifest.actions.agentTools.map(tool => tool.name)).eql(['input_wait']);
  });
});
