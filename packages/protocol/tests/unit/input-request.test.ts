import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { AgendaItemSchema } from '../../src/lib/agenda.ts';
import { AgentToolCallSchema } from '../../src/lib/agent-tools.ts';
import { AUDIT_EVENTS } from '../../src/lib/audit.ts';
import {
  INPUT_AUDIT_EVENTS,
  INPUT_DEFAULT_EXPIRY_SECONDS,
  INPUT_JOURNAL_EVENT_TYPES,
  INPUT_MAX_EXPIRY_SECONDS,
  INPUT_PAD_BUCKET_BYTES,
  INPUT_VALUE_MAX_BYTES,
  InputAgentViewSchema,
  InputAuditDetailSchema,
  InputCancelBodySchema,
  InputDeliverBodySchema,
  InputDeliverResultSchema,
  InputEventSchema,
  InputOutcomeSchema,
  InputRaiseSchema,
  InputRequestListSchema,
  InputRequestSchema,
  InputTargetFactsSchema,
  inputValueProblem,
  padInputValue,
  unpadInputValue,
} from '../../src/lib/input-request.ts';

const ID = 'b'.repeat(32);
const DIGEST = 'c'.repeat(64);
const AT = '2026-10-30T09:00:00.000Z';
const DELIVERY = '7b0a5f1c-3a49-4a7e-9d69-2f2a7f6c2e11';

const TERMINAL_FACTS = {
  kind: 'terminal',
  paneProof: { paneId: '%12', pid: 4121, sessionCreated: 1_761_800_000 },
  foreground: { pid: 4121, pgid: 4121, comm: 'sudo', argv: 'sudo nixos-rebuild switch' },
  echo: 'off',
  cursorRow: 14,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: DIGEST,
  recognisedConsumer: true,
} as const;

const BROWSER_FACTS = {
  kind: 'browser',
  pageId: 'page-1',
  origin: 'https://github.com',
  secure: true,
  frameOrigin: 'https://github.com',
  navigationId: 'nav-9',
  backendNodeId: 77,
  field: { tag: 'input', type: 'password', autocomplete: 'current-password', name: 'password' },
  box: { x: 10, y: 20, w: 300, h: 40 },
  visible: true,
} as const;

const REQUEST = {
  id: ID,
  sessionId: 'mvv6b4qw-49d0158d',
  agendaItemId: 'A7',
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo for the rebuild',
  sensitivity: 'secret',
  submit: 'owner-default',
  raisedAt: AT,
  expiresAt: '2026-10-30T09:10:00.000Z',
  observed: TERMINAL_FACTS,
  observedDigest: DIGEST,
  state: 'pending',
} as const;

const EVENT = {
  type: INPUT_JOURNAL_EVENT_TYPES.delivered,
  requestId: ID,
  agendaItemId: 'A7',
  sessionId: 's1',
  target: { kind: 'terminal', key: 'dev' },
  sensitivity: 'secret',
  state: 'delivered',
  submitted: true,
  source: 'typed',
  at: AT,
} as const;

describe('raising an input request', () => {
  it('should take only what the agent says, with the owner offered Enter by default', () => {
    // Arrange / Act
    const parsed = InputRaiseSchema.parse({
      target: { kind: 'terminal', key: '%terminal:dev' },
      prompt: 'sudo for the rebuild',
      sensitivity: 'secret',
    });

    // Assert
    should(parsed.target).deepEqual({ kind: 'terminal', key: 'dev' });
    should(parsed.submit).equal('offer-owner');
  });

  it('should refuse anything the agent could use to claim what the daemon observes', () => {
    for (const extra of [{ observed: TERMINAL_FACTS }, { echo: 'off' }, { origin: 'https://github.com' }]) {
      should(
        InputRaiseSchema.safeParse({
          target: { kind: 'terminal', key: 'dev' },
          prompt: 'p',
          sensitivity: 'secret',
          ...extra,
        }).success,
      ).be.false();
    }
  });

  it('should bound the prompt, the lifetime and the browser selector', () => {
    const base = { target: { kind: 'terminal', key: 'dev' }, prompt: 'p', sensitivity: 'plain' } as const;

    should(InputRaiseSchema.safeParse({ ...base, prompt: 'x'.repeat(281) }).success).be.false();
    should(InputRaiseSchema.safeParse({ ...base, expiresInSeconds: INPUT_MAX_EXPIRY_SECONDS + 1 }).success).be.false();
    should(InputRaiseSchema.safeParse({ ...base, expiresInSeconds: INPUT_MAX_EXPIRY_SECONDS }).success).be.true();
    should(
      InputRaiseSchema.safeParse({
        ...base,
        target: { kind: 'browser', key: 'app', selector: 'x'.repeat(513) },
      }).success,
    ).be.false();
    should(INPUT_DEFAULT_EXPIRY_SECONDS).be.below(INPUT_MAX_EXPIRY_SECONDS);
  });
});

