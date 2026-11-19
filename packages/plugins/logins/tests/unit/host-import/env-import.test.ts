import { describe, it } from 'bun:test';
import should from 'should';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { LoginFile } from '../../../contract/index.ts';
import type { LoginEnvCaller, LoginEnvImportRequest } from '../../../contract/env-import.ts';
import {
  LoginEnvImport,
  type LoginFileLook,
  refusedEnvImport,
} from '../../../daemon/features/host-import/env-import.ts';

const RAW_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const WRITTEN: ConfigWriteOutcome = { kind: 'written', etag: 'e2', loosened: [] };

/** A caller whose grants answer per capability: `fleet` and `secrets` are the ones asked. */
const caller = (allow: { fleet?: boolean; secrets?: boolean; stepUp?: 'secrets' | 'fleet' } = {}): LoginEnvCaller => {
  const governance: CallerGovernance = {
    governed: true,
    decide: demand => {
      const key = String((demand as { capability?: string }).capability);
      const allowed = allow[key as 'fleet' | 'secrets'] ?? true;
      return allowed
        ? ({ allowed: true, refusal: 'none' } as never)
        : ({ allowed: false, refusal: allow.stepUp === key ? 'step-up-required' : 'denied' } as never);
    },
  };
  return { governance };
};

const plain = (block: Record<string, string>) => Object.entries(block).map(([name, value]) => ({ name, value }));
const minted = (block: Record<string, string>) =>
  Object.entries(block).map(([name, secretName]) => ({ name, secretName }));

function harness(
  files: Record<string, LoginFile>,
  options: { answer?: ConfigWriteOutcome; look?: Partial<LoginFileLook>; between?: (edit: () => void) => void } = {},
) {
  const writes: { id: string; patch: Readonly<Record<string, unknown>>; ifMatch: string }[] = [];
  let etag = options.look?.etag ?? 'e1';
  const service = new LoginEnvImport({
    files: () => new Map(Object.entries(files)),
    look: async () => {
      const seen = { etag, state: options.look?.state ?? 'valid' } as LoginFileLook;
      // An edit lands after the disk was looked at and before the write.
      options.between?.(() => {
        etag = 'moved';
      });
      return seen;
    },
    write: async (id, patch, ifMatch) => {
      writes.push({ id, patch, ifMatch });
      return ifMatch === etag ? (options.answer ?? WRITTEN) : { kind: 'conflict' };
    },
  });
  return {
    service,
    writes,
  };
}

const request = (over: Partial<LoginEnvImportRequest> = {}): LoginEnvImportRequest => ({
  caller: caller(),
  login: 'you',
  harness: 'claude-code',
  plain: [],
  minted: [],
  ...over,
});
const you: Record<string, LoginFile> = { you: { harness: 'claude-code', store: 'host' } };

