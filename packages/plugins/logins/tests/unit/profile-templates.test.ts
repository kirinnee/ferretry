/**
 * `LoginsApi.environmentTemplates`: what Runtimes reads of an environment login to build a runtime's home. Plain values
 * and `${secret:NAME}` references as written, ONLY from a login file that passes its check; anything else yields names
 * only. No secret value and no document text is reachable through it.
 */
import { describe, expect, it } from 'bun:test';
import { EnvironmentLoginTemplateSchema, type LoginFile } from '../../contract/index.ts';
import { environmentTemplates } from '../../daemon/lib/profile-templates.ts';

const RAW = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const environmentLogin = (env: Record<string, string>, extra: Partial<LoginFile> = {}): LoginFile =>
  ({ harness: 'claude-code', store: 'environment', env, budget: { daily: { hardLimit: 5 } }, ...extra }) as LoginFile;

const valid = () => 'valid' as const;

describe('the environment login templates', () => {
  it('gives plain values and ${secret:NAME} references as written, and nothing else of the file', () => {
    const files = new Map<string, LoginFile>([
      [
        'glm',
        environmentLogin(
          { ANTHROPIC_BASE_URL: 'https://api.example.test', ANTHROPIC_AUTH_TOKEN: '${secret:GLM_KEY}' },
          { label: 'GLM work', preset: 'glm' },
        ),
      ],
    ]);

    const [template] = environmentTemplates(files, valid);

    expect(template).toEqual({
      kind: 'templates',
      id: 'glm',
      harness: 'claude-code',
      env: { ANTHROPIC_BASE_URL: 'https://api.example.test', ANTHROPIC_AUTH_TOKEN: '${secret:GLM_KEY}' },
      preset: 'glm',
    });
    // Not its budget, not its label.
    expect(JSON.stringify(template)).not.toContain('hardLimit');
    expect(JSON.stringify(template)).not.toContain('GLM work');
  });

  it('leaves a login that is not an environment login out', () => {
    const files = new Map<string, LoginFile>([
      ['host-claude', { harness: 'claude-code', store: 'host' } as LoginFile],
      ['own', { harness: 'claude-code', store: 'ferretry' } as LoginFile],
    ]);

    expect(environmentTemplates(files, valid)).toEqual([]);
  });

  it.each(['invalid', 'held', 'absent'] as const)(
    'a login whose file is %s yields its NAME and variable NAMES only, never a value',
    state => {
      const files = new Map<string, LoginFile>([
        [
          'glm',
          environmentLogin({ ANTHROPIC_BASE_URL: 'https://private.example.test/PLAIN_VALUE', TOKEN: '${secret:K}' }),
        ],
      ]);

      const [template] = environmentTemplates(files, () => state);

      expect(template).toEqual({
        kind: 'withheld',
        id: 'glm',
        harness: 'claude-code',
        variables: ['ANTHROPIC_BASE_URL', 'TOKEN'],
      });
      expect(JSON.stringify(template)).not.toContain('PLAIN_VALUE');
      expect(JSON.stringify(template)).not.toContain('private.example.test');
      expect(JSON.stringify(template)).not.toContain('${secret');
    },
  );

  it('a variable that holds something that looks like a raw secret withholds the whole login: the value is unreachable', () => {
    const files = new Map<string, LoginFile>([
      ['glm', environmentLogin({ ANTHROPIC_BASE_URL: 'https://api.example.test', ANTHROPIC_AUTH_TOKEN: RAW })],
    ]);

    const [template] = environmentTemplates(files, valid);

    expect(template?.kind).toBe('withheld');
    expect(JSON.stringify(template)).not.toContain(RAW);
    expect(JSON.stringify(template)).not.toContain('api.example.test');
  });

  it('a raw secret hidden in one half of a halved login withholds the login too', () => {
    const files = new Map<string, LoginFile>([
      [
        'both',
        environmentLogin({}, {
          claude: { env: { X: 'ok' } },
          codex: { env: { OPENAI_API_KEY: RAW } },
        } as Partial<LoginFile>),
      ],
    ]);

    const [template] = environmentTemplates(files, valid);

    expect(template?.kind).toBe('withheld');
    expect(JSON.stringify(template)).not.toContain(RAW);
  });

  it('the wire schema has no field a secret value could travel in: a withheld row refuses an env or a value', () => {
    const row = { kind: 'withheld', id: 'glm', harness: 'claude-code', variables: ['A'] };

    expect(EnvironmentLoginTemplateSchema.safeParse(row).success).toBe(true);
    expect(EnvironmentLoginTemplateSchema.safeParse({ ...row, env: { A: RAW } }).success).toBe(false);
    expect(EnvironmentLoginTemplateSchema.safeParse({ ...row, value: RAW }).success).toBe(false);
  });

  it('is read live: the next call gives what the files now are', () => {
    const held = new Map<string, LoginFile>([['glm', environmentLogin({ A: 'one' })]]);

    const first = environmentTemplates(held, valid);
    held.set('glm', environmentLogin({ A: 'two' }));
    const second = environmentTemplates(held, valid);

    expect(JSON.stringify(first)).toContain('one');
    expect(JSON.stringify(second)).toContain('two');
    expect(JSON.stringify(second)).not.toContain('one');
  });
});