describe('an input request', () => {
  it('should read back what the daemon wrote, with terminal facts', () => {
    should(InputRequestSchema.safeParse(REQUEST).success).be.true();
  });

  it('should read a request still being re-observed after a restart, with no facts', () => {
    const { observed: _observed, observedDigest: _digest, ...reobserving } = REQUEST;

    should(InputRequestSchema.safeParse(reobserving).success).be.true();
  });

  it('should carry browser facts only as the browser itself reported them', () => {
    should(InputTargetFactsSchema.safeParse(BROWSER_FACTS).success).be.true();
    should(InputTargetFactsSchema.safeParse({ ...BROWSER_FACTS, extra: 1 }).success).be.false();
  });

  it('should refuse an unknown state, a short id and a request with a field of its own making', () => {
    should(InputRequestSchema.safeParse({ ...REQUEST, state: 'typing' }).success).be.false();
    should(InputRequestSchema.safeParse({ ...REQUEST, id: 'abc' }).success).be.false();
    should(InputRequestSchema.safeParse({ ...REQUEST, note: 'hi' }).success).be.false();
  });

  it('should name the saved secret of an outcome by NAME only', () => {
    const outcome = { at: AT, by: { kind: 'host' }, submitted: true, source: 'saved', secretName: 'SUDO_KIRIN_BOX' };

    should(InputOutcomeSchema.safeParse(outcome).success).be.true();
    should(InputOutcomeSchema.safeParse({ ...outcome, secretName: 'hunter2 with spaces' }).success).be.false();
  });

  it('should tell the agent where it stands without a value, a length or a saved secret name', () => {
    const view = { id: 'A7', state: 'delivered', submitted: true, source: 'saved', screen: 'building…' };

    should(InputAgentViewSchema.safeParse(view).success).be.true();
    should(InputAgentViewSchema.safeParse({ ...view, secretName: 'SUDO_KIRIN_BOX' }).success).be.false();
    should(InputAgentViewSchema.safeParse({ ...view, length: 8 }).success).be.false();
  });
});

describe('the events and the audit detail', () => {
  it('should publish one journal event per move, by the closed list of types', () => {
    should(InputEventSchema.safeParse(EVENT).success).be.true();
    should(InputEventSchema.safeParse({ ...EVENT, type: 'surface.input_typed' }).success).be.false();
    should(
      InputEventSchema.safeParse({ ...EVENT, type: 'surface.input_delivering', deliveryId: DELIVERY }).success,
    ).be.true();
    should(InputEventSchema.safeParse({ ...EVENT, deliveryId: 'not a delivery id' }).success).be.false();
    should(Object.values(INPUT_JOURNAL_EVENT_TYPES)).deepEqual([
      'surface.input_requested',
      'surface.input_delivering',
      'surface.input_delivered',
      'surface.input_refused',
      'surface.input_expired',
      'surface.input_cancelled',
    ]);
  });

  it('should carry names and flags in an audit detail, nothing else', () => {
    const detail = {
      targetKind: 'terminal',
      consumer: 'sudo',
      sensitivity: 'secret',
      recognised: true,
      submitted: true,
    };

    should(InputAuditDetailSchema.safeParse(detail).success).be.true();
    should(InputAuditDetailSchema.safeParse({ ...detail, prompt: '[sudo] password for kirin:' }).success).be.false();
  });
});

describe('delivering', () => {
  const body = { deliveryId: DELIVERY, observedDigest: DIGEST, padded: padInputValue('hunter2-UNIQUE'), submit: true };

  it('should carry the padded value or a saved secret NAME, exactly one', () => {
    should(InputDeliverBodySchema.safeParse(body).success).be.true();
    should(
      InputDeliverBodySchema.safeParse({
        deliveryId: DELIVERY,
        observedDigest: DIGEST,
        secretName: 'SUDO_X',
        submit: false,
      }).success,
    ).be.true();
    should(InputDeliverBodySchema.safeParse({ ...body, secretName: 'SUDO_X' }).success).be.false();
    should(
      InputDeliverBodySchema.safeParse({ deliveryId: DELIVERY, observedDigest: DIGEST, submit: true }).success,
    ).be.false();
  });

  it('should allow saving only a typed value', () => {
    should(InputDeliverBodySchema.safeParse({ ...body, saveAs: 'SUDO_KIRIN_BOX' }).success).be.true();
    should(
      InputDeliverBodySchema.safeParse({
        deliveryId: DELIVERY,
        observedDigest: DIGEST,
        secretName: 'SUDO_X',
        submit: true,
        saveAs: 'SUDO_Y',
      }).success,
    ).be.false();
  });

  it('should refuse a delivery id that is not a UUID and a body with a plain value field', () => {
    should(InputDeliverBodySchema.safeParse({ ...body, deliveryId: 'again' }).success).be.false();
    should(InputDeliverBodySchema.safeParse({ ...body, value: 'hunter2' }).success).be.false();
  });

  it('should answer with the outcome and no value, and take an empty cancel', () => {
    should(
      InputDeliverResultSchema.safeParse({ id: ID, deliveryId: DELIVERY, state: 'delivered', submitted: true }).success,
    ).be.true();
    should(InputCancelBodySchema.safeParse({}).success).be.true();
    should(InputCancelBodySchema.safeParse({ reason: 'x' }).success).be.false();
  });
});

