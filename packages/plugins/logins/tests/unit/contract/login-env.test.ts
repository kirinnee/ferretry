import { describe, it } from 'bun:test';
import should from 'should';
import { AgentConfigCallSchema } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { agentConfig } from '../../../../../core/kernel/host/config/agent.ts';
import { checkConfigText } from '../../../../../core/kernel/host/config/check.ts';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../../core/kernel/host/state/memory-fs.ts';
import {
  LOGINS_CONFIG,
  LoginChangeSchema,
  LoginFileSchema,
  LoginHalfSchema,
  RESERVED_LOGIN_ENV_NAMES,
} from '../../../contract/index.ts';

// (no guarantees row) A login's environment may not set a variable Ferretry sets, nor hold a malformed secret reference.

const HOME = '/logins-test-only';
const SILENT = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT,
};

const SECRET_VALUE = 'sk-live-should-never-be-echoed';

const refusal = (result: {
  success: boolean;
  error?: { issues: readonly { message: string; path: PropertyKey[] }[] };
}) => {
  should(result.success).be.false();
  return result.error?.issues ?? [];
};

describe('a login environment', () => {
  for (const name of RESERVED_LOGIN_ENV_NAMES) {
    it(`should refuse ${name} in a login file, a harness half, login.add and login.env, naming the key only`, () => {
      const env = { [name]: SECRET_VALUE };
      const results = [
        LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }),
        LoginHalfSchema.safeParse({ env }),
        LoginChangeSchema.safeParse({
          kind: 'login.add',
          id: 'work',
          harness: 'claude-code',
          store: 'environment',
          env,
        }),
        LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env }),
      ];
      for (const result of results) {
        const issues = refusal(result);
        should(issues.some(issue => issue.message.includes(`"${name}" is reserved`))).be.true();
        should(JSON.stringify(issues)).not.containEql(SECRET_VALUE);
      }
    });
  }

  it('should refuse a malformed secret reference everywhere, naming the key and not the value', () => {
    const env = { API_KEY: '${secret:work_key}' };
    const results = [
      LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }),
      LoginHalfSchema.safeParse({ env }),
      LoginChangeSchema.safeParse({ kind: 'login.add', id: 'work', harness: 'claude-code', store: 'environment', env }),
      LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env }),
    ];
    for (const result of results) {
      const issues = refusal(result);
      should(issues.some(issue => issue.message.includes('"API_KEY" holds a malformed secret reference'))).be.true();
      should(JSON.stringify(issues)).not.containEql('work_key');
    }
  });

  it('should refuse a non-POSIX name in a login file, a harness half, login.add and login.env, naming the key only', () => {
    for (const bad of ['BAD-NAME', 'A=B', '1ST']) {
      const env = { [bad]: SECRET_VALUE };
      const results = [
        LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }),
        LoginHalfSchema.safeParse({ env }),
        LoginChangeSchema.safeParse({
          kind: 'login.add',
          id: 'work',
          harness: 'claude-code',
          store: 'environment',
          env,
        }),
        LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env }),
      ];
      for (const result of results) {
        const issues = refusal(result);
        should(issues.some(issue => issue.message === `"${bad}" must be a POSIX environment variable name`)).be.true();
        should(JSON.stringify(issues)).not.containEql(SECRET_VALUE);
      }
    }
  });

  it('should report both a bad name and a reserved name when a file has both', () => {
    const env = { 'BAD-NAME': 'x', CODEX_HOME: 'y' };
    const messages = refusal(LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env })).map(
      issue => issue.message,
    );
    should(messages.some(m => m.includes('"BAD-NAME" must be a POSIX environment variable name'))).be.true();
    should(messages.some(m => m.includes('"CODEX_HOME" is reserved'))).be.true();
  });

  it('should accept ordinary variables, a well-formed secret reference and a kept variable', () => {
    const env = { API_KEY: '${secret:WORK_KEY}', REGION: 'eu-west-1' };
    should(LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }).success).be.true();
    should(LoginHalfSchema.safeParse({ env }).success).be.true();
    should(
      LoginChangeSchema.safeParse({ kind: 'login.add', id: 'work', harness: 'claude-code', store: 'environment', env })
        .success,
    ).be.true();
    should(
      LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env: { ...env, HIDDEN: { keep: true } } }).success,
    ).be.true();
  });
});

