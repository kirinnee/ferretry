import { describe, it } from 'bun:test';
import should from 'should';
import { GITHUB_TOKEN_NAMES, GITHUB_TOKEN_SENTENCE } from '../../../contract/env-import.ts';
import { planLoginEnv } from '../../../daemon/features/host-import/env-plan.ts';

const RAW_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const RAW_PAT = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('planLoginEnv', () => {
  it('should keep plain values as written and secret references as references', () => {
    const plan = planLoginEnv({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}',
      MODEL_LABEL: 'prefix-${secret:LABEL_KEY}-suffix',
    });
    should(plan.env).eql({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}',
      MODEL_LABEL: 'prefix-${secret:LABEL_KEY}-suffix',
    });
    should(plan.skipped).eql([]);
  });

  it('should never take a raw secret, by name or by shape, and never repeat it in a sentence', () => {
    const plan = planLoginEnv({
      ANTHROPIC_API_KEY: RAW_KEY,
      SOMETHING_ELSE: RAW_PAT,
      MY_PASSWORD: 'correct-horse-battery',
    });
    should(plan.env).eql({});
    should(plan.skipped.map(entry => entry.name)).eql(['ANTHROPIC_API_KEY', 'SOMETHING_ELSE', 'MY_PASSWORD']);
    const spoken = JSON.stringify(plan.skipped);
    for (const value of [RAW_KEY, RAW_PAT, 'correct-horse-battery']) should(spoken.includes(value)).be.false();
  });

  it('should skip every reserved name with a sentence', () => {
    const plan = planLoginEnv({
      CLAUDE_CONFIG_DIR: '/somewhere',
      CODEX_HOME: '/else',
      CODEX_SQLITE_HOME: '/x',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/y',
      KEPT: 'yes',
    });
    should(plan.env).eql({ KEPT: 'yes' });
    should(plan.skipped.map(entry => entry.name)).eql([
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'CODEX_SQLITE_HOME',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    ]);
    for (const entry of plan.skipped) should(entry.because).equal('Ferretry sets it for each runtime');
  });

  it('should leave the three GitHub token variables out by default, whatever they hold, and say why', () => {
    const block = {
      GH_TOKEN: '${secret:GH_TOKEN}',
      GITHUB_TOKEN: RAW_PAT,
      GH_ENTERPRISE_TOKEN: '${secret:GH_ENTERPRISE_TOKEN}',
    };
    const plan = planLoginEnv(block);
    should(plan.env).eql({});
    should(plan.skipped).eql(GITHUB_TOKEN_NAMES.map(name => ({ name, because: GITHUB_TOKEN_SENTENCE })));
  });

  it('should bring a GitHub token in only when it is ticked, and only as a reference', () => {
    const plan = planLoginEnv(
      { GH_TOKEN: '${secret:GH_TOKEN}', GITHUB_TOKEN: '${secret:GITHUB_TOKEN}' },
      new Set(['GH_TOKEN']),
    );
    should(plan.env).eql({ GH_TOKEN: '${secret:GH_TOKEN}' });
    should(plan.skipped.map(entry => entry.name)).eql(['GITHUB_TOKEN']);
    // Ticking does not make a raw token acceptable.
    should(planLoginEnv({ GH_TOKEN: RAW_PAT }, new Set(['GH_TOKEN'])).env).eql({});
  });

  it('should skip a malformed reference and a name that is not a variable name', () => {
    const plan = planLoginEnv({ BAD_REF: '${secret:lower}', 'not a name': 'x' });
    should(plan.env).eql({});
    should(plan.skipped.map(entry => entry.name)).eql(['BAD_REF', '(a name that is not an environment variable name)']);
  });
});