describe('padding a value for the wire', () => {
  it('should round every value up to a bucket and read it back', () => {
    for (const value of [
      'a',
      'hunter2-UNIQUE',
      'p'.repeat(250),
      'p'.repeat(251),
      'ü'.repeat(300),
      'p'.repeat(INPUT_VALUE_MAX_BYTES),
    ]) {
      const padded = padInputValue(value);

      should(new TextEncoder().encode(padded).length % INPUT_PAD_BUCKET_BYTES).equal(0);
      should(unpadInputValue(padded)).equal(value);
    }
  });

  it('should make a short password and a long one the same size', () => {
    should(padInputValue('a').length).equal(padInputValue('p'.repeat(200)).length);
  });

  it('should keep a value with trailing spaces whole', () => {
    should(unpadInputValue(padInputValue('pass  '))).equal('pass  ');
  });

  it('should refuse a value over the limit', () => {
    should(() => padInputValue('p'.repeat(INPUT_VALUE_MAX_BYTES + 1))).throw(RangeError);
  });

  it('should read nothing from a string that is not exactly what padding writes', () => {
    const good = padInputValue('hunter2');

    should(unpadInputValue('')).be.undefined();
    should(unpadInputValue('hunter2')).be.undefined();
    should(unpadInputValue(good.slice(0, -1))).be.undefined();
    should(unpadInputValue(`${good.slice(0, -1)}x`)).be.undefined();
    should(unpadInputValue(good.replace('00007', '09999'))).be.undefined();
    should(unpadInputValue(good.replace('00007:', '0000x:'))).be.undefined();
    should(unpadInputValue('é'.repeat(256))).be.undefined();
    should(unpadInputValue(`${good}${' '.repeat(256)}`)).be.undefined();
  });
});

describe('what may be typed', () => {
  it('should refuse a control character or a line break for a secret or a private value', () => {
    for (const sensitivity of ['secret', 'private'] as const) {
      should(inputValueProblem('pass\nword', sensitivity)).containEql('press keys');
      should(inputValueProblem('pass\u001b[A', sensitivity)).containEql('press keys');
      should(inputValueProblem('pass\tword', sensitivity)).containEql('press keys');
    }
  });

  it('should allow a Tab in a plain value and any printable text, including non-ASCII', () => {
    should(inputValueProblem('a\tb', 'plain')).be.undefined();
    should(inputValueProblem('pässwörd 密码 🔑', 'secret')).be.undefined();
  });

  it('should refuse an empty value, and one over the byte limit, for every sensitivity', () => {
    for (const sensitivity of ['secret', 'private', 'plain'] as const) {
      should(inputValueProblem('', sensitivity)).be.a.String();
      should(inputValueProblem('p'.repeat(INPUT_VALUE_MAX_BYTES + 1), sensitivity)).containEql('bytes');
    }
  });
});

/**
 * THE "SCHEMA HAS NO VALUE FIELD" TEST. It reads each schema's JSON shape, so a new field fails here
 * whoever adds it and however it is nested.
 */