describe('m4: a login FILE is judged by the stored rule too (config editor, config_write)', () => {
  const key = 'q7Zk'.repeat(10);
  const file = (env: Record<string, string>) => ({ harness: 'claude-code', store: 'environment', env });

  it('should refuse each value the staging route refuses, naming the variable only', () => {
    const cases: Record<string, string>[] = [
      { ANTHROPIC_API_KEY: `Bearer ${key} \${secret:X}` },
      { OPENAI_API_KEY: 'hunter22x' },
      { ANTHROPIC_BASE_URL: `https://gw.example/v1?key=${key}` },
      { ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${key}` },
    ];
    for (const env of cases) {
      const issues = refusal(LoginFileSchema.safeParse(file(env)));
      const name = Object.keys(env)[0] ?? '';

      should(issues.some(issue => issue.message.startsWith(`"${name}"`) && issue.path[0] === 'env')).be.true();
      should(JSON.stringify(issues)).not.containEql(key);
      should(JSON.stringify(issues)).not.containEql('hunter22x');
    }
  });

  it('should refuse it in a harness half as well, and accept references and placeholders', () => {
    should(LoginHalfSchema.safeParse({ env: { OPENAI_API_KEY: 'hunter22x' } }).success).be.false();
    should(
      LoginFileSchema.safeParse(file({ OPENAI_API_KEY: 'ollama', GATEWAY_TOKEN: 'Bearer ${secret:K}' })).success,
    ).be.true();
  });
});

describe('R6: a login file holds at most 4096 characters per variable, and is judged in linear time', () => {
  const file = (env: Record<string, string>) => ({ harness: 'claude-code', store: 'environment', env });

  it('should refuse a 4097-character value by the variable name, and accept 4096', () => {
    const issues = refusal(LoginFileSchema.safeParse(file({ GATEWAY_NOTE: 'a'.repeat(4097) })));

    should(issues.some(issue => issue.path[0] === 'env' && issue.path[1] === 'GATEWAY_NOTE')).be.true();
    should(LoginFileSchema.safeParse(file({ GATEWAY_NOTE: 'a'.repeat(4096) })).success).be.true();
  });

  for (const character of [':', '@', '=', '%', ' ', ',', '\n', '?', '#', '/', '&', ';', '-', 'e']) {
    it(`should judge a 256 KiB value of ${JSON.stringify(character)} in well under 100 ms, under every kind of name`, () => {
      const value = character.repeat(256 * 1024);
      for (const name of ['GATEWAY_TOKEN', 'GATEWAY_NOTE', 'ANTHROPIC_CUSTOM_HEADERS', 'GATEWAY_URL']) {
        const started = performance.now();
        LoginFileSchema.safeParse(file({ [name]: value }));
        should(performance.now() - started).be.below(100);
      }
    });
  }

  it('should judge 256 KiB of repeated token and address openings in well under 100 ms', () => {
    for (const piece of ['eyJ', 'sk-', 'a://', 'a:b@', '${secret:K}', 'x?k=', 'Bearer ']) {
      const value = piece.repeat(Math.ceil((256 * 1024) / piece.length));
      for (const name of ['GATEWAY_TOKEN', 'GATEWAY_NOTE', 'OTEL_EXPORTER_OTLP_HEADERS']) {
        const started = performance.now();
        LoginFileSchema.safeParse(file({ [name]: value }));
        should(performance.now() - started).be.below(100);
      }
    }
  });
});

describe('R6 m4: config_read of a login file refused by the stored rule shows no text', () => {
  const key = 'q7Zk'.repeat(10);
  const world = async (disk: string) => {
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs,
      clock: fixedClock(),
      log: SILENT,
      binary: 'fy',
      defs: [{ plugin: 'logins', def: LOGINS_CONFIG }],
    });
    const agent = agentConfig({
      writer: () => files.writer(),
      control: () => ({ allows: async () => true }),
      status: () => files.status(),
      home: HOME,
      binary: 'fy',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const path = `${HOME}/config/logins/gw.yaml`;
    fs.seed(path, 'harness: claude-code\nstore: environment\nenv:\n  GATEWAY_NOTE: fine\n');
    await files.reload();
    fs.seed(path, disk);
    await files.reload();
    return agent;
  };
  const standing = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };

  for (const [what, line] of [
    ['a key in a header', `ANTHROPIC_CUSTOM_HEADERS: "x-api-key: ${key}"`],
    ['a short key under a credential name', 'OPENAI_API_KEY: hunter22x'],
    ['a key in a query string', `ANTHROPIC_BASE_URL: "https://gw.example/v1?key=${key}"`],
  ] as const) {
    it(`should return no text for ${what}, and name the variable only`, async () => {
      const agent = await world(`harness: claude-code\nstore: environment\nenv:\n  ${line}\n`);
      const answer = await agent.run(
        AgentConfigCallSchema.parse({ tool: 'config.read', path: 'logins/gw.yaml' }),
        standing,
      );

      should(answer.text).equal('');
      should(answer.summary).containEql('its text is not shown because it holds a raw secret');
      should(JSON.stringify(answer)).not.containEql(key);
      should(JSON.stringify(answer)).not.containEql('hunter22x');
    });
  }

  const H = 'Xq9vT2mLp8RzW4kNc7HbJ3fGd6YsA1eU';
  for (const [what, disk] of [
    [
      'a raw key plus a typo key',
      `harness: claude-code\nstore: environment\nlabl: x\nenv:\n  GATEWAY_TOKEN: "Bearer ${H}"\n`,
    ],
    [
      'a raw key plus a 4097-character value',
      `harness: claude-code\nstore: environment\nenv:\n  GATEWAY_TOKEN: "Bearer ${H}"\n  GATEWAY_NOTE: ${'a'.repeat(4097)}\n`,
    ],
    [
      'a raw key plus a bad secret reference',
      `harness: claude-code\nstore: environment\nenv:\n  GATEWAY_TOKEN: "Bearer ${H}"\n  OTHER: "\${secret:lower}"\n`,
    ],
    [
      'one over-long credential value',
      `harness: claude-code\nstore: environment\nenv:\n  GATEWAY_TOKEN: "${H}${'a'.repeat(4090)}"\n`,
    ],
    [
      'a key inside an over-long value',
      `harness: claude-code\nstore: environment\nenv:\n  GATEWAY_NOTE: "x-api-key: ${H} ${'a'.repeat(4097)}"\n`,
    ],
  ] as const) {
    it(`R7 M1: should return no text for ${what}`, async () => {
      const agent = await world(disk);
      const answer = await agent.run(
        AgentConfigCallSchema.parse({ tool: 'config.read', path: 'logins/gw.yaml' }),
        standing,
      );

      should(answer.text).equal('');
      should(answer.summary).containEql('its text is not shown because it holds a raw secret');
      should(JSON.stringify(answer)).not.containEql(H);
    });
  }

  it('R7 M1: should still mark a raw key beside an over-long variable NAME, a reserved name and a malformed reference', () => {
    for (const bad of [{ ['A'.repeat(129)]: 'x' }, { CODEX_HOME: 'x' }, { OTHER: '${secret:lower}' }]) {
      const result = LoginFileSchema.safeParse({
        harness: 'claude-code',
        store: 'environment',
        env: { ...bad, GATEWAY_TOKEN: `Bearer ${H}` },
      });

      should(result.success).be.false();
      const marked = (result.error?.issues ?? []).some(
        issue => issue.code === 'custom' && (issue.params as { rawSecret?: boolean } | undefined)?.rawSecret === true,
      );
      should(marked).be.true();
      should(JSON.stringify(result.error?.issues)).not.containEql(H);
    }
  });

  it('R7 M1: should refuse a value over 4096 characters as a marked issue without scanning it', () => {
    const result = LoginFileSchema.safeParse({
      harness: 'claude-code',
      store: 'environment',
      env: { GATEWAY_NOTE: 'a'.repeat(4097) },
    });

    should(result.success).be.false();
    const issue = result.error?.issues[0] as { code: string; params?: { rawSecret?: boolean } } | undefined;
    should(issue?.code).equal('custom');
    should(issue?.params?.rawSecret).be.true();
  });
});

describe('R8: an env that is not a map of strings is withheld, never skipped or thrown on', () => {
  const H = 'Xq9vT2mLp8RzW4kNc7HbJ3fGd6YsA1eU';
  const GOOD = 'harness: claude-code\nstore: environment\nenv:\n  GATEWAY_NOTE: fine\n';
  const world = async () => {
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs,
      clock: fixedClock(),
      log: SILENT,
      binary: 'fy',
      defs: [{ plugin: 'logins', def: LOGINS_CONFIG }],
    });
    const agent = agentConfig({
      writer: () => files.writer(),
      control: () => ({ allows: async () => true }),
      status: () => files.status(),
      home: HOME,
      binary: 'fy',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    return { fs, files, agent };
  };
  const standing = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
  const read = async (path: string) => {
    const { fs, files, agent } = await world();
    fs.seed(`${HOME}/config/logins/${path}.yaml`, GOOD);
    await files.reload();
    return { fs, files, agent };
  };

  it('C1: should refuse env: null and claude.env: null as a schema failure, not throw', () => {
    for (const body of [
      { harness: 'claude-code', store: 'environment', env: null },
      { harness: 'claude-code', store: 'environment', claude: { env: null } },
      { harness: 'claude-code', store: 'environment', codex: { env: null } },
    ]) {
      should(LoginFileSchema.safeParse(body).success).be.false();
    }
  });

  for (const [what, text] of [
    ['a blank env:', 'harness: claude-code\nstore: environment\nenv:\n'],
    ['env: ~', 'harness: claude-code\nstore: environment\nenv: ~\n'],
    ['a blank claude.env', 'harness: claude-code\nstore: environment\nclaude:\n  env:\n'],
  ] as const) {
    it(`C1: should check ${what} without throwing, as a refusal`, () => {
      const checked = checkConfigText(LOGINS_CONFIG, 'logins/gw.yaml', text, 'fy');

      should(checked.ok).be.false();
      should(['schema', 'raw_secret']).containEql((checked as { reason: string }).reason);
    });

    it(`C1: should reload with ${what} beside a good file, and the good one still reads`, async () => {
      const { fs, files, agent } = await read('good');
      fs.seed(`${HOME}/config/logins/gw.yaml`, text);
      await files.reload();
      const states = Object.fromEntries(files.status().files.map(file => [file.path, file.state]));

      should(states['logins/gw.yaml']).equal('invalid');
      should(states['logins/good.yaml']).equal('ok');
      const answer = await agent.run(
        AgentConfigCallSchema.parse({ tool: 'config.read', path: 'logins/good.yaml' }),
        standing,
      );
      should(answer.text).equal(GOOD);
    });
  }

  for (const [what, env] of [
    ['a Kubernetes-style list', `  - name: ANTHROPIC_AUTH_TOKEN\n    value: "Bearer ${H}"`],
    ['a list with a short key', '  - name: OPENAI_API_KEY\n    value: hunter22x'],
    ['a value written as a map', `  GATEWAY_TOKEN:\n    value: "Bearer ${H}"`],
    ['a value written as a list', `  GATEWAY_TOKEN: ["Bearer ${H}"]`],
    ['env as one string', `ANTHROPIC_AUTH_TOKEN=${H}`],
    ['a Compose-style list', `  - ANTHROPIC_AUTH_TOKEN=Bearer ${H}`],
  ] as const) {
    it(`M2: should return no text for ${what}`, async () => {
      const { fs, files, agent } = await read('good');
      const body = what === 'env as one string' ? ` "${env}"` : `\n${env}`;
      fs.seed(`${HOME}/config/logins/gw.yaml`, `harness: claude-code\nstore: environment\nenv:${body}\n`);
      await files.reload();
      const answer = await agent.run(
        AgentConfigCallSchema.parse({ tool: 'config.read', path: 'logins/gw.yaml' }),
        standing,
      );

      should(answer.text).equal('');
      should(JSON.stringify(answer)).not.containEql(H);
      should(JSON.stringify(answer)).not.containEql('hunter22x');
    });
  }

  it('M1: should return no text for a login file that does not parse, key or not', async () => {
    for (const bad of [
      `GATEWAY_TOKEN: "Bearer ${H}"\n   BAD: : x\n`,
      `GATEWAY_TOKEN: "Bearer ${H}\n`,
      'OPENAI_API_KEY: hunter22x\n[\n',
      'env:\n\tOPENAI_API_KEY: hunter22x\n',
      `ANTHROPIC_CUSTOM_HEADERS: "x-api-key: ${H}"\n[\n`,
    ]) {
      const { fs, files, agent } = await read('gw');
      fs.seed(`${HOME}/config/logins/gw.yaml`, bad);
      await files.reload();
      const answer = await agent.run(
        AgentConfigCallSchema.parse({ tool: 'config.read', path: 'logins/gw.yaml' }),
        standing,
      );

      should(answer.text).equal('');
      should(JSON.stringify(answer)).not.containEql(H);
      should(JSON.stringify(answer)).not.containEql('hunter22x');
    }
  });

  it('m1: should refuse a variable NAME over 128 characters as a marked issue, whatever its value', () => {
    const result = LoginFileSchema.safeParse({
      harness: 'claude-code',
      store: 'environment',
      env: { [`GATEWAY_TOKEN_${'A'.repeat(130)}_X`]: `Bearer ${H}` },
    });

    should(result.success).be.false();
    should(
      (result.error?.issues ?? []).some(
        issue => issue.code === 'custom' && (issue.params as { rawSecret?: boolean } | undefined)?.rawSecret === true,
      ),
    ).be.true();
    should(JSON.stringify(result.error?.issues)).not.containEql(H);
  });
});
