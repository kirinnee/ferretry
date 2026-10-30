/**
 * Cloning a machine between two REAL daemons: an API-key login arrives WORKING, a sign-in arrives EMPTY.
 *
 * Owner decision 2026-10-20 (docs/secrets.md): "don't copy sign-in, copy env var credentials only". The
 * source runs one LiteLLM-style API-key login (its key `${secret:LITELLM_API_KEY}`, its provider a fake
 * server on this machine) and one Claude Code sign-in whose credential file holds sentinel tokens. The
 * test plays the browser: it reads the source's clone bundle, stages and applies `clone.import` on the
 * target, then runs the sealed copy of the keys the bundle names — and then runs the login's **Test** on
 * the TARGET, which sends the copied key to the fake provider and passes.
 *
 * WHAT ONLY THIS TIER CAN PROVE:
 *
 * - the key that arrived is the key that works: the fake provider answers 200 only to the exact bearer
 *   value, and it is the target daemon's own outbound holder that sends it;
 * - before the copy the same Test fails, so the copy is what made the login work;
 * - the sign-in is an empty slot on the target (`needs_sign_in`, cloned from the source) and NOTHING of it
 *   travelled — not in the bundle, not in anything the browser carried, not in a single file of the
 *   target's state home;
 * - a sign-in token the source's vault holds (an MCP server's access token) is refused by the export.
 *
 * Both daemons are driven with their own host admin token, so neither asks for a passkey. The passkey a
 * governed device proves for the export is the route's, pinned by `tests/unit/runtime/mounts/secret-clone.test.ts`.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAccountModel } from '@ferretry/fleet';
import {
  FleetCloneBundleSchema,
  FleetCredentialListSchema,
  FleetCredentialTestResultSchema,
  mcpOAuthSecretNames,
  SecretExportResponseSchema,
  SecretImportOfferSchema,
  SecretImportResultSchema,
  SecretListSchema,
  secretReferencesIn,
} from '@ferretry/protocol';
import should from 'should';
import { writeModelFiles } from '../fleet/config-files-fixture.ts';
import { type BootedDaemon, bootDaemon, stopBootedDaemons } from '../support/booted-daemon.ts';
import { cleanupTempDirectories } from '../support/repository.ts';
import { waitForValue } from '../support/wait-for.ts';

const KEY_NAME = 'LITELLM_API_KEY';
const KEY_VALUE = 'sk-litellm-clone-journey-0123456789';
const SENTINEL_ACCESS = 'SENTINEL-ACCESS-TOKEN-MUST-NOT-TRAVEL';
const SENTINEL_REFRESH = 'SENTINEL-REFRESH-TOKEN-MUST-NOT-TRAVEL';
const SENTINEL_MCP = 'SENTINEL-MCP-ACCESS-TOKEN-MUST-NOT-TRAVEL';

const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await stopBootedDaemons();
  await cleanupTempDirectories();
});

/** A provider on this machine: lists models to the exact bearer value and says 401 to anything else. */
function fakeProvider(): {
  readonly port: number;
  readonly authorized: () => number;
  readonly refused: () => number;
} {
  let authorized = 0;
  let refused = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      if (new URL(request.url).pathname !== '/v1/models') return new Response('not found', { status: 404 });
      if (request.headers.get('authorization') === `Bearer ${KEY_VALUE}`) {
        authorized += 1;
        return Response.json({ data: [{ id: 'fake-model' }] });
      }
      refused += 1;
      return Response.json({ error: 'bad key' }, { status: 401 });
    },
  });
  servers.push(server);
  return { port: Number(server.port), authorized: () => authorized, refused: () => refused };
}

