import { describe, it } from 'bun:test';
import should from 'should';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { LoginFile } from '../../../contract/index.ts';
import { LoginEnvImport } from '../../../daemon/features/host-import/env-import.ts';

const RAW_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

const WRITTEN: ConfigWriteOutcome = { kind: 'written', etag: 'e1', loosened: [] };

function harness(files: Record<string, LoginFile>, answer: ConfigWriteOutcome = WRITTEN) {
  const writes: { id: string; patch: Readonly<Record<string, unknown>> }[] = [];
  const service = new LoginEnvImport({
    files: () => new Map(Object.entries(files)),
    write: async (id, patch) => {
      writes.push({ id, patch });
      return answer;
    },
  });
  return { service, writes };
}

describe('LoginEnvImport', () => {
  it('should add the variables to the login file, plain and as references, and nothing else', async () => {
    const { service, writes } = harness({ you: { harness: 'claude-code', store: 'host' } });
    const answer = await service.import({
      login: 'you',
      harness: 'claude-code',
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}' },
    });
    should(writes).eql([
      {
        id: 'you',
        patch: {
          env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}' },
        },
      },
    ]);
    should(answer).eql({
      outcome: 'written',
      added: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
      kept: [],
      skipped: [],
      sentences: [],
    });
  });

  it('should never write a raw secret: a login that was handed one is left untouched', async () => {
    const { service, writes } = harness({ you: { harness: 'claude-code', store: 'host' } });
    const answer = await service.import({ login: 'you', harness: 'claude-code', env: { ANTHROPIC_API_KEY: RAW_KEY } });
    should(writes).eql([]);
    should(answer.outcome).equal('unchanged');
    should(JSON.stringify(answer).includes(RAW_KEY)).be.false();
  });

  it('should keep a variable the login already has and add only the new ones', async () => {
    const { service, writes } = harness({
      you: { harness: 'claude-code', store: 'host', env: { REGION: 'eu', ONLY_MINE: 'x' } },
    });
    const answer = await service.import({ login: 'you', harness: 'claude-code', env: { REGION: 'us', FRESH: 'y' } });
    should(writes[0]?.patch).eql({ env: { REGION: 'eu', ONLY_MINE: 'x', FRESH: 'y' } });
    should(answer).match({ outcome: 'written', added: ['FRESH'], kept: ['REGION'] });
  });

  it('should count a name set in a harness half as already there', async () => {
    const { service, writes } = harness({
      you: { harness: 'claude-code', store: 'host', claude: { env: { REGION: 'eu' } } },
    });
    const answer = await service.import({ login: 'you', harness: 'claude-code', env: { REGION: 'us' } });
    should(writes).eql([]);
    should(answer).eql({ outcome: 'unchanged', kept: ['REGION'], skipped: [] });
  });

  it('should skip reserved names and unticked GitHub tokens with a sentence, and take a ticked one', async () => {
    const { service, writes } = harness({ you: { harness: 'codex', store: 'host' } });
    const answer = await service.import({
      login: 'you',
      harness: 'codex',
      env: {
        CODEX_HOME: '/else',
        GH_TOKEN: '${secret:GH_TOKEN}',
        GITHUB_TOKEN: '${secret:GITHUB_TOKEN}',
        KEPT: 'yes',
      },
      ticked: ['GITHUB_TOKEN'],
    });
    should(writes[0]?.patch).eql({ env: { GITHUB_TOKEN: '${secret:GITHUB_TOKEN}', KEPT: 'yes' } });
    if (answer.outcome !== 'written') throw new Error('expected a write');
    should(answer.skipped.map(entry => entry.name)).eql(['CODEX_HOME', 'GH_TOKEN']);
  });

  it('should refuse a login that is not there, and one of the other harness', async () => {
    const { service, writes } = harness({ you: { harness: 'codex', store: 'host' } });
    should(await service.import({ login: 'nobody', harness: 'codex', env: { A: '1' } })).eql({
      outcome: 'refused',
      reason: 'there is no login named nobody',
    });
    should(await service.import({ login: 'you', harness: 'claude-code', env: { A: '1' } })).eql({
      outcome: 'refused',
      reason: 'the login you is not a claude-code login',
    });
    should(writes).eql([]);
  });

  it('should say when the owner must confirm, and when the file was refused or moved', async () => {
    const held = harness(
      { you: { harness: 'claude-code', store: 'host' } },
      { kind: 'held', etag: 'e', id: 'h1', sentences: ['confirm this'] },
    );
    should(await held.service.import({ login: 'you', harness: 'claude-code', env: { A: '1' } })).match({
      outcome: 'held',
      sentences: ['confirm this'],
    });
    const conflict = harness({ you: { harness: 'claude-code', store: 'host' } }, { kind: 'conflict' });
    should(await conflict.service.import({ login: 'you', harness: 'claude-code', env: { A: '1' } })).match({
      outcome: 'refused',
    });
  });

  it('should mask every imported value in a refusal it repeats', async () => {
    const refused = harness(
      { you: { harness: 'claude-code', store: 'host' } },
      {
        kind: 'refused',
        reason: 'schema',
        issues: [{ path: 'env', message: 'the value hunter2-plain-value is not allowed' }],
      },
    );
    const answer = await refused.service.import({
      login: 'you',
      harness: 'claude-code',
      env: { NOTE: 'hunter2-plain-value' },
    });
    should(answer).eql({ outcome: 'refused', reason: 'the login file was refused: the value *** is not allowed' });
  });
});
