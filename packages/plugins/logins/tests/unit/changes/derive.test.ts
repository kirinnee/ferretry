import { describe, it } from 'bun:test';
import should from 'should';
import type { LoginFile } from '../../../contract/index.ts';
import { deriveLoginChange, LoginChangeRefusal, type LoginChangeFacts } from '../../../daemon/lib/changes/derive.ts';
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';
import { presetHarnesses } from '../../../daemon/lib/presets/schema.ts';
import { harnessKey } from '../../../daemon/lib/shared/harness.ts';
import { filledEnv } from '../../support/preset-env.ts';

const FILES = new Map<string, LoginFile>([
  ['work', { harness: 'claude-code', store: 'ferretry', label: 'Work' }],
  ['mine', { harness: 'claude-code', store: 'host' }],
  ['api', { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: '${secret:OPENAI_API_KEY}' } }],
  ['spender', { harness: 'claude-code', store: 'ferretry', budget: { daily: { hard: 5 } } }],
]);
const facts = (usedBy: Record<string, readonly string[]> = {}): LoginChangeFacts => ({
  machineName: 'this machine',
  presets: builtInPresets(),
  usedBy: id => usedBy[id] ?? [],
});

const refusal = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof LoginChangeRefusal) return error.message;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('deriveLoginChange', () => {
  it('should add an empty Ferretry login that needs sign-in', () => {
    const edit = deriveLoginChange(
      FILES,
      { kind: 'login.add', id: 'second', harness: 'claude-code', label: 'Second' },
      facts(),
    );

    should(edit.writes).deepEqual([
      { id: 'second', patch: { harness: 'claude-code', store: 'ferretry', label: 'Second' } },
    ]);
    should(edit.summary).equal('Add a Claude Code login second');
    should(edit.consequences).deepEqual(['It starts as an empty login that needs sign-in.']);
  });

  it('should refuse a taken name with a free one suggested', () => {
    should(refusal(() => deriveLoginChange(FILES, { kind: 'login.add', id: 'work', harness: 'codex' }, facts()))).equal(
      'work is already a login on this machine. Use work-2?',
    );
  });

  it('should refuse a label another login of the same harness already has', () => {
    should(
      refusal(() =>
        deriveLoginChange(FILES, { kind: 'login.add', id: 'x', harness: 'claude-code', label: 'Work' }, facts()),
      ),
    ).equal('another Claude Code login is already labelled Work; pick a different label');
  });

  it('should refuse a second host login of one harness and a preset on a signed-in login', () => {
    should(
      refusal(() =>
        deriveLoginChange(FILES, { kind: 'login.add', id: 'again', harness: 'claude-code', store: 'host' }, facts()),
      ),
    ).equal('mine is already your own Claude Code login on this machine');
    should(
      refusal(() =>
        deriveLoginChange(FILES, { kind: 'login.add', id: 'p', harness: 'codex', preset: 'openai-api-key' }, facts()),
      ),
    ).equal('a preset, variables and a cloud credential belong only to an environment login');
  });

  it('should refuse a raw secret in an environment login, naming the variable and never the value', () => {
    const message = refusal(() =>
      deriveLoginChange(
        FILES,
        {
          kind: 'login.add',
          id: 'raw',
          harness: 'codex',
          store: 'environment',
          env: { OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' },
        },
        facts(),
      ),
    );

    should(message).startWith('OPENAI_API_KEY in login raw looks like a secret');
    should(message).not.containEql('sk-proj');
  });

  it('should refuse a short gateway key under a credential-named variable, naming the variable and never the value', () => {
    const message = refusal(() =>
      deriveLoginChange(
        FILES,
        {
          kind: 'login.add',
          id: 'short',
          harness: 'claude-code',
          store: 'environment',
          preset: 'custom-gateway',
          env: {
            ANTHROPIC_BASE_URL: 'https://llm.corp.example',
            ANTHROPIC_AUTH_TOKEN: '${secret:GATEWAY_KEY}',
            ANTHROPIC_API_KEY: 'sk-1234',
          },
        },
        facts(),
      ),
    );

    should(message).startWith('ANTHROPIC_API_KEY in login short looks like a secret');
    should(message).not.containEql('sk-1234');
  });

  it('should accept a short placeholder under a credential name, as the secret store cannot hold one', () => {
    for (const value of ['ollama', 'hunter2']) {
      const edit = deriveLoginChange(
        FILES,
        { kind: 'login.add', id: 'tiny', harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: value } },
        facts(),
      );

      should(edit.writes).have.length(1);
    }
  });

  it('should still tell a long raw key to put it in the secret store', () => {
    should(
      refusal(() =>
        deriveLoginChange(
          FILES,
          {
            kind: 'login.add',
            id: 'long',
            harness: 'codex',
            store: 'environment',
            env: { OPENAI_API_KEY: 'hunter22x' },
          },
          facts(),
        ),
      ),
    ).containEql('Save it in this machine');
  });

  describe('a raw key beside a ${secret:NAME} reference', () => {
    const rawKey = (): string => 'q7Zk'.repeat(10);
    const stage = (env: Record<string, string>): unknown =>
      deriveLoginChange(
        FILES,
        { kind: 'login.add', id: 'beside', harness: 'claude-code', store: 'environment', env },
        facts(),
      );
    const jwt = (): string => `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`;
    const refused: readonly (readonly [string, string, () => string])[] = [
      ['GATEWAY_TOKEN', 'a scheme word, a raw key and a reference', () => `Bearer ${rawKey()} \${secret:X}`],
      ['ANTHROPIC_API_KEY', 'a reference then a raw key', () => `\${secret:X} ${rawKey()}`],
      ['GATEWAY_TOKEN', 'a JWT beside a reference', () => `Bearer ${jwt()} \${secret:X}`],
      ['GATEWAY_TOKEN', 'a hf_ token beside a reference', () => `Bearer hf_${'x1'.repeat(10)} \${secret:X}`],
      ['GATEWAY_AUTH', 'a raw key under a mid-name credential word', () => `Bearer ${rawKey()} \${secret:X}`],
    ];
    for (const [name, what, value] of refused) {
      it(`should refuse ${name} holding ${what}, naming the variable and never the value`, () => {
        const message = refusal(() => stage({ [name]: value() }));

        should(message).startWith(`${name} in login beside looks like a secret`);
        should(message).not.containEql(rawKey());
      });
    }

    it('should refuse a token found beside a reference under a name that is not a credential', () => {
      for (const value of [
        `Bearer ${jwt()} \${secret:X}`,
        `Bearer hf_${'x1'.repeat(10)} \${secret:X}`,
        'Bearer ya29.a0 ${secret:X}',
      ]) {
        should(refusal(() => stage({ GATEWAY_NOTE: value }))).startWith(
          'GATEWAY_NOTE in login beside looks like a secret',
        );
      }
    });

    it('should accept a scheme word and header punctuation around a reference', () => {
      for (const value of ['Bearer ${secret:K}', 'Authorization: Bearer ${secret:K}', '${secret:A}${secret:B}']) {
        should(stage({ GATEWAY_TOKEN: value })).be.an.Object();
      }
    });
  });

  it('should accept a documented flag whose name only mentions auth or a key, and a composite reference', () => {
    const env = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '3600000',
      MAX_THINKING_TOKENS: '31999',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer ${secret:K}',
      GATEWAY_AUTH: 'Bearer ${secret:K}',
      GATEWAY_TOKEN: 'Bearer ${secret:K}',
    };
    const edit = deriveLoginChange(
      FILES,
      { kind: 'login.add', id: 'flags', harness: 'claude-code', store: 'environment', env },
      facts(),
    );

    should(edit.writes).have.length(1);
  });

  it('should refuse a token-shaped value under a name that is not a credential, at any length', () => {
    const message = refusal(() =>
      deriveLoginChange(
        FILES,
        {
          kind: 'login.add',
          id: 'shape',
          harness: 'claude-code',
          store: 'environment',
          env: { GATEWAY_NOTE: 'sk-1234' },
        },
        facts(),
      ),
    );

    should(message).startWith('GATEWAY_NOTE in login shape looks like a secret');
    should(message).not.containEql('sk-1234');
  });

  it('should refuse an address with a user and password in it, naming the variable and never the value', () => {
    const message = refusal(() =>
      deriveLoginChange(
        FILES,
        {
          kind: 'login.add',
          id: 'url',
          harness: 'claude-code',
          store: 'environment',
          env: { ANTHROPIC_BASE_URL: 'https://bob:hunter2pass@llm.corp.example' },
        },
        facts(),
      ),
    );

    should(message).startWith('ANTHROPIC_BASE_URL in login url is an address with a user and password in it');
    should(message).not.containEql('hunter2pass');
  });

  it('should add an environment login from a preset holding the secret as a reference', () => {
    const edit = deriveLoginChange(
      FILES,
      {
        kind: 'login.add',
        id: 'openai',
        harness: 'codex',
        store: 'environment',
        preset: 'openai-api-key',
        env: { OPENAI_API_KEY: '${secret:OPENAI_API_KEY}' },
      },
      facts(),
    );

    const write = edit.writes[0] as { patch: Record<string, unknown> };
    should(write.patch).containDeep({
      harness: 'codex',
      store: 'environment',
      preset: 'openai-api-key',
      env: { OPENAI_API_KEY: '${secret:OPENAI_API_KEY}' },
    });
    should(edit.summary).startWith('Add a Codex login openai from ');
  });

  it('should refuse a preset that does not exist, and a preset secret given as a value', () => {
    should(
      refusal(() =>
        deriveLoginChange(
          FILES,
          { kind: 'login.add', id: 'n', harness: 'codex', store: 'environment', preset: 'nope' },
          facts(),
        ),
      ),
    ).equal('there is no preset nope on this machine');
    should(
      refusal(() =>
        deriveLoginChange(
          FILES,
          {
            kind: 'login.add',
            id: 'v',
            harness: 'codex',
            store: 'environment',
            preset: 'openai-api-key',
            env: { OPENAI_API_KEY: 'plain' },
          },
          facts(),
        ),
      ),
    ).startWith('OPENAI_API_KEY is a secret: store it');
  });

  it('should label, unlabel, disable and enable by editing only the changed keys', () => {
    should(deriveLoginChange(FILES, { kind: 'login.label', id: 'mine', label: 'Mine' }, facts()).writes).deepEqual([
      { id: 'mine', patch: { label: 'Mine' } },
    ]);
    should(deriveLoginChange(FILES, { kind: 'login.label', id: 'work', label: null }, facts()).writes).deepEqual([
      { id: 'work', patch: { label: undefined } },
    ]);
    const disable = deriveLoginChange(FILES, { kind: 'login.disable', id: 'work', reason: 'quota' }, facts());
    should(disable.writes).deepEqual([{ id: 'work', patch: { disabled: { reason: 'quota' } } }]);
    should(disable.consequences[0]).startWith('Nothing running is stopped');
    should(deriveLoginChange(FILES, { kind: 'login.enable', id: 'work' }, facts()).writes).deepEqual([
      { id: 'work', patch: { disabled: undefined } },
    ]);
  });

  it('should refuse to change a login that does not exist', () => {
    should(refusal(() => deriveLoginChange(FILES, { kind: 'login.enable', id: 'ghost' }, facts()))).equal(
      'no login ghost exists on this machine',
    );
  });

  it('should refuse to remove a login a runtime uses, naming the runtime', () => {
    should(
      refusal(() => deriveLoginChange(FILES, { kind: 'login.remove', id: 'work' }, facts({ work: ['main'] }))),
    ).equal('1 runtime still uses this login (main). Move it to another login first.');
  });

  it('should remove a login and say what it leaves behind: its secret names and a kept sign-in', () => {
    const edit = deriveLoginChange(FILES, { kind: 'login.remove', id: 'api' }, facts());
    should(edit.writes).deepEqual([{ id: 'api', remove: true }]);
    should(edit.orphanedSecrets).deepEqual(['OPENAI_API_KEY']);
    should(edit.consequences.join(' ')).containEql('OPENAI_API_KEY');
    should(deriveLoginChange(FILES, { kind: 'login.remove', id: 'work' }, facts()).consequences[0]).startWith(
      'Its saved sign-in stays on this machine',
    );
    should(deriveLoginChange(FILES, { kind: 'login.remove', id: 'mine' }, facts()).consequences[0]).startWith(
      'Your own claude in your terminal keeps its login',
    );
  });
});