/** The source's configuration: an API-key login and a Claude Code sign-in, one runtime each. */
const sourceModel = (providerPort: number) =>
  parseAccountModel({
    version: 2,
    credentials: {
      'litellm-env': {
        harness: 'claude',
        store: 'environment',
        label: 'LiteLLM',
        preset: 'litellm',
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`,
          ANTHROPIC_AUTH_TOKEN: `\${secret:${KEY_NAME}}`,
        },
      },
      'claude-work': { harness: 'claude', store: 'ferretry', label: 'Work' },
    },
    components: { mcp: { notes: { command: 'notes-server' } } },
    profiles: { default: { layers: ['mcp/notes'] } },
    runtimes: {
      'litellm-default': { credential: 'litellm-env', profile: 'default' },
      'claude-default': { credential: 'claude-work', profile: 'default' },
    },
  });

/** Every file under `directory`, as text, by path. */
async function everyFile(directory: string): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(path, await readFile(path, 'utf8').catch(() => ''));
    }
  };
  await walk(directory);
  return files;
}

async function testLogin(daemon: BootedDaemon, id: string) {
  const answer = await daemon.post(`/v1/fleet/credentials/${id}/test`, {});
  should(answer.status).equal(200);
  return FleetCredentialTestResultSchema.parse(await answer.json());
}

/**
 * The credential list once no check is in flight. The usage pass takes a per-credential flight over a
 * login it has just learned of, and a list read while it is out answers "checking" for that row — true,
 * and no answer about the sign-in's slot. Waiting is on the daemon's own word for "no read is running".
 */
async function settledCredentials(daemon: BootedDaemon) {
  return await waitForValue(async () => {
    const listed = FleetCredentialListSchema.parse(await (await daemon.get('/v1/fleet/credentials')).json());
    return listed.credentials.every(credential => credential.status.word !== 'checking') ? listed : undefined;
  }, 'no credential to be checked any more after the copy');
}

describe('cloning an API-key login between two booted daemons', () => {
  it('should copy the login with its key so it works, and leave the sign-in an empty slot', async () => {
    // Arrange — the source holds the key, a sign-in's tokens and an MCP sign-in token; the target holds nothing.
    const provider = fakeProvider();
    const [source, target] = await Promise.all([
      bootDaemon('source', {
        seed: async home => {
          await writeModelFiles(join(home, 'config'), sourceModel(provider.port));
          const login = join(home, 'fleet', 'credentials', 'claude-work');
          await mkdir(login, { recursive: true });
          await writeFile(
            join(login, '.credentials.json'),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: SENTINEL_ACCESS,
                refreshToken: SENTINEL_REFRESH,
                expiresAt: 4_102_444_800_000,
              },
            }),
            { mode: 0o600 },
          );
        },
      }),
      bootDaemon('target'),
    ]);
    const mcpToken = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;
    should((await source.post('/v1/secrets', { name: KEY_NAME, value: KEY_VALUE })).status).equal(200);
    should((await source.post('/v1/secrets', { name: mcpToken, value: SENTINEL_MCP })).status).equal(200);
    const carried: string[] = [];

    // Act — the browser: read the source's bundle, clone it onto the target, then seal the keys it names.
    const exported = await (await source.get('/v1/fleet/export')).text();
    carried.push(exported);
    // Both test daemons share this host's name, which a real pair never does; a clone refuses its own machine.
    const bundle = FleetCloneBundleSchema.parse({ ...JSON.parse(exported), machine: 'work-linux' });
    const staged = await target.post('/v1/fleet/proposals', {
      change: { kind: 'clone.import', mode: 'alongside', bundle },
    });
    const stagedBody = (await staged.json()) as { id: string };
    const applied = await target.post(`/v1/fleet/proposals/${stagedBody.id}/apply`);
    const beforeCopy = await testLogin(target, 'litellm-env');
    const keyNames = [
      ...new Set(
        bundle.credentials
          .filter(credential => credential.store === 'environment')
          .flatMap(credential =>
            secretReferencesIn(JSON.stringify([credential.env ?? {}, credential.claude ?? {}, credential.codex ?? {}])),
          ),
      ),
    ];
    const offerResponse = await target.post('/v1/secrets/imports');
    const offer = SecretImportOfferSchema.parse(await offerResponse.json());
    const exportResponse = await source.post(`/v1/secrets/exports/${offer.importId}`, { offer, names: keyNames });
    const exportText = await exportResponse.text();
    carried.push(exportText);
    const { bundle: sealed } = SecretExportResponseSchema.parse(JSON.parse(exportText));
    const importResponse = await target.post(`/v1/secrets/imports/${offer.importId}`, { bundle: sealed });
    const imported = SecretImportResultSchema.parse(await importResponse.json());
    const afterCopy = await testLogin(target, 'litellm-env');
    const credentials = await settledCredentials(target);
    const held = SecretListSchema.parse(await (await target.get('/v1/secrets')).json());
    const refusedMcp = await source.post(`/v1/secrets/exports/${offer.importId}`, { offer, names: [mcpToken] });
    const refusedMcpText = await refusedMcp.text();
    const targetFiles = await everyFile(target.home);

    // Assert — the bundle names the key and the sign-in's slot, and carries neither token.
    should(keyNames).deepEqual([KEY_NAME]);
    should(bundle.credentials.map(credential => credential.id).toSorted()).deepEqual(['claude-work', 'litellm-env']);
    should(applied.status).equal(200);
    // Before the copy the login has no key to send; after it, the target's own outbound holder sends the copied one.
    should(beforeCopy.ok).equal(false);
    should(afterCopy.ok).equal(true);
    should(afterCopy.code).equal('ok');
    should(provider.authorized()).equal(1);
    should(provider.refused()).equal(0);
    should(imported.imported).deepEqual([KEY_NAME]);
    should(held.secrets.map(secret => secret.name)).deepEqual([KEY_NAME]);
    // The sign-in is an empty slot, cloned from the source, and the API-key login is not.
    const slot = credentials.credentials.find(credential => credential.id === 'claude-work');
    should(slot?.status.word).equal('needs_sign_in');
    should(slot?.clonedFrom).be.a.String();
    should(credentials.credentials.find(credential => credential.id === 'litellm-env')?.store).equal('environment');
    // Nothing of any sign-in travelled: not in what the browser carried, not in a single file on the target.
    for (const text of carried)
      for (const secret of [KEY_VALUE, SENTINEL_ACCESS, SENTINEL_REFRESH, SENTINEL_MCP])
        should(text).not.containEql(secret);
    const leaks = [...targetFiles]
      .filter(([, text]) => [SENTINEL_ACCESS, SENTINEL_REFRESH, SENTINEL_MCP].some(secret => text.includes(secret)))
      .map(([path]) => path);
    should(leaks).deepEqual([]);
    should(exportResponse.status).equal(200);
    // A sign-in token the source's vault holds is refused by the export, whoever asks.
    should(refusedMcp.status).equal(400);
    should(refusedMcpText).not.containEql(SENTINEL_MCP);
  }, 90_000);
});
