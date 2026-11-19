import { describe, it } from 'bun:test';
import should from 'should';
import { GITHUB_TOKEN_NAMES, GITHUB_TOKEN_SENTENCE } from '../../../contract/env-import.ts';
import { MASKED_NAME, planLoginEnv } from '../../../daemon/features/host-import/env-plan.ts';

const RAW_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const RAW_PAT = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

const plain = (block: Record<string, string>) => Object.entries(block).map(([name, value]) => ({ name, value }));
const minted = (block: Record<string, string>) =>
  Object.entries(block).map(([name, secretName]) => ({ name, secretName }));

describe('planLoginEnv', () => {
  it('should keep plain values as written and write a reference only for a minted variable', () => {
    const plan = planLoginEnv(
      plain({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' }),
      minted({ ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' }),
    );
    should(plan.env).eql({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}',
    });
    should(plan.skipped).eql([]);
  });

  it('should refuse any reference syntax in plain host text, the optional form included, with a warning', () => {
    const plan = planLoginEnv(
      plain({
        WHOLE: '${secret:ANTHROPIC_API_KEY}',
        MIXED: 'prefix-${secret:LABEL_KEY}-suffix',
        OPTIONAL: '${secret?:ANTHROPIC_API_KEY}',
        MALFORMED: '${secret:lower}',
        SPACED: '${ secret:X}',
        FINE: 'plain',
      }),
      [],
    );
    should(plan.env).eql({ FINE: 'plain' });
    should(plan.skipped.map(entry => entry.name)).eql(['WHOLE', 'MIXED', 'OPTIONAL', 'MALFORMED', 'SPACED']);
    for (const entry of plan.skipped) should(entry.because).match(/secret reference/u);
  });

  it('should refuse a minted entry whose secret name is not a secret name', () => {
    const plan = planLoginEnv([], minted({ A: 'lower', B: '${secret:X}', C: '' }));
    should(plan.env).eql({});
    should(plan.skipped.map(entry => entry.name)).eql(['A', 'B', 'C']);
  });

  it('should take a variable once: the second spelling of a name is skipped', () => {
    const plan = planLoginEnv(plain({ REGION: 'eu' }), minted({ REGION: 'REGION_KEY' }));
    should(plan.env).eql({ REGION: 'eu' });
    should(plan.skipped).eql([{ name: 'REGION', because: 'it was named twice' }]);
  });

  it('should never take a raw secret, by name or by shape, and never repeat it in a sentence', () => {
    const plan = planLoginEnv(
      plain({ ANTHROPIC_API_KEY: RAW_KEY, SOMETHING_ELSE: RAW_PAT, MY_PASSWORD: 'correct-horse-battery' }),
      [],
    );
    should(plan.env).eql({});
    should(plan.skipped.map(entry => entry.name)).eql(['ANTHROPIC_API_KEY', 'SOMETHING_ELSE', 'MY_PASSWORD']);
    const spoken = JSON.stringify(plan.skipped);
    for (const value of [RAW_KEY, RAW_PAT, 'correct-horse-battery']) should(spoken.includes(value)).be.false();
  });

  it('should not repeat a variable name that is shaped like a key', () => {
    const keyed = `ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`;
    const plan = planLoginEnv(plain({ [keyed]: RAW_KEY, CODEX_HOME: '/else' }), []);
    should(plan.skipped.map(entry => entry.name)).eql([MASKED_NAME, 'CODEX_HOME']);
    should(JSON.stringify(plan.skipped).includes(keyed)).be.false();
    // A name that is shaped like a key is masked on every road to a sentence, the GitHub token one included.
    const reserved = planLoginEnv(plain({ [keyed]: 'x' }), minted({ [keyed]: 'SOME_KEY' }));
    should(JSON.stringify(reserved.skipped).includes(keyed)).be.false();
  });

  it('should skip every reserved name with a sentence', () => {
    const plan = planLoginEnv(
      plain({
        CLAUDE_CONFIG_DIR: '/somewhere',
        CODEX_HOME: '/else',
        CODEX_SQLITE_HOME: '/x',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/y',
        KEPT: 'yes',
      }),
      minted({ CODEX_HOME: 'CODEX_KEY' }),
    );
    should(plan.env).eql({ KEPT: 'yes' });
    should(plan.skipped.map(entry => entry.name)).eql([
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'CODEX_SQLITE_HOME',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'CODEX_HOME',
    ]);
    for (const entry of plan.skipped) should(entry.because).equal('Ferretry sets it for each runtime');
  });

  it('should leave the three GitHub token variables out by default, whatever they hold, and say why', () => {
    const plan = planLoginEnv(
      plain({ GITHUB_TOKEN: RAW_PAT }),
      minted({ GH_TOKEN: 'GH_TOKEN', GH_ENTERPRISE_TOKEN: 'GH_ENTERPRISE_TOKEN' }),
    );
    should(plan.env).eql({});
    should(plan.skipped.map(entry => entry.name).sort()).eql([...GITHUB_TOKEN_NAMES].sort());
    for (const entry of plan.skipped) should(entry.because).equal(GITHUB_TOKEN_SENTENCE);
  });

  it('should bring a GitHub token in only when it is ticked, and only as a reference', () => {
    const plan = planLoginEnv(
      [],
      minted({ GH_TOKEN: 'GH_TOKEN', GITHUB_TOKEN: 'GITHUB_TOKEN' }),
      new Set(['GH_TOKEN']),
    );
    should(plan.env).eql({ GH_TOKEN: '${secret:GH_TOKEN}' });
    should(plan.skipped.map(entry => entry.name)).eql(['GITHUB_TOKEN']);
    // Ticking does not make a raw token acceptable.
    should(planLoginEnv(plain({ GH_TOKEN: RAW_PAT }), [], new Set(['GH_TOKEN'])).env).eql({});
  });

  it('should skip a name that is not a variable name without repeating it', () => {
    const plan = planLoginEnv(plain({ 'not a name': 'x' }), minted({ 'also not': 'SECRET_ONE' }));
    should(plan.env).eql({});
    should(plan.skipped.map(entry => entry.name)).eql([
      '(a name that is not an environment variable name)',
      '(a name that is not an environment variable name)',
    ]);
  });
});