describe("deriveLoginChange: login.env (today's credential.env, owned here)", () => {
  const GLM = {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
  };
  const ENV_FILES = new Map<string, LoginFile>([
    ['glm', { harness: 'claude-code', store: 'environment', preset: 'zai-glm', env: GLM }],
    ['work', { harness: 'claude-code', store: 'ferretry' }],
    [
      'foundry',
      {
        harness: 'claude-code',
        store: 'environment',
        env: { CLAUDE_CODE_USE_FOUNDRY: '1' },
        cloudCredential: 'azure-cli',
      },
    ],
  ]);
  const writeOf = (edit: ReturnType<typeof deriveLoginChange>) =>
    (edit.writes[0] as { id: string; patch: Record<string, unknown> }).patch;

  it('should change the variables, keep a hidden one, and say who starts with them', () => {
    const edit = deriveLoginChange(
      ENV_FILES,
      {
        kind: 'login.env',
        id: 'glm',
        env: { ...GLM, ANTHROPIC_AUTH_TOKEN: { keep: true }, API_TIMEOUT_MS: '600000' },
      },
      facts({ glm: ['alpha'] }),
    );

    should(writeOf(edit)).containDeep({
      env: { ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}', API_TIMEOUT_MS: '600000' },
    });
    should(edit.summary).equal('Change the variables of login glm');
    should(edit.consequences).deepEqual([
      'alpha starts with the new variables next launch. Running sessions keep the old ones until restarted.',
    ]);
  });

  it('should say the secret is put in at launch when no runtime is known to use it', () => {
    const edit = deriveLoginChange(
      ENV_FILES,
      { kind: 'login.env', id: 'foundry', env: { CLAUDE_CODE_USE_FOUNDRY: '1' } },
      facts(),
    );

    should(edit.consequences).matchAny(/never written anywhere/u);
    should(writeOf(edit).cloudCredential).equal('azure-cli');
  });

  it('should remove a cloud credential reference and empty a login of its variables', () => {
    const unset = deriveLoginChange(
      ENV_FILES,
      { kind: 'login.env', id: 'foundry', env: { CLAUDE_CODE_USE_FOUNDRY: '1' }, cloudCredential: null },
      facts(),
    );
    const emptied = deriveLoginChange(ENV_FILES, { kind: 'login.env', id: 'foundry', env: {} }, facts());

    should(writeOf(unset)).have.property('cloudCredential', undefined);
    should(writeOf(emptied)).have.property('env', undefined);
  });

  it('should refuse a login that signs in, an unknown login, and a hidden value with nothing to keep', () => {
    should(
      refusal(() => deriveLoginChange(ENV_FILES, { kind: 'login.env', id: 'work', env: { A: '1' } }, facts())),
    ).match(/is signed in, not made from environment variables/u);
    should(refusal(() => deriveLoginChange(ENV_FILES, { kind: 'login.env', id: 'nobody', env: {} }, facts()))).equal(
      'no login nobody exists on this machine',
    );
    should(
      refusal(() =>
        deriveLoginChange(ENV_FILES, { kind: 'login.env', id: 'foundry', env: { NEW: { keep: true } } }, facts()),
      ),
    ).equal('login foundry has no value for NEW to keep; type one');
  });

  it('should refuse a raw secret without repeating its value, and a preset login left without what it needs', () => {
    const rawKey = 'sk-ant-api03-abcdefghijklmnopq';
    const raw = refusal(() =>
      deriveLoginChange(ENV_FILES, { kind: 'login.env', id: 'glm', env: { ...GLM, EXTRA: rawKey } }, facts()),
    );
    should(raw).match(/looks like a secret/u);
    should(raw).not.containEql(rawKey);
    should(
      refusal(() =>
        deriveLoginChange(
          ENV_FILES,
          { kind: 'login.env', id: 'glm', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } },
          facts(),
        ),
      ),
    ).match(/ANTHROPIC_AUTH_TOKEN is needed/u);
  });
});

