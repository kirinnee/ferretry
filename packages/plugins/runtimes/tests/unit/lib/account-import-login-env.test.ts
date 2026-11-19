import { describe, it } from 'bun:test';
import should from 'should';
import { type HostDocumentRead, type HostHarnessScan } from '../../../daemon/lib/account/import.ts';
import { mergeImport, planImport } from '../../../daemon/lib/account/import-plan.ts';

const FAKE_KEY = 'sk-placeholder-not-a-real-key-0000';
const digest = (text: string): string => String(Bun.hash(text));
const text = (source: string, body: string): HostDocumentRead => ({
  kind: 'text',
  source,
  text: body,
  bytes: body.length,
});
const absent = (source: string): HostDocumentRead => ({ kind: 'absent', source });

const claude = (settings: object): HostHarnessScan => ({
  harness: 'claude',
  command: '/bin/claude',
  login: { state: 'signed-in', email: 'person@example.test' },
  instructions: absent('/h/.claude/CLAUDE.md'),
  settings: text('/h/.claude/settings.json', JSON.stringify(settings)),
  mcp: absent('/h/.claude.json'),
  skills: [],
  missingCommands: [],
  problems: [],
});

const SETTINGS = {
  env: {
    ANTHROPIC_API_KEY: FAKE_KEY,
    ANTHROPIC_BASE_URL: 'https://gateway.example.test',
    GITHUB_TOKEN: 'ghp_placeholder000000000000000000',
    CLAUDE_CONFIG_DIR: '/else',
    PASSED_ON: '${secret:SOMEONES_KEY}',
  },
};

describe('planImport — the harness env for the login (r9 A8)', () => {
  it('should hand the env over as host text and as the names of the keys it files, for the login the apply selected', () => {
    const plan = planImport([claude(SETTINGS)], { digest, tickedEnv: ['GITHUB_TOKEN'] });
    should(plan.loginEnvs).have.length(1);
    const env = plan.loginEnvs[0];
    should(env?.harness).equal('claude');
    should(env?.login).equal('claude-you');
    should(env?.plain.map(variable => variable.name)).eql(['ANTHROPIC_BASE_URL', 'PASSED_ON']);
    should(env?.minted).eql([
      { name: 'ANTHROPIC_API_KEY', secretName: 'ANTHROPIC_API_KEY' },
      { name: 'GITHUB_TOKEN', secretName: 'GITHUB_TOKEN' },
    ]);
    // The login is the credential the plan creates, and a minted key is one the plan files.
    should(Object.keys(plan.credentials)).containEql('claude-you');
    const filed = plan.secrets.map(secret => secret.name);
    for (const minted of env?.minted ?? []) should(filed).containEql(minted.secretName);
  });

  it('should file no key and bind nothing for a GitHub token that is not ticked, and still list its name for the scan', () => {
    for (const plan of [
      planImport([claude(SETTINGS)], { digest }),
      planImport([claude(SETTINGS)], { digest, tickedEnv: [] }),
    ]) {
      should(plan.secrets.map(secret => secret.name)).eql(['ANTHROPIC_API_KEY']);
      should(plan.loginEnvs[0]?.minted.map(entry => entry.name)).eql(['ANTHROPIC_API_KEY']);
      should(JSON.stringify(plan.components)).not.containEql('GITHUB_TOKEN');
      should(plan.preview.harnesses[0]?.secretKeys).containEql('env.GITHUB_TOKEN');
    }
  });

  it('should file and bind a GitHub token that is ticked, and no other that is not', () => {
    const plan = planImport([claude(SETTINGS)], { digest, tickedEnv: ['GITHUB_TOKEN'] });
    should(plan.secrets.map(secret => secret.name).sort()).eql(['ANTHROPIC_API_KEY', 'GITHUB_TOKEN']);
    should(plan.loginEnvs[0]?.minted.map(entry => entry.name)).containEql('GITHUB_TOKEN');
    // Another token name, unticked, stays out.
    const other = planImport(
      [claude({ env: { GH_TOKEN: 'ghp_placeholder000000000000000000', GITHUB_TOKEN: FAKE_KEY } })],
      {
        digest,
        tickedEnv: ['GITHUB_TOKEN'],
      },
    );
    should(other.secrets.map(secret => secret.name)).eql(['GITHUB_TOKEN']);
  });

  it('should not repeat a variable name that is shaped like a key in the scan or a warning', () => {
    const keyed = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const plan = planImport([claude({ env: { [keyed]: FAKE_KEY, CLAUDE_CONFIG_DIR: '/else' } })], { digest });
    const spoken = JSON.stringify([plan.preview, plan.notes, plan.secrets.map(secret => secret.from)]);
    should(spoken.includes(keyed)).be.false();
    should(plan.preview.harnesses[0]?.secretKeys).eql([]);
    should(plan.preview.harnesses[0]?.problems.join(' ')).containEql('env.(a variable whose name looks like a key)');
  });

  it('should derive no Vault name from a variable name shaped like a key', () => {
    const keyed = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const plan = planImport([claude({ env: { [keyed]: FAKE_KEY, ANTHROPIC_API_KEY: FAKE_KEY } })], { digest });
    should(plan.secrets.map(secret => secret.name)).eql(['ANTHROPIC_API_KEY']);
    should(plan.loginEnvs[0]?.minted.map(entry => entry.name)).eql(['ANTHROPIC_API_KEY']);
    should(JSON.stringify(plan).includes(keyed)).be.false();
    should(JSON.stringify(plan).includes(keyed.toUpperCase())).be.false();
  });

  it('should bring in no env when the person left the env item out', () => {
    const plan = planImport([claude(SETTINGS)], { digest, skip: ['claude-code:env'] });
    should(plan.loginEnvs).eql([]);
  });

  it('should not repeat the env on Import again, so a second run files no second key', () => {
    const scans = [claude(SETTINGS)];
    const first = planImport(scans, { digest });
    const existing = mergeImport(undefined, first);
    const again = planImport(scans, { digest, existing, record: first.record, existingSecrets: ['ANTHROPIC_API_KEY'] });
    should(again.loginEnvs).eql([]);
    should(again.secrets.map(secret => secret.name)).not.containEql('ANTHROPIC_API_KEY_2');
  });
});
