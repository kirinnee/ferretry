import { describe, it } from 'bun:test';
import should from 'should';
import type { LoginFile } from '../../../contract/index.ts';
import { deriveLoginChange, LoginChangeRefusal, type LoginChangeFacts } from '../../../daemon/lib/changes/derive.ts';
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';

const facts = (): LoginChangeFacts => ({
  machineName: 'this machine',
  presets: builtInPresets(),
  usedBy: () => [],
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

const patchOf = (edit: ReturnType<typeof deriveLoginChange>): Record<string, unknown> =>
  (edit.writes[0] as { id: string; patch: Record<string, unknown> }).patch;

const KEY = '${secret:DEEPSEEK_API_KEY}';

describe('deriveLoginChange: adding', () => {
  it('should refuse an id that is not lowercase letters, digits and dashes, and suggest a free one', () => {
    const message = refusal(() =>
      deriveLoginChange(new Map(), { kind: 'login.add', id: 'Not A Name', harness: 'claude-code' }, facts()),
    );
    should(message).startWith('Use only lowercase letters, digits and dashes. Use ');
    should(message).endWith('?');
  });

  it('should add the person’s own login for a harness that has none yet, and say it is shared with the terminal', () => {
    const edit = deriveLoginChange(
      new Map<string, LoginFile>([['mine', { harness: 'claude-code', store: 'host' }]]),
      { kind: 'login.add', id: 'mine-codex', harness: 'codex', store: 'host' },
      facts(),
    );

    should(patchOf(edit)).eql({ harness: 'codex', store: 'host' });
    should(edit.summary).equal('Add your own Codex login as mine-codex');
    should(edit.consequences).eql([
      'It is your own Codex login, shared with codex in your terminal: signing in here signs that in too.',
    ]);
  });

  it('should say the Claude Code login is shared with claude', () => {
    const edit = deriveLoginChange(
      new Map(),
      { kind: 'login.add', id: 'mine', harness: 'claude-code', store: 'host' },
      facts(),
    );
    should(edit.consequences[0]).containEql('shared with claude in your terminal');
  });

  it('should refuse a login that would not be a valid file, naming the field and the reason', () => {
    const message = refusal(() =>
      deriveLoginChange(
        new Map(),
        {
          kind: 'login.add',
          id: 'bad-env',
          harness: 'claude-code',
          store: 'environment',
          env: { 'not a variable name': '1' },
        },
        facts(),
      ),
    );
    should(message).startWith('login bad-env would not be a valid login: ');
    should(message).containEql('env');
  });
});

describe('deriveLoginChange: login.env on a login with halves', () => {
  const BASE = 'https://api.deepseek.com/anthropic';
  const TWO_HALVES = new Map<string, LoginFile>([
    [
      'ds',
      {
        harness: 'claude-code',
        store: 'environment',
        env: { SHARED_NOTE: 'a' },
        claude: { env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: KEY } },
        codex: {
          env: { DEEPSEEK_API_KEY: KEY },
          codexProvider: { id: 'deepseek', baseUrl: 'https://api.deepseek.com/', keyVariable: 'DEEPSEEK_API_KEY' },
        },
      } as LoginFile,
    ],
  ]);

  it('should put each variable back where it was: shared stays shared, a half’s own stays in that half', () => {
    const edit = deriveLoginChange(
      TWO_HALVES,
      {
        kind: 'login.env',
        id: 'ds',
        env: {
          SHARED_NOTE: 'b',
          ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
          ANTHROPIC_AUTH_TOKEN: { keep: true },
          DEEPSEEK_API_KEY: { keep: true },
          ADDED: 'x',
        },
      },
      facts(),
    );

    const patch = patchOf(edit);
    should(patch.env).eql({ SHARED_NOTE: 'b', ADDED: 'x' });
    should(patch.claude).eql({
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic', ANTHROPIC_AUTH_TOKEN: KEY },
    });
    should(patch.codex).eql({
      env: { DEEPSEEK_API_KEY: KEY },
      codexProvider: { id: 'deepseek', baseUrl: 'https://api.deepseek.com/', keyVariable: 'DEEPSEEK_API_KEY' },
    });
  });

  it('should put a name both halves set into both halves', () => {
    const files = new Map<string, LoginFile>([
      [
        'ds',
        {
          harness: 'claude-code',
          store: 'environment',
          claude: { env: { REGION: 'eu', ANTHROPIC_AUTH_TOKEN: KEY } },
          codex: { env: { REGION: 'eu', DEEPSEEK_API_KEY: KEY } },
        } as LoginFile,
      ],
    ]);
    const edit = deriveLoginChange(
      files,
      {
        kind: 'login.env',
        id: 'ds',
        env: { REGION: 'us', ANTHROPIC_AUTH_TOKEN: { keep: true }, DEEPSEEK_API_KEY: { keep: true } },
      },
      facts(),
    );

    const patch = patchOf(edit);
    should(patch.env).be.undefined();
    should(patch.claude).eql({ env: { REGION: 'us', ANTHROPIC_AUTH_TOKEN: KEY } });
    should(patch.codex).eql({ env: { REGION: 'us', DEEPSEEK_API_KEY: KEY } });
  });

  it('should send a new variable to the half its preset declares it in', () => {
    const files = new Map<string, LoginFile>([
      [
        'glm',
        {
          harness: 'claude-code',
          store: 'environment',
          preset: 'zai-glm',
          claude: {
            env: {
              ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
              ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
            },
          },
        } as LoginFile,
      ],
    ]);
    const edit = deriveLoginChange(
      files,
      {
        kind: 'login.env',
        id: 'glm',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
          ANTHROPIC_AUTH_TOKEN: { keep: true },
          API_TIMEOUT_MS: '600000',
        },
      },
      facts(),
    );

    const patch = patchOf(edit);
    should(patch.env).be.undefined();
    should((patch.claude as { env: Record<string, string> }).env).containEql({ API_TIMEOUT_MS: '600000' });
  });

  it('should leave a half with no variables of its own without an env key', () => {
    const files = new Map<string, LoginFile>([
      [
        'split',
        {
          harness: 'claude-code',
          store: 'environment',
          env: { SHARED_NOTE: 'a' },
          claude: { env: {} },
          codex: { env: { OPENAI_API_KEY: '${secret:OPENAI_API_KEY}' } },
        } as LoginFile,
      ],
    ]);
    const edit = deriveLoginChange(
      files,
      {
        kind: 'login.env',
        id: 'split',
        env: { SHARED_NOTE: 'a', OPENAI_API_KEY: { keep: true } },
      },
      facts(),
    );

    const patch = patchOf(edit);
    should(patch.claude).eql({});
    should(patch.codex).eql({ env: { OPENAI_API_KEY: '${secret:OPENAI_API_KEY}' } });
  });

  it('should refuse an edit that leaves the login invalid, naming what is wrong', () => {
    const message = refusal(() =>
      deriveLoginChange(
        new Map<string, LoginFile>([
          ['plain', { harness: 'claude-code', store: 'environment', env: { A: '1' } } as LoginFile],
        ]),
        { kind: 'login.env', id: 'plain', env: {} },
        facts(),
      ),
    );
    should(message).equal(
      'login plain would not be a valid login: a login kept in the environment must say which variables authenticate it, in "env"',
    );
  });
});
