import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import {
  AGENT_TOOL_NAMES,
  AgentToolCallSchema,
  AgentToolResultSchema,
  isRepeatableAgentTool,
} from '../../src/lib/agent-tools.ts';
import { InputActorSchema, InputDeliverBodySchema, InputSourceSchema } from '../../src/lib/input-request.ts';
import {
  COPY_COMMAND_MAX_ARGS,
  COPY_MAX_LIFETIME_SECONDS,
  CopyCaptureSchema,
  CopyCommandReportSchema,
  CopyHandleSchema,
  CopyMetaSchema,
  CopyNameSchema,
  CopyOriginSchema,
  CopyPlanApproveSchema,
  CopyPlanItemSchema,
  CopyPlanSchema,
  CopyRouteFromSchema,
  CopyRouteToSchema,
  CopySourceSchema,
  copyHandle,
  copyMask,
  PasteRuleCreateSchema,
  PasteRuleSchema,
} from '../../src/lib/secure-copy.ts';

const AT = '2026-10-31T09:00:00.000Z';

const META = {
  handle: 'sealed:vercel_token',
  name: 'vercel_token',
  from: { kind: 'command', program: 'gh' },
  length: 40,
  lines: 1,
  capturedAt: AT,
  expiresAt: AT,
  state: 'live',
  exposure: { transcript: 'clean' },
  uses: 0,
} as const;

describe('secure copy names and handles', () => {
  it('should take a short lowercase name and refuse anything else', () => {
    for (const name of ['token', 'vercel_token', 'a-1', 'a'.repeat(40)])
      should(CopyNameSchema.safeParse(name).success).be.true();
    for (const name of ['', 'Token', '1token', 'tok en', 'a'.repeat(41), 'sealed:token'])
      should(CopyNameSchema.safeParse(name).success).be.false();
  });

  it('should read a handle written as sealed:<name> or as the bare name', () => {
    should(CopyHandleSchema.parse('sealed:token')).equal('token');
    should(CopyHandleSchema.parse(' token ')).equal('token');
    should(CopyHandleSchema.safeParse('sealed:').success).be.false();
    should(copyHandle('token')).equal('sealed:token');
    should(copyMask('token')).equal('[sealed:token]');
  });
});

describe('where a copy is read from', () => {
  it('should take a command as an argument list, with no shell', () => {
    const parsed = CopySourceSchema.parse({ kind: 'command', argv: ['gh', 'auth', 'token'] });

    should(parsed).eql({ kind: 'command', argv: ['gh', 'auth', 'token'] });
    should(CopySourceSchema.safeParse({ kind: 'command', argv: [] }).success).be.false();
    should(
      CopySourceSchema.safeParse({
        kind: 'command',
        argv: Array.from({ length: COPY_COMMAND_MAX_ARGS + 1 }, () => 'x'),
      }).success,
    ).be.false();
    should(CopySourceSchema.safeParse({ kind: 'command', argv: ['gh'], shell: 'gh auth token' }).success).be.false();
    should(CopySourceSchema.safeParse({ kind: 'command', argv: ['gh'], timeoutSeconds: 61 }).success).be.false();
  });

  it('should name a page element by ref or selector, exactly one, and an attribute only when reading one', () => {
    should(CopySourceSchema.parse({ kind: 'browser', key: '%browser:app', ref: 'e12' })).eql({
      kind: 'browser',
      key: 'app',
      ref: 'e12',
      read: 'text',
    });
    should(CopySourceSchema.safeParse({ kind: 'browser', key: 'app' }).success).be.false();
    should(CopySourceSchema.safeParse({ kind: 'browser', key: 'app', ref: 'e1', selector: '#t' }).success).be.false();
    should(
      CopySourceSchema.safeParse({ kind: 'browser', key: 'app', ref: 'e1', read: 'attribute' }).success,
    ).be.false();
    should(
      CopySourceSchema.safeParse({ kind: 'browser', key: 'app', ref: 'e1', read: 'text', attribute: 'data-token' })
        .success,
    ).be.false();
    should(
      CopySourceSchema.safeParse({ kind: 'browser', key: 'app', selector: '#t', read: 'attribute', attribute: 'value' })
        .success,
    ).be.true();
    should(CopySourceSchema.safeParse({ kind: 'clipboard', key: 'app' }).success).be.true();
  });

  it("should bound a capture's life", () => {
    const source = { kind: 'command', argv: ['true'] };
    should(CopyCaptureSchema.safeParse({ name: 'a', source, expiresInSeconds: 59 }).success).be.false();
    should(
      CopyCaptureSchema.safeParse({ name: 'a', source, expiresInSeconds: COPY_MAX_LIFETIME_SECONDS }).success,
    ).be.true();
    should(
      CopyCaptureSchema.safeParse({ name: 'a', source, expiresInSeconds: COPY_MAX_LIFETIME_SECONDS + 1 }).success,
    ).be.false();
  });
});

