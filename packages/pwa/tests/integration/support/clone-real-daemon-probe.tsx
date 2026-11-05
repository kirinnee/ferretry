/**
 * Run as its own process by `clone-real-daemon.test.ts`: mounts the REAL `CloneMachine` in happy-dom, gives it the
 * PWA's real wire client (`FyApiClient`), and answers every request it makes with the daemon's REAL route tables over
 * REAL files in temporary directories (the two-machine world in `daemon/tests/integration/fleet/clone-world.ts`).
 * A child keeps happy-dom's process-wide globals out of the daemon-driving tests. Every name, key and address in it
 * is invented; no real home, login or network is read or written.
 *
 * WHAT THIS IS, AND IS NOT: the screen is the real one, driven by clicks, and its requests go to the daemon's real
 * handlers (fleet catalogue and setup, configuration files, the secret import and export) over the same stores the
 * daemon uses. It is NOT a browser run: no Chromium, no network carrier, no service worker, and the passkey ceremony
 * is a flag on the in-process step-up witness. One route is a stand-in: `GET /v1/fleet/credentials` is answered from
 * the declared model (the real service reads each login's live status, which is no part of what a copy writes).
 *
 * The probe copies from a source that names a key the target LACKS and a key the target already HOLDS, then reports
 * what the daemon holds afterwards, for the test to assert.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FleetCredentialListSchema, FleetMachineViewSchema, type IFyHttpTransport } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import type { CapabilityGuard, StepUpWitness } from '../../../../daemon/src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../daemon/src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../daemon/src/lib/api/router.ts';
import { configFilesRoutes } from '../../../../daemon/src/lib/runtime/mounts/config-files.ts';
import { fleetCatalogRoutes } from '../../../../daemon/src/lib/runtime/mounts/fleet-catalog.ts';
import { fleetCredentialRoutes } from '../../../../daemon/src/lib/runtime/mounts/fleet-credentials.ts';
import { fleetSetupRoutes } from '../../../../daemon/src/lib/runtime/mounts/fleet-setup.ts';
import { secretRoutes } from '../../../../daemon/src/lib/runtime/mounts/secrets.ts';
import { SecretExportService, SecretImportService, SecretVault } from '../../../../daemon/src/lib/secrets/index.ts';
import { accountStoreBytes } from '../../../../daemon/tests/integration/fleet/account-stores-fixture.ts';
import {
  applyChange,
  crypto_,
  declared,
  exportedBundle,
  HELD,
  heldBytes,
  identity,
  keysTheCopyNeeds,
  type Machine,
  OTHER_HELD,
  removeTemporary,
  signedInMachine,
  sourceMachine,
  unchanged,
  type Vault,
} from '../../../../daemon/tests/integration/fleet/clone-world.ts';
import { request as apiRequest } from '../../../../daemon/tests/unit/api/support.ts';
import { CREDENTIALS, FakeSecretCipher, GRANTED } from '../../../../daemon/tests/unit/runtime/mounts/support.ts';
import type { FleetClient } from '../../../src/features/fleet/fleet-client.ts';
import { CloneMachine } from '../../../src/features/fleet/setup/clone.tsx';
import type { DaemonConnectionRecord } from '../../../src/lib/connections.ts';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../support/dom.ts';
import { credentialView } from '../../unit/features/fleet/setup/setup-support.ts';

// ── The wire: the PWA's real client, answered in process by a daemon's real route tables ─────────

/** One write the app made, as it crossed the wire, and what the daemon answered. */
interface Written {
  readonly machine: 'source' | 'target';
  readonly method: string;
  readonly path: string;
  /** For a proposal, the kind of change it carried; for a config write, the file; for a key export, the names asked for. */
  readonly detail?: string;
  readonly status: number;
  /** The daemon's answer, kept only where it is short and names no secret: a settings write, and a key import's result. */
  readonly answer?: unknown;
}

const keepsAnswer = (route: string): boolean =>
  route.startsWith('/v1/config/') || /^\/v1\/secrets\/imports\/[^/]+$/u.test(route);

interface Seat {
  readonly machine: Machine;
  readonly vault: Vault;
  readonly role: 'source' | 'target';
}

/** The fresh-passkey flag the governed phone's step-up witness reads: a ceremony is a flag here, never a prompt. */
const passkey = { fresh: false };
const witness: StepUpWitness = {
  held: () => true,
  freshlyHeld: () => passkey.fresh,
  spendFresh: () => {
    passkey.fresh = false;
  },
};

