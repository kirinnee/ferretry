import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostedRelayControlDurableObject,
  type RelayEnvironment,
  relayFetch,
} from '../../../worker/src/adapters/worker.ts';
import { FakeHostedRelayControlStorage } from '../../support/worker/hosted-control-fakes.ts';

// Run the workflow's actual seed step. Only curl is substituted: GET sees the real control object's response;
// a PUT is captured and then sent through the real Worker, so its strict input and advertisement are exercised.
async function deploy(origin: string, environment: RelayEnvironment): Promise<'seeded' | 'preserved'> {
  const workflow = readFileSync(
    new URL('../../../../../../.github/workflows/relay-hosted.yaml', import.meta.url),
    'utf8',
  );
  const block = workflow.match(/ {10}if \[\[ -n "\$\{operator_token-\}" \]\]; then\n[\s\S]*?\n {10}fi/u)?.[0];
  if (block === undefined) throw new Error('the hosted workflow has no first-deploy seeding step');
  const endpoint = `${origin}/v1/operator/config`;
  const current = await relayFetch(
    new Request(endpoint, {
      headers: { Authorization: 'Bearer operator-token-fixture' },
    }),
    environment,
  );
  expect(current.status).toBe(200);
  const folder = mkdtempSync(join(tmpdir(), 'hosted-deploy-seed-'));
  const payload = join(folder, 'seed.json');
  try {
    const mockCurl = `
      curl() {
        local method=GET data= endpoint=
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --request) method="$2"; shift 2 ;;
            --data-binary) data="$2"; shift 2 ;;
            *) endpoint="$1"; shift ;;
          esac
        done
        [[ "$endpoint" == "$HOSTED_RELAY_ORIGIN/v1/operator/config" ]] || return 1
        if [[ "$method" == GET ]]; then
          printf '%s' "$CURRENT_CONFIGURATION"
        elif [[ "$method" == PUT ]]; then
          printf '%s' "$data" > "$SEED_REQUEST_FILE"
          printf '%s' '{"configured":true,"configuration":{"relayUrl":"fixture"}}'
        else
          return 1
        fi
      }
    `;
    const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-euo', 'pipefail', '-c', mockCurl + block], {
      env: {
        PATH: process.env.PATH,
        HOSTED_RELAY_ORIGIN: origin,
        operator_token: 'operator-token-fixture',
        CURRENT_CONFIGURATION: await current.text(),
        SEED_REQUEST_FILE: payload,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    if (!existsSync(payload)) return 'preserved';
    const document = readFileSync(payload, 'utf8');
    expect(Object.keys(JSON.parse(document) as object).sort()).toEqual(['limits', 'relayUrl', 'version']);
    const seeded = await relayFetch(
      new Request(endpoint, {
        method: 'PUT',
        headers: { Authorization: 'Bearer operator-token-fixture', 'Content-Type': 'application/json' },
        body: document,
      }),
      environment,
    );
    expect(seeded.status).toBe(200);
    return 'seeded';
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

it('R130 the actual workflow seeds only an untouched control object from its Worker origin and preserves an emergency stop', async () => {
  const object = new HostedRelayControlDurableObject(
    { storage: new FakeHostedRelayControlStorage() },
    {},
    { now: () => 1_000 },
  );
  const environment: RelayEnvironment = {
    RELAY_MODE: 'hosted',
    RELAY_OPERATOR_TOKEN: 'operator-token-fixture',
    RELAY_CONTROL: { idFromName: name => name, get: () => ({ fetch: request => object.fetch(request) }) },
    RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
  };
  const origin = 'https://ferretry-hosted-relay.fixture-account.workers.dev';
  const advertise = async () => await (await relayFetch(new Request(`${origin}/v1/default-relay`), environment)).json();
  expect(await advertise()).toEqual({ version: 1, relayUrl: null });
  expect(await deploy(origin, environment)).toBe('seeded');
  expect(await advertise()).toEqual({ version: 1, relayUrl: origin });
  expect(await deploy('https://ferretry-hosted-relay.other-account.workers.dev', environment)).toBe('preserved');
  expect(await advertise()).toEqual({ version: 1, relayUrl: origin });
  // Store an emergency stop through the real operator endpoint, then deploy again.
  const current = (await (
    await object.fetch(new Request('https://control.invalid/operator/configuration'))
  ).json()) as {
    configuration: { version: number; limits: unknown };
  };
  const { version, limits } = current.configuration;
  const disabled = await object.fetch(
    new Request('https://control.invalid/operator/configuration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, limits, relayUrl: null }),
    }),
  );
  expect(disabled.status).toBe(200);
  expect(await deploy(origin, environment)).toBe('preserved');
  expect(await advertise()).toEqual({ version: 1, relayUrl: null });
});