describe('the secure copy agent tools', () => {
  it('should parse secure.copy, secure.list and secure.discard', () => {
    should(
      AgentToolCallSchema.parse({ tool: 'secure.copy', name: 'token', source: { kind: 'command', argv: ['gh'] } }),
    ).eql({ tool: 'secure.copy', name: 'token', source: { kind: 'command', argv: ['gh'] } });
    should(AgentToolCallSchema.parse({ tool: 'secure.list' })).eql({ tool: 'secure.list' });
    should(AgentToolCallSchema.parse({ tool: 'secure.discard', handle: 'sealed:token' })).eql({
      tool: 'secure.discard',
      handle: 'token',
    });
    should(
      AgentToolCallSchema.safeParse({
        tool: 'secure.copy',
        name: 'token',
        source: { kind: 'command', argv: ['gh'] },
        value: 'x',
      }).success,
    ).be.false();
  });

  it('should list them, and let only the listing repeat after a dropped request', () => {
    should(AGENT_TOOL_NAMES).containEql('secure.copy');
    should(AGENT_TOOL_NAMES).containEql('secure.list');
    should(AGENT_TOOL_NAMES).containEql('secure.discard');
    should(isRepeatableAgentTool('secure.list')).be.true();
    should(isRepeatableAgentTool('secure.copy')).be.false();
    should(isRepeatableAgentTool('secure.discard')).be.false();
  });

  it('should carry copies and a command report in a result', () => {
    should(
      AgentToolResultSchema.safeParse({
        summary: 'Sealed.',
        copies: [META],
        command: { outcome: 'exited', exitCode: 0, stderr: 'warning: [sealed:token]' },
      }).success,
    ).be.true();
  });
});

describe('the secure copy schemas never hold a value', () => {
  // `length` is the one count the brief makes visible (docs/secure-copy.md); everything else that could be a value fails.
  const VALUE_LIKE =
    /^(value|values|password|passphrase|passwd|pin|otp|code|token|secret|secrets|text|typed|plaintext|keys|keystrokes|content|data|body|input|answer|response|raw|padded|size|bytes|digest|stdout|output|prefix|suffix|hash)$/iu;

  type Node = Record<string, unknown>;
  const walk = (node: unknown, visit: (node: Node) => void): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
      return;
    }
    visit(node as Node);
    for (const child of Object.values(node as Node)) walk(child, visit);
  };
  const propertyNames = (schema: z.ZodType): string[] => {
    const names: string[] = [];
    walk(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), node => {
      const properties = node.properties;
      if (properties !== null && typeof properties === 'object') names.push(...Object.keys(properties));
    });
    return names;
  };

  for (const [name, schema] of [
    ['CopyMeta', CopyMetaSchema],
    ['CopyOrigin', CopyOriginSchema],
    ['CopyCommandReport', CopyCommandReportSchema],
    ['CopyCapture', CopyCaptureSchema],
  ] as const) {
    it(`should give ${name} no field named or shaped like a value`, () => {
      should(propertyNames(schema).filter(property => VALUE_LIKE.test(property))).deepEqual([]);
    });
  }

  it("should reject a value smuggled into a copy's description or its origin", () => {
    should(CopyMetaSchema.safeParse({ ...META, value: 'ghp_x' }).success).be.false();
    should(CopyOriginSchema.safeParse({ kind: 'command', program: 'gh', argv: 'gh auth token' }).success).be.false();
    should(CopyCommandReportSchema.safeParse({ outcome: 'exited', stdout: 'ghp_x' }).success).be.false();
  });

  it('should bound the masked stderr a command report carries', () => {
    should(CopyCommandReportSchema.safeParse({ outcome: 'exited', stderr: 'x'.repeat(2_049) }).success).be.false();
  });
});