describe('LoginEnvImport', () => {
  it('should add plain text and a reference for a minted key to the login file, pinned to the etag it read', async () => {
    const { service, writes } = harness(you);
    const answer = await service.import(
      request({
        plain: plain({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' }),
        minted: minted({ ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' }),
      }),
    );
    should(writes).eql([
      {
        id: 'you',
        ifMatch: 'e1',
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

  it('should refuse a reference spelled in plain host text and never write it', async () => {
    const { service, writes } = harness(you);
    const answer = await service.import(
      request({ plain: plain({ SNEAKY: '${secret:SOMEONES_KEY}', OPT: '${secret?:SOMEONES_KEY}' }) }),
    );
    should(writes).eql([]);
    should(answer).match({ outcome: 'unchanged' });
    if (answer.outcome !== 'unchanged') throw new Error('expected unchanged');
    should(answer.skipped.map(entry => entry.name)).eql(['SNEAKY', 'OPT']);
  });

  it('should never write a raw secret: a login that was handed one is left untouched', async () => {
    const { service, writes } = harness(you);
    const answer = await service.import(request({ plain: plain({ ANTHROPIC_API_KEY: RAW_KEY }) }));
    should(writes).eql([]);
    should(answer.outcome).equal('unchanged');
    should(JSON.stringify(answer).includes(RAW_KEY)).be.false();
  });

  it('should keep a variable the login already has and add only the new ones', async () => {
    const { service, writes } = harness({
      you: { harness: 'claude-code', store: 'host', env: { REGION: 'eu', ONLY_MINE: 'x' } },
    });
    const answer = await service.import(request({ plain: plain({ REGION: 'us', FRESH: 'y' }) }));
    should(writes[0]?.patch).eql({ env: { REGION: 'eu', ONLY_MINE: 'x', FRESH: 'y' } });
    should(answer).match({ outcome: 'written', added: ['FRESH'], kept: ['REGION'] });
  });

  it('should count a name set in a harness half as already there', async () => {
    const { service, writes } = harness({
      you: { harness: 'claude-code', store: 'host', claude: { env: { REGION: 'eu' } } },
    });
    const answer = await service.import(request({ plain: plain({ REGION: 'us' }) }));
    should(writes).eql([]);
    should(answer).eql({ outcome: 'unchanged', kept: ['REGION'], skipped: [] });
  });

  it('should skip reserved names and unticked GitHub tokens with a sentence, and take a ticked one', async () => {
    const { service, writes } = harness({ you: { harness: 'codex', store: 'host' } });
    const answer = await service.import(
      request({
        harness: 'codex',
        plain: plain({ CODEX_HOME: '/else', KEPT: 'yes' }),
        minted: minted({ GH_TOKEN: 'GH_TOKEN', GITHUB_TOKEN: 'GITHUB_TOKEN' }),
        ticked: ['GITHUB_TOKEN'],
      }),
    );
    should(writes[0]?.patch).eql({ env: { KEPT: 'yes', GITHUB_TOKEN: '${secret:GITHUB_TOKEN}' } });
    if (answer.outcome !== 'written') throw new Error('expected a write');
    should(answer.skipped.map(entry => entry.name)).eql(['CODEX_HOME', 'GH_TOKEN']);
  });

  it('should refuse a login that is not there, and one of the other harness', async () => {
    const { service, writes } = harness({ you: { harness: 'codex', store: 'host' } });
    should(await service.import(request({ login: 'nobody', harness: 'codex', plain: plain({ A: '1' }) }))).eql({
      outcome: 'refused',
      reason: 'there is no login named nobody',
    });
    should(await service.import(request({ plain: plain({ A: '1' }) }))).eql({
      outcome: 'refused',
      reason: 'the login you is not a claude-code login',
    });
    should(writes).eql([]);
  });

  describe('who asks', () => {
    it('should refuse, before any write, a caller without fleet.configure or with no standing at all', async () => {
      const { service, writes } = harness(you);
      const denied = await service.import(request({ caller: caller({ fleet: false }), plain: plain({ A: '1' }) }));
      should(denied).eql({ outcome: 'refused', reason: 'this device may not change a login' });
      const stepUp = await service.import(
        request({ caller: caller({ fleet: false, stepUp: 'fleet' }), plain: plain({ A: '1' }) }),
      );
      should(stepUp).match({ outcome: 'refused', reason: /unlock this machine/u });
      const none = await service.import(request({ caller: { governance: undefined }, plain: plain({ A: '1' }) }));
      should(none).match({ outcome: 'refused', reason: /could not check/u });
      should(writes).eql([]);
    });

    it('should ask secrets.configure whenever a Vault reference is bound, and only then', async () => {
      const { service, writes } = harness(you);
      const noSecrets = caller({ secrets: false });
      const withKey = await service.import(
        request({ caller: noSecrets, minted: minted({ ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' }) }),
      );
      should(withKey).eql({ outcome: 'refused', reason: 'this device may not add a secret reference to a login' });
      should(writes).eql([]);
      // Plain text binds no reference, so fleet.configure is enough.
      should(await service.import(request({ caller: noSecrets, plain: plain({ REGION: 'eu' }) }))).match({
        outcome: 'written',
      });
      const stepUp = await service.import(
        request({
          caller: caller({ secrets: false, stepUp: 'secrets' }),
          minted: minted({ ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' }),
        }),
      );
      should(stepUp).match({ outcome: 'refused', reason: /passkey/u });
    });

    it('should ask the standing after the file was read, immediately before the write', async () => {
      let revoked = false;
      const sequence: string[] = [];
      const service = new LoginEnvImport({
        files: () => new Map(Object.entries(you)),
        look: async () => {
          sequence.push('look');
          // The grant is withdrawn while the file is being read.
          revoked = true;
          return { etag: 'e1', state: 'valid' };
        },
        write: async () => {
          sequence.push('write');
          return WRITTEN;
        },
      });
      const live: LoginEnvCaller = {
        governance: {
          governed: true,
          decide: () => ({ allowed: !revoked || sequence.length === 0, refusal: 'denied' }) as never,
        },
      };
      const answer = await service.import(request({ caller: live, plain: plain({ A: '1' }) }));
      should(answer).eql({ outcome: 'refused', reason: 'this device may not change a login' });
      should(sequence).eql(['look']);
    });

    it('should refuse every plugin but the setup import: the port it hands the others writes nothing', async () => {
      should(await refusedEnvImport.import(request({ plain: plain({ A: '1' }) }))).eql({
        outcome: 'refused',
        reason: "only the setup import may add to a login's environment",
      });
    });
  });

  describe('add only, against a login that moves', () => {
    it('should refuse a login with an edit held for the owner, so a held-only key is never dropped or replaced', async () => {
      const held = harness(you, { look: { state: 'held' } });
      const answer = await held.service.import(request({ plain: plain({ A: '1' }) }));
      should(held.writes).eql([]);
      should(answer).match({ outcome: 'refused', reason: /waiting for the owner/u });
      const invalid = harness(you, { look: { state: 'invalid' } });
      should(await invalid.service.import(request({ plain: plain({ A: '1' }) }))).match({ outcome: 'refused' });
      should(invalid.writes).eql([]);
    });

    it('should refuse when the login is edited between the read and the write: the write carries the etag that was read', async () => {
      const racing = harness(you, { between: edit => edit() });
      const answer = await racing.service.import(request({ plain: plain({ A: '1' }) }));
      should(answer).eql({ outcome: 'refused', reason: 'the login you changed while this was written; import again' });
      should(racing.writes).have.length(1);
      should(racing.writes[0]?.ifMatch).equal('e1');
    });

    it('should hold the import when the config layer holds it, and say what the owner must confirm', async () => {
      const held = harness(you, { answer: { kind: 'held', etag: 'e', id: 'h1', sentences: ['confirm this'] } });
      should(await held.service.import(request({ plain: plain({ A: '1' }) }))).match({
        outcome: 'held',
        sentences: ['confirm this'],
      });
    });
  });

  it('should mask every imported value, and every key-shaped name, in a refusal it repeats', async () => {
    const keyed = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const refused = harness(you, {
      answer: {
        kind: 'refused',
        reason: 'schema',
        issues: [{ path: 'env', message: `the value hunter2-plain-value of ${keyed} is not allowed` }],
      },
    });
    const answer = await refused.service.import(
      request({ plain: plain({ NOTE: 'hunter2-plain-value', [keyed]: 'harmless' }) }),
    );
    should(answer).eql({
      outcome: 'refused',
      reason: 'the login file was refused: the value *** of (a variable whose name looks like a key) is not allowed',
    });
  });

  it('should not repeat a key-shaped name in what it added or kept', async () => {
    const keyed = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const { service } = harness(you);
    const answer = await service.import(request({ plain: plain({ [keyed]: 'harmless' }) }));
    should(JSON.stringify(answer).includes(keyed)).be.false();
  });
});