describe('deriveLoginChange: every shipped preset', () => {
  const offered = builtInPresets().filter(entry => entry.unavailable === undefined);
  const halves = offered.flatMap(entry => presetHarnesses(entry).map(half => [entry.id, half] as const));
  it.each(halves)('should add a login from the %s preset on its %s half through the daemon rules', (id, half) => {
    const entry = offered.find(candidate => candidate.id === id);
    if (entry === undefined) throw new Error(`no preset ${id}`);
    const edit = deriveLoginChange(
      FILES,
      {
        kind: 'login.add',
        id: 'from-preset',
        harness: harnessKey(half),
        store: 'environment',
        preset: id,
        env: filledEnv(entry),
        ...(entry.cloudCredential === undefined ? {} : { cloudCredential: entry.cloudCredential.suggested }),
      },
      facts(),
    );

    should(edit.writes).have.length(1);
  });
});

describe('R5: a key in a header, a query string, punctuation or braces', () => {
  const rawKey = (): string => 'q7Zk'.repeat(10);
  const stage = (env: Record<string, string>): unknown =>
    deriveLoginChange(
      FILES,
      { kind: 'login.add', id: 'r5', harness: 'claude-code', store: 'environment', env },
      facts(),
    );
  const refusedBy = (name: string, value: string, start: string): void => {
    const message = refusal(() => stage({ [name]: value }));

    should(message).startWith(`${name} in login r5 ${start}`);
    should(message).not.containEql(rawKey());
  };

  it('M1 should refuse a key inside a credential-named header whatever the variable is called', () => {
    for (const value of [
      `Authorization: Bearer ${rawKey()}`,
      `X-Api-Key: ${rawKey()}`,
      `Authorization: Basic ${'dXNlcjpwYXNz'.repeat(3)}`,
      `X-Org: acme\nx-portkey-api-key: ${rawKey()}`,
      `x-auth-token: \${secret:K} ${rawKey()}`,
    ]) {
      refusedBy('ANTHROPIC_CUSTOM_HEADERS', value, 'looks like a secret');
    }
  });

  it('M1 should accept a header whose value is a reference, or one that is not credential-named', () => {
    for (const value of [
      'x-portkey-api-key: ${secret:K}',
      'X-Org: acme',
      'X-Org: acme\nAuthorization: Bearer ${secret:K}',
    ]) {
      should(stage({ ANTHROPIC_CUSTOM_HEADERS: value })).be.an.Object();
    }
  });

  it('M2 should refuse a key in the query string of an address, naming the variable and never the value', () => {
    for (const [name, value] of [
      ['ANTHROPIC_BASE_URL', `https://gw.example/v1?key=${rawKey()}`],
      ['ANTHROPIC_BASE_URL', `https://gw.example/v1?api_key=${rawKey()}`],
      ['GATEWAY_URL', `https://gw.example/v1?x=1&token=${rawKey()}`],
    ] as const) {
      refusedBy(name, value, 'is an address that carries a key in its query string');
    }
  });

  it('M2 should accept an api-version query and a query key that is a reference', () => {
    for (const value of ['https://gw.example/v1?api-version=2024-10-21', 'https://gw.example/v1?key=${secret:K}']) {
      should(stage({ ANTHROPIC_BASE_URL: value })).be.an.Object();
    }
  });

  it('m1 should refuse a password broken by punctuation or spaces beside a reference', () => {
    for (const [name, value] of [
      ['GATEWAY_PASSWORD', '${secret:X} P@ssw0rd!Wint#er-2024%zz'],
      ['GATEWAY_TOKEN', '${secret:X} ab%cdefg%hijklmn%opq'],
      ['GATEWAY_TOKEN', '${secret:X} ab:cdefg:hijklmn:opq'],
      ['GATEWAY_TOKEN', '${secret:X} q7Zk!q7Zk@q7Zk#q7Zk'],
      ['GATEWAY_TOKEN', '${secret:X} abcdefg hijklmn opqrstu vwxyz12'],
    ] as const) {
      const message = refusal(() => stage({ [name]: value }));

      should(message).startWith(`${name} in login r5 looks like a secret`);
      should(message).not.containEql('Wint#er');
    }
  });

  it('n1 should accept a credential-named header name before a reference under a credential-named variable', () => {
    for (const name of ['GATEWAY_TOKEN', 'GATEWAY_AUTH_HEADER']) {
      should(stage({ [name]: 'x-api-key: ${secret:K}' })).be.an.Object();
    }
  });

  it('m2 should refuse a key wrapped in braces, and accept a bare reference name', () => {
    refusedBy('GATEWAY_TOKEN', `\${secret:${rawKey().toLowerCase()}}`, 'looks like a secret');
    refusedBy('GATEWAY_NOTE', `\${hf_${'x1'.repeat(10)}}`, 'looks like a secret');
    for (const value of ['${GATEWAY_TOKEN}', '$GATEWAY_TOKEN', '${secret:K}']) {
      should(stage({ GATEWAY_TOKEN: value })).be.an.Object();
    }
  });

  it('m3 should accept a password that is a reference in an address, and still refuse a raw one', () => {
    for (const [name, value] of [
      ['HTTPS_PROXY', 'http://alice:${secret:PW}@proxy.example:3128'],
      ['ANTHROPIC_BASE_URL', 'https://alice:${secret:PW}@gw.example/v1'],
    ] as const) {
      should(stage({ [name]: value })).be.an.Object();
    }
    refusedBy(
      'ANTHROPIC_BASE_URL',
      `https://alice:${rawKey()}@gw.example/v1`,
      'is an address with a user and password',
    );
  });

  it('should keep every earlier accepted case', () => {
    should(
      stage({
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '3600000',
        MAX_THINKING_TOKENS: '31999',
        AUTH_MODE: 'oauth',
        OPENAI_API_KEY: 'ollama',
        A_TOKEN: 'Token ${secret:K}',
        B_TOKEN: '${secret:A}${secret:B}',
      }),
    ).be.an.Object();
  });
});

