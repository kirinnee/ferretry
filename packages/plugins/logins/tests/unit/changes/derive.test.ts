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

  it('should accept a documented flag whose name only mentions auth or a key, and a composite reference', () => {
    const env = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '3600000',
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