describe('the schemas that must never hold a value', () => {
  const VALUE_LIKE =
    /^(value|values|password|passphrase|passwd|pin|otp|code|token|secret|secrets|text|typed|plaintext|keys|keystrokes|content|data|body|input|answer|response|raw|padded|length|size|bytes|digest)$/iu;

  type Node = Record<string, unknown>;

  const walk = (node: unknown, visit: (node: Node, path: string) => void, path = '$'): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) walk(child, visit, `${path}[${index}]`);
      return;
    }
    const record = node as Node;
    visit(record, path);
    for (const [key, child] of Object.entries(record)) walk(child, visit, `${path}.${key}`);
  };

  const shapeOf = (schema: z.ZodType): Node =>
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as Node;

  const propertyNames = (schema: z.ZodType): string[] => {
    const names: string[] = [];
    walk(shapeOf(schema), node => {
      const properties = node.properties;
      if (properties !== null && typeof properties === 'object') names.push(...Object.keys(properties));
    });
    return names;
  };

  const unboundedStrings = (schema: z.ZodType): string[] => {
    const found: string[] = [];
    walk(shapeOf(schema), (node, path) => {
      const bounded =
        node.maxLength !== undefined ||
        node.enum !== undefined ||
        node.const !== undefined ||
        node.format !== undefined ||
        node.pattern !== undefined;
      if (
        node.type === 'string' &&
        !bounded &&
        !path.endsWith('.properties.key') &&
        !path.endsWith('.properties.surface')
      )
        found.push(path);
    });
    return found;
  };

  const WITHOUT_VALUE: ReadonlyArray<readonly [string, z.ZodType]> = [
    ['InputRequest', InputRequestSchema],
    ['InputTargetFacts', InputTargetFactsSchema],
    ['InputRaise', InputRaiseSchema],
    ['InputOutcome', InputOutcomeSchema],
    ['InputAgentView', InputAgentViewSchema],
    ['InputEvent', InputEventSchema],
    ['InputAuditDetail', InputAuditDetailSchema],
    ['InputDeliverResult', InputDeliverResultSchema],
    ['InputCancelBody', InputCancelBodySchema],
    ['AgendaItem', AgendaItemSchema],
  ];

  for (const [name, schema] of WITHOUT_VALUE) {
    it(`should give ${name} no field named or shaped like a value`, () => {
      const offenders = propertyNames(schema).filter(property => VALUE_LIKE.test(property));
      const allowedElsewhere =
        name === 'AgendaItem' ? new Set(['body', 'data', 'response', 'answer', 'input']) : new Set<string>();

      should(offenders.filter(property => !allowedElsewhere.has(property))).deepEqual([]);
    });

    it(`should bound every string ${name} carries, so there is nowhere to put a blob`, () => {
      const unbounded = unboundedStrings(schema);

      should(unbounded.filter(path => name !== 'AgendaItem' || path.includes('input'))).deepEqual([]);
    });
  }

  it('should keep the agenda item’s input pointer to the request id alone', () => {
    const shape = shapeOf(AgendaItemSchema);
    const found: string[][] = [];
    walk(shape, node => {
      const input = (node.properties as Node | undefined)?.input as Node | undefined;
      if (input?.properties !== undefined) found.push(Object.keys(input.properties as Node));
    });

    should(found.length).be.above(0);
    for (const names of found) should(names).deepEqual(['requestId']);
  });

  it('should hold the value in exactly one place: the deliver body, padded', () => {
    should(propertyNames(InputDeliverBodySchema).filter(property => VALUE_LIKE.test(property))).deepEqual(['padded']);
  });

  it('should reject a value smuggled into any of them', () => {
    const smuggled = { ...REQUEST, value: 'hunter2-UNIQUE' };

    should(InputRequestSchema.safeParse(smuggled).success).be.false();
    should(InputEventSchema.safeParse({ ...EVENT, value: 'hunter2-UNIQUE' }).success).be.false();
    should(
      InputAuditDetailSchema.safeParse({ targetKind: 'terminal', sensitivity: 'secret', value: 'x' }).success,
    ).be.false();
    should(
      InputOutcomeSchema.safeParse({ at: AT, by: { kind: 'host' }, submitted: true, source: 'typed', value: 'x' })
        .success,
    ).be.false();
  });

  it('should audit only events the closed audit list knows', () => {
    for (const event of INPUT_AUDIT_EVENTS) should(AUDIT_EVENTS).containEql(event);
  });

  it('should accept the two agent input tools and refuse an unknown field on either', () => {
    const raise = { tool: 'terminal.request_input', name: 'dev', prompt: 'sudo password', sensitivity: 'secret' };

    should(AgentToolCallSchema.parse(raise).tool).equal('terminal.request_input');
    should(AgentToolCallSchema.safeParse({ ...raise, value: 'x' }).success).be.false();
    should(AgentToolCallSchema.parse({ tool: 'input.wait', id: '!A7' })).deepEqual({ tool: 'input.wait', id: 'A7' });
    should(AgentToolCallSchema.safeParse({ tool: 'input.wait', id: 'A7', value: 'x' }).success).be.false();
  });

  it('should list requests and refuse a list that carries anything else', () => {
    should(InputRequestListSchema.parse({ requests: [] })).deepEqual({ requests: [] });
    should(InputRequestListSchema.safeParse({ requests: [], value: 'x' }).success).be.false();
  });
});
