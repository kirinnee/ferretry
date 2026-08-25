/**
 * A profile authenticating an account, through the real composition root.
 *
 * WHAT ONLY THIS TIER CAN PROVE. Every piece below has unit and adapter coverage of its own, and none
 * of that touches the one thing most likely to be wrong: whether `bin/fyd.ts` actually HANDS the
 * resolver to the launcher and the fleet reference source to the secret listing. `bin/**` is in
 * neither coverage ledger, so a wiring that is merely typechecked is a wiring nobody executes.
 *
 * IT SPENDS NOTHING. No harness is launched and no model is asked anything: the start under test is
 * one whose credential is MISSING, so the refusal happens in the launcher before a pane exists, and
 * the listing is a store read. Nothing here reaches a provider.
 *
 * NO REAL CREDENTIAL APPEARS HERE. The value written into the vault is a fixture string.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFleetManifest } from '@ferretry/fleet';
import { SecretListSchema } from '@ferretry/protocol';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import { NO_RELAY_DIRECTORY, type RelayAdvertisement } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const ACCOUNT = '00000000-0000-4000-8000-0000000000f1';
const WRAPPER = 'claude-auto-profiled';
const GENERATED_AT = '2027-01-15T08:00:00.000Z';
/** Long enough for the store to accept, and plainly not a credential. */
const FIXTURE_VALUE = 'fixture-value-not-a-credential';

afterEach(async () => {
  await cleanupTempDirectories();
});

/**
 * The production composition with its one off-machine collaborator held offline.
 *
 * A boot dials the hosted relay directory, and a throwaway daemon in a test must neither register an
 * identity with that service nor make this result depend on it being reachable.
 */
function world(): DaemonWorld {
  return {
    ...buildWorld({}, {}),
    relayDirectory: { read: async (): Promise<RelayAdvertisement> => NO_RELAY_DIRECTORY },
  };
}

async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('the fixture server reported no port');
  return port;
}

/**
 * A fleet whose one account takes its credential from this daemon's own store.
 *
 * BOTH DOCUMENTS, because the two halves read different ones on purpose: the launch path reads the
 * published manifest, so a typo in the configuration cannot refuse every session, and the reference
 * listing reads the configuration, because that is the only place that knows WHICH PROFILE set a
 * variable. A fixture that wrote one of them would leave half of this untested.
 */
async function seedProfiledFleet(home: string): Promise<string> {
  const binary = join(home, 'bin');
  await mkdir(binary, { recursive: true });
  const executable = join(binary, WRAPPER);
  // The requirement line a real generated wrapper carries. Never executed here — the launch is
  // refused before anything is run — but written as the real one is so the fixture cannot drift.
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      `: "\${ANTHROPIC_API_KEY:?ferretry: ANTHROPIC_API_KEY is not set — this account takes it from Ferretry's secret store (secret WORK_KEY).}"`,
      `export CLAUDE_CONFIG_DIR="${join(home, 'harness')}"`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  await mkdir(join(home, 'fleet'), { recursive: true });
  await writeFile(
    join(home, 'fleet', 'manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: GENERATED_AT,
        accounts: [
          {
            id: ACCOUNT,
            kind: 'claude',
            mode: 'auto',
            wrapper: executable,
            home: join(home, 'harness'),
            displayName: 'Profiled',
            defaultModel: 'claude-opus-5',
            models: [{ id: 'claude-opus-5', available: true }],
            available: true,
            unavailableReason: null,
            secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
          },
        ],
      }),
    ),
    { mode: 0o600 },
  );

  await writeFile(
    join(home, 'fleet', 'config.yaml'),
    [
      'profiles:',
      '  work:',
      '    env:',
      '      ANTHROPIC_API_KEY: "${secret:WORK_KEY}"',
      'agents:',
      '  - name: profiled',
      '    kind: claude',
      '    auth: api-key',
      '    profiles: [work]',
      '    routes:',
      '      default:',
      `        id: ${ACCOUNT}`,
      `        wrapper: ${WRAPPER}`,
      '        home: profiled',
      '        defaultModel: claude-opus-5',
      '        models: [claude-opus-5]',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return executable;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) return;
    await Bun.sleep(50);
  }
  throw new Error('the daemon never answered its health probe');
}

describe('a fleet account a profile authenticates, on a booted daemon', () => {
  it('should list its missing credential before anything runs, and refuse the start that needs it', async () => {
    // Arrange
    const home = await tempDirectory('ferretry-profile-journey-');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    process.env.FY_HOME = home;
    const opened = await world().storage.open();
    await opened.storage.close();
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port }), { mode: 0o600 });
    await seedProfiledFleet(home);
    const shutdown = new Promise<void>(resolve => {
      release = resolve;
    });
    const exit = start({ ...world(), untilShutdown: () => shutdown }, cleanups);
    await waitForHealth(port);
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const cli = { ...headers, 'x-ferretry-client': 'cli' };
    const secrets = `http://127.0.0.1:${port}/v1/secrets`;

    // Act
    // 1. The listing, before the store holds anything. This is the wiring under test: the fleet is a
    //    place that names secrets, beside the operator's own recipes.
    const before = SecretListSchema.parse(await (await fetch(secrets, { headers })).json());
    // 2. A start of that account, with the credential still missing.
    const refused = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-profile-1' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'this must not run', name: 'Profiled', cwd: home }),
    });
    const refusedBody = await refused.text();
    // 3. The same listing once the store holds it.
    await fetch(secrets, { method: 'POST', headers, body: JSON.stringify({ name: 'WORK_KEY', value: FIXTURE_VALUE }) });
    const after = SecretListSchema.parse(await (await fetch(secrets, { headers })).json());

    release();
    await exit;
    for (const cleanup of cleanups) await cleanup();

    // Assert
    // The reference is visible with the profile that set it, so a person can fix this before a
    // session dies rather than afterwards.
    const reference = before.references.find(entry => entry.name === 'WORK_KEY');
    should(reference?.origin).match(/fleet account claude-auto-profiled → ANTHROPIC_API_KEY/u);
    should(reference?.origin).match(/the profile "work"/u);
    should(reference?.resolved).be.false();
    // The start is refused, on this machine, naming the secret — never an empty credential and a
    // provider error minutes later.
    // The SENTENCE, not merely the name: a coincidental WORK_KEY anywhere in the document — the
    // wrapper path, the account row — would pass a looser match while the resolver was never wired.
    should(refusedBody).match(
      /takes its environment from this daemon.s secret store, which holds no secret named WORK_KEY/u,
    );
    should(JSON.parse(refusedBody)).match({ state: { status: 'failed' } });
    // And the listing says so once it is set. A NAME and an instant; there is no value on the wire.
    should(after.references.find(entry => entry.name === 'WORK_KEY')?.resolved).be.true();
    should(after.secrets.map(entry => entry.name)).containEql('WORK_KEY');
    should(JSON.stringify(after)).not.containEql(FIXTURE_VALUE);
  });
});