/** A caller the operator's grants GOVERN (a paired phone, not the machine itself): allowed, with no proof held. */
const PHONE: CapabilityGuard = {
  decide: () => ({ allowed: true, refusal: 'granted' }),
  governance: () => ({ governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) }),
  explain: () => undefined,
};
const DEVICE = { deviceId: 'fy_device_id_0123456789abcdefghijkl', appSession: 'app-session-1' } as const;

async function routesOf(seat: Seat) {
  const { machine, vault } = seat;
  const clock = { now: () => '2026-10-20T10:00:00.000Z' };
  const here = await identity();
  const credentials = {
    list: async () =>
      FleetCredentialListSchema.parse({
        format: 2,
        machine: seat.role === 'target' ? 'studio-mac' : 'work-linux',
        credentials: Object.entries((await declared(machine)).credentials).map(([id, credential]) =>
          credentialView(id, { harness: credential.harness }),
        ),
      }),
  };
  const subsystem = {
    directory: vault.directory,
    references: { references: async () => [] },
    uses: {},
    imports: new SecretImportService({
      crypto: crypto_,
      identity: { load: async () => here },
      directory: vault.directory,
      clock,
    }),
    exports: new SecretExportService({
      crypto: crypto_,
      identity: { load: async () => here },
      vault: new SecretVault(vault.documents, new FakeSecretCipher()),
      clock,
    }),
  };
  return {
    fleet: [
      ...fleetCatalogRoutes(machine.catalog),
      ...fleetSetupRoutes(machine.setup),
      ...fleetCredentialRoutes(credentials as never),
    ],
    config: configFilesRoutes({
      service: machine.home.service,
      agentControl: { allows: async () => true },
      identities: { resolve: async () => undefined },
      arm: async () => () => undefined,
    } as never),
    secrets: secretRoutes(subsystem as never),
  };
}

/**
 * The PWA's real client over a daemon: its requests go to the daemon's own dispatcher. `governedConfig` makes the
 * configuration-file routes answer a paired phone (governed, no passkey held) while every other route answers the
 * machine's owner, so a settings write that loosens is HELD, as it is off the machine.
 */
async function clientOver(
  seat: Seat,
  log: Written[],
  governedConfig: boolean,
): Promise<{ client: FyApiClient; seat: Seat }> {
  const routes = await routesOf(seat);
  const owner = new ApiDispatcher(
    new ApiRouter([...routes.fleet, ...routes.config, ...routes.secrets]),
    CREDENTIALS,
    GRANTED,
  );
  const phone = new ApiDispatcher(
    new ApiRouter([...routes.fleet, ...routes.config]),
    CREDENTIALS,
    PHONE,
    undefined,
    witness,
  );
  const transport: IFyHttpTransport = {
    send: async (url, init) => {
      const target = new URL(url);
      // A settings write rides the Update's own proposal, so the phone's grants govern that too.
      const governed =
        governedConfig &&
        seat.role === 'target' &&
        (target.pathname.startsWith('/v1/config/') || target.pathname.startsWith('/v1/fleet/proposals'));
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? init.body : undefined;
      const answer = await (governed ? phone : owner).dispatch(
        apiRequest({
          method,
          path: target.pathname,
          query: [...target.searchParams],
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(body === undefined ? {} : { body }),
          loopback: !governed,
          ...(governed ? { device: DEVICE } : {}),
        }),
      );
      if (process.env.CLONE_PROBE_TRACE !== undefined)
        console.error(
          `${seat.role} ${method} ${target.pathname}${target.search} -> ${answer.status}${target.pathname.endsWith('/clone/review') ? ` ${answer.body.slice(0, 400)}` : ''}`,
        );
      if (method !== 'GET') {
        const parsedBody =
          body === undefined
            ? undefined
            : (JSON.parse(body) as { change?: { kind?: string }; path?: string; names?: unknown });
        // A key export carries the key NAMES asked for (an array); a clone review carries machine names (an object).
        const keys = Array.isArray(parsedBody?.names) ? parsedBody.names.join(',') : undefined;
        const detail = parsedBody?.change?.kind ?? parsedBody?.path ?? keys;
        log.push({
          machine: seat.role,
          method,
          path: target.pathname,
          ...(detail === undefined ? {} : { detail }),
          status: answer.status,
          ...(keepsAnswer(target.pathname) && answer.body !== '' ? { answer: JSON.parse(answer.body) as unknown } : {}),
        });
      }
      return new Response(answer.status === 204 ? null : answer.body, {
        status: answer.status,
        headers: Object.fromEntries(answer.headers),
      });
    },
  };
  const client = await FyApiClient.connect({
    baseUrl: 'http://127.0.0.1:7431',
    token: CREDENTIALS.admin,
    version: '4.89.0',
    transport,
  });
  if (process.env.CLONE_PROBE_TRACE !== undefined) {
    const request = client.request.bind(client);
    client.request = (async (...args: Parameters<typeof request>) => {
      try {
        return await request(...args);
      } catch (error) {
        console.error(
          `${seat.role} ${String(args[0])} FAILED: ${String(error instanceof Error ? error.message : error).slice(0, 1500)}`,
        );
        throw error;
      }
    }) as typeof client.request;
  }
  return { client, seat };
}

