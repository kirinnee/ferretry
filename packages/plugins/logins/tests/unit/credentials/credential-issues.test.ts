import { describe, it } from 'bun:test';
import should from 'should';
import type { LoginFile } from '../../../contract/index.ts';
import { credentialIssues, credentialOf } from '../../../daemon/lib/shared/credential.ts';

const issuesOf = (file: Record<string, unknown>): readonly string[] =>
  credentialIssues(credentialOf({ store: 'environment', ...file } as unknown as LoginFile));

const TOKEN = { ANTHROPIC_AUTH_TOKEN: '${secret:KEY}' };

describe('credentialIssues — a login that is not kept in the environment', () => {
  it('should be usable when it carries nothing that belongs to the environment', () => {
    should(issuesOf({ harness: 'claude-code', store: 'ferretry' })).eql([]);
  });

  it('should name each field that belongs only to an environment login', () => {
    should(
      issuesOf({
        harness: 'claude-code',
        store: 'host',
        env: TOKEN,
        preset: 'zai-glm',
        cloudCredential: 'azure-cli',
        codexProvider: { id: 'p' },
        claude: { env: {} },
        codex: { env: {} },
      }),
    ).eql(
      ['env', 'preset', 'cloudCredential', 'codexProvider', 'claude', 'codex'].map(
        field => `"${field}" belongs only to a login with store: environment — this one is store: host`,
      ),
    );
  });
});

describe('credentialIssues — an environment login with halves', () => {
  it('should be usable when its harness names one of its halves', () => {
    should(issuesOf({ harness: 'claude-code', claude: { env: TOKEN }, codex: { env: TOKEN } })).eql([]);
  });

  it('should say which halves the harness could name when it names one the login does not have', () => {
    should(issuesOf({ harness: 'claude-code', codex: { env: TOKEN } })).eql([
      '"harness: claude" must name one of this login\'s halves (codex)',
    ]);
  });

  it('should keep a Codex provider inside the codex half, not at the top and not in the claude half', () => {
    const issues = issuesOf({
      harness: 'codex',
      codexProvider: { id: 'p' },
      claude: { env: TOKEN, codexProvider: { id: 'p' } },
      codex: { env: TOKEN },
    });
    should(issues).containEql('"codexProvider" goes inside "codex:" when the login has halves');
    should(issues).containEql('"codexProvider" points Codex at a model provider — it goes in "codex:", not "claude:"');
  });
});

describe('credentialIssues — an environment login without halves', () => {
  it('should refuse a Codex provider on a login that is for Claude Code', () => {
    should(issuesOf({ harness: 'claude-code', env: TOKEN, codexProvider: { id: 'p' } })).eql([
      '"codexProvider" points Codex at a model provider — this login is for Claude Code',
    ]);
  });

  it('should ask for the variables that authenticate it when it sets none', () => {
    should(issuesOf({ harness: 'claude-code' })).eql([
      'a login kept in the environment must say which variables authenticate it, in "env"',
    ]);
  });

  it('should accept a cloud credential alone as what authenticates it', () => {
    should(issuesOf({ harness: 'claude-code', cloudCredential: 'azure-cli' })).eql([]);
  });
});

describe('credentialIssues — the Codex provider’s own needs', () => {
  const provider = (extra: Record<string, unknown>) => ({
    harness: 'codex',
    codexProvider: { id: 'gateway', ...extra },
  });

  it('should need the variable the provider sends its key from', () => {
    should(issuesOf({ ...provider({ keyVariable: 'GATEWAY_KEY' }), env: { OTHER: '1' } })).eql([
      'the Codex provider sends its key from GATEWAY_KEY, so "env" must set GATEWAY_KEY (as ${secret:NAME})',
    ]);
    should(issuesOf({ ...provider({ keyVariable: 'GATEWAY_KEY' }), env: { GATEWAY_KEY: '${secret:K}' } })).eql([]);
  });

  it('should need each variable its base URL names', () => {
    should(
      issuesOf({ ...provider({ baseUrl: 'https://{REGION}.gw.example.test/{TENANT}' }), env: { TENANT: 'acme' } }),
    ).eql(['the Codex provider\'s base URL names {REGION}, so "env" must set REGION']);
  });
});

describe('credentialIssues — a cloud credential and the variable it already provides', () => {
  it('should refuse a variable the cloud credential is given as, and accept one it is not', () => {
    should(
      issuesOf({ harness: 'claude-code', cloudCredential: 'aws-profile:prod', env: { AWS_PROFILE: 'other' } }),
    ).eql(['AWS_PROFILE comes from "cloudCredential" (aws-profile:prod) — leave it out of "env"']);
    should(issuesOf({ harness: 'claude-code', cloudCredential: 'aws-profile:prod', env: { AWS_REGION: 'x' } })).eql([]);
  });
});