describe('pasting, rules and plans', () => {
  it('should take a deliver body with exactly one of padded, entry or sealed, and save only a typed value', () => {
    const base = { deliveryId: '7b0a5f1c-3a49-4a7e-9d69-2f2a7f6c2e11', observedDigest: 'c'.repeat(64), submit: true };

    should(InputDeliverBodySchema.safeParse({ ...base, sealed: true }).success).be.true();
    should(InputDeliverBodySchema.safeParse({ ...base, sealed: true, padded: '00005:hello' }).success).be.false();
    should(InputDeliverBodySchema.safeParse({ ...base, sealed: true, entry: 'SUDO_BOX' }).success).be.false();
    should(InputDeliverBodySchema.safeParse({ ...base, sealed: false }).success).be.false();
    should(
      InputDeliverBodySchema.safeParse({ ...base, sealed: true, save: { entry: 'SUDO_BOX', label: 'x' } }).success,
    ).be.false();
    should(InputDeliverBodySchema.safeParse(base).success).be.false();
  });

  it("should name a rule's ends by program, origin or exact secret name, and nothing looser", () => {
    should(CopyRouteFromSchema.safeParse({ kind: 'command', program: '/usr/bin/gh' }).success).be.false();
    should(
      CopyRouteFromSchema.safeParse({ kind: 'browser', origin: 'https://github.com/settings/tokens' }).success,
    ).be.false();
    should(CopyRouteToSchema.safeParse({ kind: 'secret', name: 'vercel_token' }).success).be.false();
    should(CopyRouteToSchema.safeParse({ kind: 'secret' }).success).be.false();
    should(CopyRouteToSchema.safeParse({ kind: 'terminal', program: 'vercel' }).success).be.true();
    should(
      PasteRuleCreateSchema.safeParse({
        from: { kind: 'command', program: 'gh' },
        to: { kind: 'terminal', program: 'vercel' },
        count: 0,
      }).success,
    ).be.false();
  });

  it('should hold a plan to its item cap and its words to one bounded line', () => {
    const item = {
      from: { kind: 'command', program: 'gh' },
      to: { kind: 'terminal', program: 'vercel' },
      why: 'token',
    };

    should(CopyPlanItemSchema.safeParse({ ...item, why: 'two\nlines' }).success).be.false();
    should(CopyPlanItemSchema.safeParse({ ...item, why: 'x'.repeat(141) }).success).be.false();
    should(
      AgentToolCallSchema.safeParse({ tool: 'secure.preapprove', items: Array.from({ length: 11 }, () => item) })
        .success,
    ).be.false();
    should(CopyPlanApproveSchema.safeParse({ items: [10] }).success).be.false();
  });

  it("should give a rule, a plan and an input request's source no field for a value", () => {
    const VALUE_LIKE = /^(value|values|token|secret|text|content|data|raw|padded|stdout|digest)$/iu;
    const names = (schema: z.ZodType): string[] => {
      const found: string[] = [];
      const walk = (node: unknown): void => {
        if (node === null || typeof node !== 'object') return;
        const properties = (node as { properties?: object }).properties;
        if (properties !== undefined) found.push(...Object.keys(properties));
        for (const child of Object.values(node as object)) walk(child);
      };
      walk(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }));
      return found;
    };

    for (const schema of [PasteRuleSchema, CopyPlanSchema, InputSourceSchema, PasteRuleCreateSchema])
      should(names(schema).filter(name => VALUE_LIKE.test(name))).eql([]);
    should(InputActorSchema.safeParse({ kind: 'rule', ruleId: 'a'.repeat(32) }).success).be.true();
    should(InputActorSchema.safeParse({ kind: 'rule', ruleId: 'x' }).success).be.false();
  });
});

describe('a plan the agent asks for', () => {
  it('should last at most a day, however long the agent asks', () => {
    const items = [
      { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' }, why: 'token' },
    ];

    should(
      AgentToolCallSchema.safeParse({ tool: 'secure.preapprove', items, expiresInSeconds: 86_400 }).success,
    ).be.true();
    should(
      AgentToolCallSchema.safeParse({ tool: 'secure.preapprove', items, expiresInSeconds: 86_401 }).success,
    ).be.false();
  });
});