// ── The screen ───────────────────────────────────────────────────────────────────────────────────

/** The id the source machine's setup service names itself with (clone-world.ts), as a real pairing records it. */
const SOURCE_DAEMON = 'daemon-source';
const WORK = daemonConnection({ daemonId: SOURCE_DAEMON, baseUrl: 'https://work.example.test', deviceId: 'u' });
const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' });
const WORK_RECORD: DaemonConnectionRecord = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };

/** What the screen says now, so a wait that times out can say where the copy stood. */
let screenText = (): string => '';

const waitFor = async (what: string, ready: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 3_000; turn += 1) {
    if (ready()) return;
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}; the screen says: ${screenText().slice(0, 4_000)}`);
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

// ── One whole copy ───────────────────────────────────────────────────────────────────────────────

/** More lesson miners per run than this machine allows (2), so it is a LOOSENING a phone's write is held for. */
const LEARNING_ON = 'enabled: true\nmaxMinersPerRun: 5\n';

interface Report {
  readonly written: readonly Written[];
  readonly keysShown: string;
  readonly keysExpected: readonly string[];
  readonly doneStep: string | null;
  readonly learning: {
    /** What the Done screen said of the file: `copied`, or `pending` while it waits for a confirmation. */
    readonly outcomeAtDone: string | null;
    readonly outcomeAfter: string | null;
    readonly onDisk: string;
    /** The daemon's own state for the file: `ok` once it is in effect, `pending` while it is held. */
    readonly stateAtDone: string;
    readonly stateAfter: string;
    readonly heldBefore: boolean;
    readonly heldAtDone: boolean;
    readonly heldAfter: boolean;
  };
  readonly confirmRefusal: string | null;
  readonly held: {
    readonly before: unknown;
    readonly after: unknown;
    readonly identical: boolean;
    readonly changed: readonly string[];
  };
  readonly accountStores: { readonly before: Record<string, string>; readonly after: Record<string, string> };
  readonly vaultNames: readonly string[];
}

async function copy(governedConfig: boolean): Promise<Report> {
  const from = await sourceMachine(false);
  // A setting on the source that the copy can bring: the learning defaults.
  await from.source.home.service.write('learning.yaml', LEARNING_ON, undefined, true, 'owner');
  const { target, vault } = await signedInMachine(governedConfig ? 'phone-copy' : 'machine-copy', false);
  const before = await heldBytes(target, vault);
  const storesBefore = await accountStoreBytes(target.home.paths);
  const heldEntryBefore = JSON.stringify((await vault.documents.read())?.entries[HELD]);
  const heldValueBefore = JSON.stringify((await vault.documents.read())?.entries[OTHER_HELD]);

  // An earlier copy from this source, so the next one is an Update; then the source moves on.
  await applyChange(target, {
    kind: 'clone.import',
    mode: 'alongside',
    bundle: await exportedBundle(from.source),
    source: { daemonId: SOURCE_DAEMON },
    names: { source: 'work-linux', target: 'studio-mac' },
  });
  const [name] = Object.keys((await declared(from.source)).components.instructions);
  if (name === undefined) throw new Error('expected an instructions component');
  await applyChange(from.source, {
    kind: 'component.put',
    name,
    component: { kind: 'instructions' },
    content: 'Edited on the source.\n',
    create: false,
  });

  const written: Written[] = [];
  const sourceSide = await clientOver({ machine: from.source, vault: from.vault, role: 'source' }, written, false);
  const targetSide = await clientOver({ machine: target, vault, role: 'target' }, written, governedConfig);
  const clients: Record<string, FleetClient> = { [SOURCE_DAEMON]: sourceSide.client, studio: targetSide.client };
  const createClient = async (connection: DaemonConnection): Promise<FleetClient> =>
    must(clients[String(connection.daemonId)], `a client for ${connection.daemonId}`);
  const machineView = FleetMachineViewSchema.parse(
    await targetSide.client.request('/v1/fleet/machine', FleetMachineViewSchema),
  );

  const held = async (): Promise<boolean> =>
    (await target.home.service.status()).pending.some(item => item.path === 'learning.yaml');
  const state = async (): Promise<string> => (await target.home.service.file('learning.yaml')).state;
  const heldBefore = await held();

  const view = await mount(
    <CloneMachine
      sources={[WORK_RECORD]}
      connection={STUDIO}
      machineName="studio-mac"
      machine={machineView}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={createClient}
      onDone={() => undefined}
      onLeave={() => undefined}
    />,
  );
  const q = (selector: string) => view.container.querySelector(selector);
  screenText = () => view.container.textContent ?? '';
  const step = () => q('[data-machine-stepper]')?.getAttribute('data-step') ?? null;
  const tick = async (id: string) =>
    await click(q(`[data-setup-choices="clone-items"] [data-setup-choice="${id}"] input`), `the ${id} checkbox`);

  // The source is offered once its own machine has answered that it is up and set up.
  const choice = () => q(`[data-setup-choice="${SOURCE_DAEMON}"] input`) as HTMLInputElement | null;
  await waitFor('the source choice', () => choice() !== null && !choice()?.disabled);
  await click(choice(), 'the source choice');
  const next = () => q('[data-step-next]') as HTMLButtonElement | null;
  await waitFor('Next to be enabled', () => next() !== null && !next()?.disabled);
  await click(next(), 'Next');
  await waitFor('the Existing-setup step', () => step() === 'existing');
  await click(q('[data-step-next]'), 'Next');
  await waitFor('the Changes step', () => step() === 'preview' && q('[data-clone-keys-names]') !== null);
  const keysShown = q('[data-clone-keys-names]')?.textContent ?? '';
  await tick('learning');
  await tick('controls');
  // The default runtime changed on both machines (this one has its own), so nothing is chosen for it: keep this one's.
  const defaultKey = '[data-clone-key="controls:defaultRuntime"] input[type="radio"]';
  await waitFor('the default runtime to be offered', () => q(defaultKey) !== null);
  await click(q(defaultKey), 'keep this machine’s default runtime');
  await click(q('[data-change-submit]'), 'the Update button');
  await waitFor('the Done step', () => step() === 'done');

  const outcome = () => q('[data-clone-outcome="learning"]')?.getAttribute('data-outcome') ?? null;
  const outcomeAtDone = outcome();
  const heldAtDone = await held();
  const stateAtDone = await state();
  let confirmRefusal: string | null = null;
  if (outcomeAtDone === 'pending') {
    // From a phone the loosening is held. Confirm is refused until a passkey is proved for it, then it goes through.
    await click(q('[data-clone-confirm="learning.yaml"]'), 'Confirm');
    await waitFor('the refusal', () => q('[role="alert"]') !== null);
    confirmRefusal = q('[role="alert"]')?.textContent ?? null;
    passkey.fresh = true;
    await click(q('[data-clone-confirm="learning.yaml"]'), 'Confirm again');
    await waitFor('the confirmation', () => outcome() === 'copied');
  }

  const bundle = await exportedBundle(from.source);
  const keysExpected = keysTheCopyNeeds(
    bundle,
    (await from.vault.directory.list()).map(secret => secret.name),
    [HELD, OTHER_HELD],
  );
  const afterBytes = await heldBytes(target, vault);
  const unchangedBytes = unchanged(before, afterBytes);
  const changed = Object.keys(before).filter(key => before[key] !== unchangedBytes[key]);
  const learningPath = path.join(target.home.paths.config, 'learning.yaml');
  const report: Report = {
    written,
    keysShown,
    keysExpected,
    doneStep: step(),
    learning: {
      outcomeAtDone,
      outcomeAfter: outcome(),
      onDisk: await readFile(learningPath, 'utf8').catch(() => ''),
      stateAtDone,
      stateAfter: await state(),
      heldBefore,
      heldAtDone,
      heldAfter: await held(),
    },
    confirmRefusal,
    held: {
      before: [heldEntryBefore, heldValueBefore],
      after: [
        JSON.stringify((await vault.documents.read())?.entries[HELD]),
        JSON.stringify((await vault.documents.read())?.entries[OTHER_HELD]),
      ],
      identical: changed.length === 0,
      changed,
    },
    accountStores: { before: storesBefore, after: await accountStoreBytes(target.home.paths) },
    vaultNames: Object.keys((await vault.documents.read())?.entries ?? {}).toSorted(),
  };
  await view.unmount();
  return report;
}

const out = { machine: await copy(false), phone: await copy(true) };
await removeTemporary();
console.log(JSON.stringify(out));
process.exit(0);