describe('R6: under a credential name only an allowlisted shape is stored; headers and addresses are read under any name', () => {
  const K = 'q7Zk'.repeat(10);
  const stage = (env: Record<string, string>): unknown =>
    deriveLoginChange(
      FILES,
      { kind: 'login.add', id: 'r6', harness: 'claude-code', store: 'environment', env },
      facts(),
    );
  const SECRET = 'looks like a secret';
  const USERINFO = 'is an address with a user and password';
  const QUERY = 'is an address that carries a key in its query string';
  /** [variable, value, start of the sentence the person reads]. */
  const refused: readonly (readonly [string, string, string])[] = [
    // header lists: `name=value` (OpenTelemetry), folded lines, bare CR, underscores, long names
    ['OTEL_EXPORTER_OTLP_HEADERS', `Authorization=Bearer ${K}`, SECRET],
    ['OTEL_EXPORTER_OTLP_HEADERS', `x-api-key=${K}`, SECRET],
    ['OTEL_EXPORTER_OTLP_HEADERS', `api-key=${K},x=1`, SECRET],
    ['OTEL_EXPORTER_OTLP_HEADERS', `Authorization=Basic%20${K}`, SECRET],
    ['OTEL_EXPORTER_OTLP_METRICS_HEADERS', `Authorization=Bearer ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `X-Custom-Header-For-Our-Very-Long-Gateway-Api-Key: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `x_api_key: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `Authorization:\n Bearer ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `X-Org: acme\rx-api-key: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `X-Org: acme\r\nx-api-key: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `x-api-key:${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `authorization: bearer ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `X-Org: a\nX-Org: b\nAuthorization: Bearer ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `Cookie: a=${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `Ocp-Apim-Subscription-Key: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `X-Goog-Api-Key: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `x-portkey-virtual-key: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `apikey: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `X-Auth: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `X-Access-Token: ${K}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `x-api-key: ${K.slice(0, 20)} ${K.slice(20)}`, SECRET],
    ['ANTHROPIC_CUSTOM_HEADERS', `x-auth-token: \${secret:K} ${K}`, SECRET],
    // a credential name: nothing but an allowlisted shape
    ['GATEWAY_TOKEN', `Bearer ${K} \${secret:X}`, SECRET],
    ['GATEWAY_TOKEN', `bearer\n${K}\n\${secret:X}`, SECRET],
    ['GATEWAY_TOKEN', `BEARER Bearer ${K} \${secret:X}`, SECRET],
    ['GATEWAY_TOKEN', `Basic ${'dXNlcjpwYXNz'.repeat(3)} \${secret:X}`, SECRET],
    ['GATEWAY_TOKEN', `"${K}" \${secret:X}`, SECRET],
    ['GATEWAY_TOKEN', `\${secret:X},${K}`, SECRET],
    ['GATEWAY_TOKEN', `Authorization: Bearer ${K} \${secret:X}`, SECRET],
    ['GATEWAY_TOKEN', `$\${secret:X} ${K}`, SECRET],
    ['GATEWAY_TOKEN', `\${secret:X} ${K}https://gw/`, SECRET],
    ['GATEWAY_PASSWORD', '${secret:X} P@ssw0rd!Wint#er-2024%zz', SECRET],
    ['GATEWAY_TOKEN', '${secret:X} ab%cdefg%hijklmn%opq', SECRET],
    ['GATEWAY_TOKEN', '${secret:X} ab:cdefg:hijklmn:opq', SECRET],
    ['GATEWAY_TOKEN', '${secret:X} q7Zk!q7Zk@q7Zk#q7Zk', SECRET],
    ['GATEWAY_TOKEN', '${secret:X} abcdefg hijklmn opqrstu vwxyz12', SECRET],
    ['GATEWAY_TOKEN', '${secret:X} abcdefg', SECRET],
    ['GATEWAY_TOKEN', `\${${K}}`, SECRET],
    ['GATEWAY_TOKEN', `$${K}`, SECRET],
    ['GATEWAY_TOKEN', `\${X${K}}`, SECRET],
    ['GATEWAY_TOKEN', `\${secret:${K.toLowerCase()}}`, SECRET],
    ['GATEWAY_NOTE', `\${hf_${'x1'.repeat(10)}}`, SECRET],
    ['GATEWAY_TOKEN', `${K.slice(0, 35)}-Key: \${secret:K}`, SECRET],
    ['GATEWAY_TOKEN', `${'Q7Zk'.repeat(5)}-Key: \${secret:K} a`, SECRET],
    ['OPENAI_API_KEY', 'hunter22x', SECRET],
    ['GATEWAY_TOKEN', `https://alice:${K}@gw.example`, SECRET],
    // addresses under any name: a literal password, a key as the user, a key in a query or a fragment
    ['ANTHROPIC_BASE_URL', `https://alice:${K}@gw.example/v1`, USERINFO],
    ['ANTHROPIC_BASE_URL', `alice:${K}@gw.example`, USERINFO],
    ['ANTHROPIC_BASE_URL', `https://${K}:@gw/v1`, USERINFO],
    ['HTTPS_PROXY', `http://${K}:@proxy:3128`, USERINFO],
    ['HTTPS_PROXY', `http:/alice:${K}@proxy:3128`, USERINFO],
    ['HTTPS_PROXY', `http://alice:\${secret:PW}x@proxy:3128`, USERINFO],
    ['HTTPS_PROXY', `http://alice%3A${K}@proxy:3128`, USERINFO],
    ['HTTPS_PROXY', `http://${K}@proxy:3128`, USERINFO],
    ['ANTHROPIC_BASE_URL', `https://gw.example/v1?key=${K}`, QUERY],
    ['ANTHROPIC_BASE_URL', `https://gw.example/v1?api_key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?x=1&token=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?x=1;token=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?key=abc&key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?KEY=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?Api-Key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?x-api-key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?sig=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?auth_token=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?access-token=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?subscription-key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?key=abc%20${K}`, QUERY],
    ['GATEWAY_URL', `HTTPS://gw.example/v1?key=${K}`, QUERY],
    ['GATEWAY_URL', ` https://gw.example/v1?key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?%6Bey=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?k%65y=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?ke%79=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?key%20=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?key[]=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?pass=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?pwd=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?X-Amz-Signature=${K}`, QUERY],
    ['GATEWAY_URL', `gw.example/v1?key=${K}`, QUERY],
    ['GATEWAY_URL', `//gw.example/v1?key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1#key=${K}`, QUERY],
    ['GATEWAY_URL', `https://gw.example/v1?x=1#token=${K}`, QUERY],
  ];
  it.each(refused)(
    'should refuse %s holding a hidden key (case %#), naming the variable and never the value',
    (name, value, start) => {
      const message = refusal(() => stage({ [name]: value }));

      should(message).startWith(`${name} in login r6 ${start}`);
      should(message).not.containEql(K);
      should(message).not.containEql(K.slice(0, 12));
    },
  );

  const accepted: readonly (readonly [string, string])[] = [
    ['CLAUDE_CODE_SKIP_BEDROCK_AUTH', '1'],
    ['CLAUDE_CODE_SKIP_VERTEX_AUTH', '1'],
    ['CLAUDE_CODE_SKIP_FOUNDRY_AUTH', '1'],
    ['CLAUDE_CODE_API_KEY_HELPER_TTL_MS', '3600000'],
    ['MAX_THINKING_TOKENS', '31999'],
    ['AUTH_MODE', 'oauth'],
    ['USE_AUTH', 'false'],
    ['USE_AUTH', 'Yes'],
    ['GATEWAY_AUTH', 'Bearer ${secret:K}'],
    ['GATEWAY_TOKEN', 'Token ${secret:K}'],
    ['GATEWAY_TOKEN', 'basic\t${secret:K}'],
    ['GATEWAY_TOKEN', 'Authorization: Bearer ${secret:K}'],
    ['GATEWAY_TOKEN', 'x-api-key: ${secret:K}'],
    ['GATEWAY_AUTH_HEADER', 'x-api-key: ${secret:K}'],
    ['GATEWAY_TOKEN', 'X-Org-Name: ${secret:K}'],
    ['GATEWAY_TOKEN', 'x-api-key=${secret:K}'],
    ['GATEWAY_TOKEN', '${secret:A}${secret:B}'],
    ['GATEWAY_TOKEN', '${GATEWAY_TOKEN}'],
    ['GATEWAY_TOKEN', '$GATEWAY_TOKEN'],
    ['GATEWAY_TOKEN', '3600000000'],
    ['GATEWAY_TOKEN', 'https://gw.example/v1'],
    ['GATEWAY_TOKEN', 'https://gw.example/v1?key=${secret:K}'],
    ['OPENAI_API_KEY', 'ollama'],
    ['OPENAI_API_KEY', 'dummy'],
    ['OPENAI_API_KEY', 'hunter2'],
    ['ANTHROPIC_API_KEY', ''],
    ['ANTHROPIC_CUSTOM_HEADERS', 'Authorization: Bearer ${secret:K}'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'x-portkey-api-key: ${secret:K}'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'X-Org: acme'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'X-Org: acme\nAuthorization: Bearer ${secret:K}'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer ${secret:K}'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'x-org=acme'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'x-org=acme,api-key=${secret:K}'],
    ['ANTHROPIC_BASE_URL', 'https://gw.example/v1?api-version=2024-10-21'],
    ['ANTHROPIC_BASE_URL', 'https://gw.example/v1?key=${secret:K}'],
    ['ANTHROPIC_BASE_URL', 'https://gw.example/v1?token=abc'],
    ['ANTHROPIC_BASE_URL', 'https://gw.example/v1?%6Bey=${secret:K}'],
    ['HTTPS_PROXY', 'http://alice:${secret:PW}@proxy.example:3128'],
    ['HTTPS_PROXY', 'http://${secret:U}:${secret:PW}@proxy.example:3128'],
    ['HTTPS_PROXY', '${secret:U}:${secret:PW}@proxy.example:3128'],
    ['HTTPS_PROXY', 'http:/alice:${secret:PW}@proxy.example:3128'],
    ['GATEWAY_NOTE', 'ada.lovelace@example.com'],
  ];
  it.each(accepted)('should accept %s = %s', (name, value) => {
    should(stage({ [name]: value })).be.an.Object();
  });

  it('should keep every shipped-style variable set together', () => {
    should(
      stage({
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '3600000',
        MAX_THINKING_TOKENS: '31999',
        AUTH_MODE: 'oauth',
        USE_AUTH: 'false',
        A_TOKEN: 'Token ${secret:K}',
        B_TOKEN: '${secret:A}${secret:B}',
        C_TOKEN: 'Authorization: Bearer ${secret:K}',
      }),
    ).be.an.Object();
  });
});

describe('R7: schemes, hosts, queries, paths and key-named variables; the owner settings stay accepted', () => {
  /** 32 made-up characters of high entropy. */
  const H = 'Xq9vT2mLp8RzW4kNc7HbJ3fGd6YsA1eU';
  const GUID = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const stage = (env: Record<string, string>): unknown =>
    deriveLoginChange(
      FILES,
      { kind: 'login.add', id: 'r7', harness: 'claude-code', store: 'environment', env },
      facts(),
    );
  const refusedRows: readonly (readonly [string, string])[] = [
    // M3: shape (g) is an allowlist of schemes and of address parts
    ['GATEWAY_TOKEN', `x://${H}`],
    ['GATEWAY_TOKEN', `ws://${H}`],
    ['GATEWAY_TOKEN', `file:///${H}`],
    ['GATEWAY_TOKEN', `ftp://gw/${H}`],
    ['GATEWAY_TOKEN', 'ftp://gw.example.com/v1'],
    ['GATEWAY_TOKEN', 'x://gw.example.com/v1'],
    ['GATEWAY_TOKEN', 'file:///etc/gateway-settings'],
    ['GATEWAY_TOKEN', `https://${H}.example.com/`],
    ['GATEWAY_TOKEN', `https://gw/?q=${H}`],
    ['GATEWAY_TOKEN', `https://gw/?${H}`],
    ['GATEWAY_TOKEN', `https://gw/#${H}`],
    ['GATEWAY_TOKEN', `https://gw/v1;${H}`],
    ['GATEWAY_TOKEN', `https://gw:443/${'0123456789abcdef'.repeat(2)}`],
    ['GATEWAY_TOKEN', `https://gw/${H}`],
    ['GATEWAY_TOKEN', `https://gw/a-b.${H}/c`],
    ['GATEWAY_TOKEN', `https://gw/%58q9vT2mLp8RzW4kNc7HbJ3fGd6YsA1eU`],
    ['GATEWAY_TOKEN', `wss://gw/?x=${H}`],
    ['GATEWAY_TOKEN', `socks5://gw/#x`],
    // m1: a name ending in KEY, a glued name
    ['AZURE_OPENAI_KEY', `Bearer ${H}`],
    ['AZURE_OPENAI_KEY', `${H} x`],
    ['AZURE_OPENAI_KEY', `/${H}`],
    ['AZURE_OPENAI_KEY', 'q7Zk'.repeat(10)],
    ['OPENAI_KEY', `Bearer ${H}`],
    ['GATEWAYTOKEN', `Bearer ${H}`],
    // m2: a tab, CR or LF inside an address is dropped by a URL parser
    ['HTTPS_PROXY', `http://alice:${H}\n@proxy:3128`],
    ['HTTPS_PROXY', `http://alice:${H.slice(0, 10)}\t${H.slice(10)}@proxy:3128`],
    ['HTTPS_PROXY', `http://alice:${H.slice(0, 10)}\r\n${H.slice(10)}@proxy:3128`],
    // m3: a header whose NAME says nothing (Honeycomb), in a header list
    ['OTEL_EXPORTER_OTLP_HEADERS', `x-honeycomb-team=${H}`],
    ['OTEL_EXPORTER_OTLP_HEADERS', `x-org=acme,x-honeycomb-team=Bearer ${H}`],
    // m4: a PEM private key under any name
    ['SSH_KEY', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----'],
    ['GATEWAY_NOTE', '-----BEGIN PRIVATE KEY-----\nMIIEvQ'],
    [
      'VERTEX_SERVICE_ACCOUNT',
      '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n"}',
    ],
    // M2: a header list is read under EVERY name, and so is a JSON body
    ['GATEWAY_EXTRA', `x-api-key: ${H}`],
    ['GATEWAY_EXTRA', `Authorization: Bearer ${H}`],
    ['GATEWAY_CONFIG', `apiKey: ${H}`],
    ['GATEWAY_CONFIG', `token=${H}`],
    ['CLAUDE_CODE_EXTRA_BODY', `{"api_key":"${H}"}`],
    ['CLAUDE_CODE_EXTRA_BODY', `{"x":1,"private_key":"${H}"}`],
    // n1: a header name (shape d) that is long enough to hold a key
    ['GATEWAY_TOKEN', `${H.slice(0, 16)}-${H.slice(16)}-aaaa-bbbb: \${secret:K}`],
    ['GATEWAY_TOKEN', `${GUID}: \${secret:K}`],
  ];
  it.each(refusedRows)(
    'should refuse %s holding a hidden key (row %#), naming the variable and never the value',
    (name, value) => {
      const message = refusal(() => stage({ [name]: value }));

      should(message).startWith(`${name} in login r7 `);
      should(message).not.containEql(H);
      should(message).not.containEql(H.slice(0, 12));
    },
  );

  /** The owner's own settings (66): every one stays accepted. */
  const ownerSettings: readonly (readonly [string, string])[] = [
    // OpenTelemetry
    ['OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer ${secret:OTEL_TOKEN}'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'x-honeycomb-dataset=claude,x-org=acme'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otel.example.com:4318'],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf'],
    ['OTEL_RESOURCE_ATTRIBUTES', 'service.name=claude-code,deployment.environment=prod'],
    ['OTEL_METRICS_EXPORTER', 'otlp'],
    // base URLs
    ['ANTHROPIC_BASE_URL', 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gw/anthropic'],
    ['ANTHROPIC_BASE_URL', 'https://gw.example/v1?api-version=2024-10-21'],
    ['ANTHROPIC_BASE_URL', 'https://my-resource.openai.azure.com/openai?api-version=2024-10-21'],
    ['ANTHROPIC_BASE_URL', 'http://localhost:11434'],
    ['ANTHROPIC_BEDROCK_BASE_URL', 'https://bedrock-runtime.us-east-1.amazonaws.com'],
    ['ANTHROPIC_VERTEX_BASE_URL', 'https://us-east5-aiplatform.googleapis.com/v1'],
    ['OPENAI_BASE_URL', 'http://127.0.0.1:8080/v1'],
    ['GATEWAY_AUTH_URL', `https://login.microsoftonline.com/${GUID}/oauth2/v2.0/token`],
    ['GATEWAY_TOKEN_URL', 'https://example.okta.com/oauth2/aus1b2c3d4e5f6g7h8i9/v1/token'],
    // AWS and Bedrock
    ['AWS_REGION', 'us-east-1'],
    ['AWS_PROFILE', 'work-sso'],
    ['ANTHROPIC_MODEL', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet'],
    ['AWS_BEARER_TOKEN_BEDROCK', '${secret:BEDROCK_TOKEN}'],
    ['CLAUDE_CODE_USE_BEDROCK', '1'],
    ['CLAUDE_CODE_SKIP_BEDROCK_AUTH', '1'],
    ['AWS_ACCESS_KEY_ID', '$AWS_ACCESS_KEY_ID'],
    ['AWS_SECRET_ACCESS_KEY', '${secret:AWS_SECRET}'],
    // Vertex
    ['CLOUD_ML_REGION', 'us-east5'],
    ['ANTHROPIC_VERTEX_PROJECT_ID', 'my-project-123456'],
    ['CLAUDE_CODE_USE_VERTEX', '1'],
    ['CLAUDE_CODE_SKIP_VERTEX_AUTH', '1'],
    // proxies and certificates
    ['HTTPS_PROXY', 'http://proxy.example.com:3128'],
    ['HTTP_PROXY', 'http://alice:${secret:PW}@proxy.example.com:3128'],
    ['ALL_PROXY', 'socks5://127.0.0.1:1080'],
    ['NO_PROXY', 'localhost,127.0.0.1,.corp.example'],
    ['NODE_EXTRA_CA_CERTS', '/etc/ssl/certs/corp-root.pem'],
    ['SSL_CERT_FILE', '/etc/ssl/certs/ca-bundle.crt'],
    // custom headers
    ['ANTHROPIC_CUSTOM_HEADERS', 'anthropic-beta: interleaved-thinking-2025-05-14'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'x-portkey-config: pc-claude-1234'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'x-portkey-provider: anthropic'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'cf-aig-authorization: Bearer ${secret:CF_AIG}'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'Helicone-Auth: Bearer ${secret:HELICONE}'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'x-org-id: 0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'X-Org: acme\nAuthorization: Bearer ${secret:K}'],
    // Claude and Codex settings
    ['CLAUDE_CODE_OAUTH_TOKEN', '${secret:CLAUDE_OAUTH}'],
    ['MAX_THINKING_TOKENS', '31999'],
    ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', '64000'],
    ['CLAUDE_CODE_API_KEY_HELPER_TTL_MS', '3600000'],
    ['OPENAI_API_KEY', 'ollama'],
    ['OPENAI_API_KEY', '${secret:OPENAI}'],
    ['GATEWAY_TOKEN', '${GATEWAY_TOKEN}'],
    ['ANTHROPIC_API_KEY', ''],
    ['ANTHROPIC_AUTH_TOKEN', 'Bearer ${secret:GATEWAY}'],
    ['ANTHROPIC_SMALL_FAST_MODEL', 'claude-haiku-4-5'],
    ['DISABLE_TELEMETRY', '1'],
    ['CODEX_MODEL', 'gpt-5.1-codex'],
    ['API_TIMEOUT_MS', '600000'],
    // m5: a file path under a credential name (shape h)
    ['GOOGLE_APPLICATION_CREDENTIALS', '/home/owner/.config/gcloud/application_default_credentials.json'],
    ['GOOGLE_APPLICATION_CREDENTIALS', '~/keys/vertex-sa.json'],
    ['AWS_SHARED_CREDENTIALS_FILE', '/home/owner/.aws/credentials'],
    ['AWS_WEB_IDENTITY_TOKEN_FILE', '/var/run/secrets/eks.amazonaws.com/serviceaccount/token'],
    ['AZURE_FEDERATED_TOKEN_FILE', '/var/run/secrets/azure/tokens/azure-identity-token'],
    ['AZURE_OPENAI_KEY', '${secret:AZURE_OPENAI}'],
    ['AZURE_OPENAI_KEY', 'ollama'],
    ['CLAUDE_CODE_CLIENT_KEY', '/etc/ssl/private/client.key'],
    // m1: key-named and glued-name variables with a reference
    ['OPENAI_KEY', 'Bearer ${secret:OPENAI}'],
    ['GATEWAYTOKEN', '${secret:GATEWAY}'],
    // (g) addresses under a credential name
    ['GATEWAY_TOKEN', 'https://gw.example/v1'],
    ['GATEWAY_TOKEN', 'wss://gw.example/stream?v=2'],
    ['GATEWAY_TOKEN', 'socks5h://127.0.0.1:9050'],
  ];
  it.each(ownerSettings)('should accept the owner setting %s = %s', (name, value) => {
    should(stage({ [name]: value })).be.an.Object();
  });
  it('should hold all 66 owner settings in the table', () => {
    should(ownerSettings.length).be.aboveOrEqual(66);
  });
});
