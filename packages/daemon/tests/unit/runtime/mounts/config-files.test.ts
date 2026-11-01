/**
 * The configuration files at the daemon's front door (docs/config-files.md): the four routes a person
 * edits through and the agent's `config.*` route.
 *
 * The service behind them is the REAL one over an in-memory directory, because what these routes
 * decide — who may loosen in the same act, which grant a file asks for, what an agent is told — only
 * means something against the evaluation that holds a loosening back. Handlers are called with a
 * context each case builds, so governance, the fresh step-up and the caller's kind are the case's own
 * facts rather than whatever a dispatcher would have derived.
 */
import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AcceptedConfigFiles, ConfigFileText } from '@ferretry/fleet';
import { type ConfigIssue, type ConfigPending, type GrantRefusal, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import should from 'should';
import { controlRefusal } from '../../../../src/lib/agent-tools/policy.ts';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance, CapabilityDemand } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import type { ApiRoute, RouteContext } from '../../../../src/lib/api/route.ts';
import {
  type AcceptedConfigStore,
  type ConfigDirectoryPort,
  ConfigFilesService,
} from '../../../../src/lib/config-files/index.ts';
import type { AgentControlKind } from '../../../../src/lib/fleet/agent-control.ts';
import { AGENT_SESSION_CAPABILITY_HEADER } from '../../../../src/lib/runtime/mounts/agent-tools.ts';
import { type ConfigFilesSubsystem, configFilesRoutes } from '../../../../src/lib/runtime/mounts/config-files.ts';
import { jsonBody, request } from '../../api/support.ts';

const DIRECTORY = '/home/operator/.fy/config';
const WARDEN_OFF = 'layers:\n  llm: false\n';
const WARDEN_ON = 'layers:\n  llm: true\n';
/** In the shape every launch now mints, so the same value is a valid `Authorization` bearer too. */
const SESSION_CAPABILITY = `fys_${'c'.repeat(43)}`;

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

class MemoryDirectory implements ConfigDirectoryPort {
  readonly directory = DIRECTORY;
  readonly texts = new Map<string, string>();
  /** Set to make every write fail the way a full disk would. */
  failWrites = false;

  async list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }> {
    return { files: [...this.texts].map(([path, text]) => ({ path, text })), unreadable: [] };
  }

  async fingerprint(): Promise<string> {
    return [...this.texts.keys()].join('\n');
  }

  async read(path: string): Promise<string | undefined> {
    return this.texts.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    if (this.failWrites) throw new Error('ENOSPC: no space left on device');
    this.texts.set(path, text);
  }

  async remove(path: string): Promise<void> {
    this.texts.delete(path);
  }

  async writeSchemas(): Promise<void> {}
}

class MemoryAccepted implements AcceptedConfigStore {
  accepted: AcceptedConfigFiles = {};

  async read(): Promise<AcceptedConfigFiles> {
    return this.accepted;
  }

  async write(accepted: AcceptedConfigFiles): Promise<void> {
    this.accepted = accepted;
  }
}

interface World {
  readonly directory: MemoryDirectory;
  readonly service: ConfigFilesService;
  readonly subsystem: ConfigFilesSubsystem;
  /** The switches turned off; "Ferretry settings" starts off, as on a real machine. */
  readonly off: Set<AgentControlKind>;
  readonly asked: AgentControlKind[];
}

function world(files: Readonly<Record<string, string>> = {}): World {
  const directory = new MemoryDirectory();
  for (const [path, text] of Object.entries(files)) directory.texts.set(path, text);
  const service = new ConfigFilesService({
    directory,
    accepted: new MemoryAccepted(),
    log: { issue: () => undefined, pending: () => undefined },
    digest,
    now: () => new Date('2026-10-16T09:00:00.000Z'),
  });
  const off = new Set<AgentControlKind>(['settings']);
  const asked: AgentControlKind[] = [];
  return {
    directory,
    service,
    off,
    asked,
    subsystem: {
      service,
      agentControl: {
        allows: async kind => {
          asked.push(kind);
          return !off.has(kind);
        },
      },
      identities: {
        resolve: async capability => (capability === SESSION_CAPABILITY ? { sessionId: 's1', name: 'Ada' } : undefined),
      },
      arm: async () => () => undefined,
    },
  };
}

interface Caller {
  readonly governed: boolean;
  /** What the grants answer for every demand; `granted` unless the case says otherwise. */
  readonly refusal?: GrantRefusal;
  readonly fresh?: boolean;
  readonly kind: 'host' | 'device' | 'agent' | 'ferret';
}

interface Call {
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly path: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** Every demand the handler asked the grants about. */
  readonly demands: readonly CapabilityDemand[];
  /** How many times the handler spent the caller's fresh proof. */
  readonly spent: number;
}

const HOST: Caller = { kind: 'host', governed: false };
const DEVICE: Caller = { kind: 'device', governed: true };
const FRESH_DEVICE: Caller = { kind: 'device', governed: true, fresh: true };
const AGENT: Caller = { kind: 'agent', governed: false };
/** A ferret on its OWN session credential: ungoverned (it is on this host), and an agent by its class alone. */
const FERRET: Caller = { kind: 'ferret', governed: false };

const CREDENTIAL: Record<Caller['kind'], AuthenticatedCredential> = {
  host: { kind: 'authenticated', tokenClass: 'admin' },
  device: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  agent: { kind: 'authenticated', tokenClass: 'admin' },
  ferret: { kind: 'authenticated', tokenClass: 'session', sessionId: 's1' },
};
const ACTOR: Record<Caller['kind'], string> = {
  host: 'admin-cli',
  device: 'device:d1',
  agent: 'peer:s1',
  ferret: 'peer:s1',
};

function routeFor(subsystem: ConfigFilesSubsystem, method: string, path: string): ApiRoute {
  const found = configFilesRoutes(subsystem).find(route => route.method === method && route.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found;
}

/** Drive one handler as `caller`, an `ApiError` read back as the response the dispatcher would make. */
async function call(subject: World, caller: Caller | undefined, input: Call): Promise<Answer> {
  const demands: CapabilityDemand[] = [];
  let spent = 0;
  const refusal = caller?.refusal ?? 'granted';
  const governance: CallerGovernance | undefined =
    caller === undefined
      ? undefined
      : {
          governed: caller.governed,
          decide: demand => {
            demands.push(demand);
            return { allowed: refusal === 'granted', refusal };
          },
        };
  const kind = caller?.kind ?? 'host';
  const context: RouteContext = {
    request: request({
      method: input.method,
      path: input.path,
      ...(input.query === undefined ? {} : { query: input.query }),
      headers: { 'content-type': 'application/json', ...input.headers },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    }),
    params: new Map<string, string>(),
    actor: ACTOR[kind],
    credential: CREDENTIAL[kind],
    ...(governance === undefined ? {} : { governance }),
    presentation: {
      loopback: kind !== 'device',
      adminToken: kind !== 'device',
      actor: ACTOR[kind],
      stepUp: caller?.fresh === true,
      freshStepUp: caller?.fresh === true,
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  };
  let response: ApiResponse;
  try {
    response = await routeFor(subject.subsystem, input.method, input.path).handle(context);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, demands, spent };
  }
  return { status: response.status, body: jsonBody(response), demands, spent };
}

const put = (path: string, text: string, ifMatch?: string): Call => ({
  method: 'PUT',
  path: '/v1/config/file',
  body: { path, text },
  ...(ifMatch === undefined ? {} : { headers: { 'if-match': ifMatch } }),
});
const read = (path: string): Call => ({ method: 'GET', path: '/v1/config/file', query: [['path', path]] });
const confirm = (path: string, etag: string): Call => ({
  method: 'POST',
  path: '/v1/config/confirm',
  body: { path, etag },
});
const tool = (body: unknown, capability: string | null = SESSION_CAPABILITY): Call => ({
  method: 'POST',
  path: '/v1/agent/config',
  body,
  ...(capability === null ? {} : { headers: { [AGENT_SESSION_CAPABILITY_HEADER]: capability } }),
});

/** Whether the Warden is on, as every reader of the configuration sees it now. */
async function wardenInEffect(subject: World): Promise<boolean> {
  return (await subject.service.load()).evaluation.effective.warden.layers.llm;
}

/** Write a loosening that is held, and answer the held edit. */
async function held(subject: World): Promise<ConfigPending> {
  const answer = await call(subject, DEVICE, put('warden.yaml', WARDEN_ON));
  should(answer.body.outcome).equal('pending');
  return answer.body.pending as ConfigPending;
}

describe('the configuration files mount', () => {
  describe('its route table', () => {
    it('should declare five never-cached routes, the agent one privileged-only and token-less', () => {
      // Arrange
      const routes = configFilesRoutes(world().subsystem);

      // Act
      const shape = routes.map(route => ({
        route: `${route.method} ${route.path}`,
        minimum: route.minimum,
        privilegedOnly: route.privilegedOnly === true,
        capability: route.capability,
        noStore: route.noStore,
      }));

      // Assert
      const use = { capability: 'fleet', axis: 'use' };
      should(shape).deepEqual([
        { route: 'GET /v1/config/status', minimum: 'operator', privilegedOnly: false, capability: use, noStore: true },
        { route: 'GET /v1/config/file', minimum: 'operator', privilegedOnly: false, capability: use, noStore: true },
        { route: 'PUT /v1/config/file', minimum: 'operator', privilegedOnly: false, capability: use, noStore: true },
        {
          route: 'POST /v1/config/confirm',
          minimum: 'operator',
          privilegedOnly: false,
          capability: use,
          noStore: true,
        },
        { route: 'POST /v1/agent/config', minimum: 'none', privilegedOnly: true, capability: undefined, noStore: true },
      ]);
    });
  });

  describe('GET /v1/config/status', () => {
    it('should answer the directory, every file and what is waiting', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, HOST, { method: 'GET', path: '/v1/config/status' });

      // Assert
      should(answer.status).equal(200);
      should(answer.body).containDeep({
        directory: DIRECTORY,
        files: [{ path: 'warden.yaml', state: 'ok' }],
        pending: [],
      });
    });
  });

  describe('GET /v1/config/file', () => {
    it('should answer a file on disk with its digest as its etag', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, HOST, read('warden.yaml'));

      // Assert
      should(answer.status).equal(200);
      should(answer.body).containDeep({
        path: 'warden.yaml',
        exists: true,
        text: WARDEN_OFF,
        etag: digest(WARDEN_OFF),
      });
    });

    it('should answer the starter and the absent etag for a file that does not exist yet', async () => {
      // Arrange
      const subject = world();

      // Act
      const answer = await call(subject, HOST, read('warden.yaml'));

      // Assert
      should(answer.body).containDeep({ exists: false, etag: 'absent' });
      should(answer.body.text).match(/llm: false/u);
    });

    it('should ask the Warden grant for warden.yaml and the fleet grant for every other file, on the use axis', async () => {
      // Arrange
      const subject = world();

      // Act
      const warden = await call(subject, HOST, read('warden.yaml'));
      const machine = await call(subject, HOST, read('machine.yaml'));
      const profile = await call(subject, HOST, read('profiles/research.yaml'));

      // Assert
      should(warden.demands).deepEqual([{ capability: 'warden', axis: 'use' }]);
      should(machine.demands).deepEqual([{ capability: 'fleet', axis: 'use' }]);
      should(profile.demands).deepEqual([{ capability: 'fleet', axis: 'use' }]);
    });

    it('should refuse a device the file grant does not allow, by the grant refusal code', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, { ...DEVICE, refusal: 'not-granted' }, read('warden.yaml'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body).deepEqual({ error: 'this device may not read warden.yaml', code: 'grant_not_granted' });
    });

    it('should refuse when nothing can say whether the caller may act, rather than allow', async () => {
      // Arrange
      const subject = world();

      // Act
      const answer = await call(subject, undefined, read('warden.yaml'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body.code).equal('forbidden');
    });

    it('should refuse a path that is not a configuration file, and a missing one, with 400', async () => {
      // Arrange
      const subject = world();

      // Act
      const foreign = await call(subject, HOST, read('../.ssh/id_ed25519'));
      const missing = await call(subject, HOST, { method: 'GET', path: '/v1/config/file' });

      // Assert
      should(foreign.status).equal(400);
      should(foreign.body.code).equal('bad_request');
      should(foreign.body.error).match(/not a Ferretry configuration file/u);
      should(missing.status).equal(400);
    });
  });

  describe('PUT /v1/config/file', () => {
    it('should ask the file grant on the configure axis', async () => {
      // Arrange
      const subject = world();

      // Act
      const warden = await call(subject, HOST, put('warden.yaml', WARDEN_OFF));
      const machine = await call(subject, HOST, put('voice.yaml', '{}\n'));

      // Assert
      should(warden.demands).deepEqual([{ capability: 'warden', axis: 'configure' }]);
      should(machine.demands).deepEqual([{ capability: 'fleet', axis: 'configure' }]);
    });

    it('should answer a step-up refusal with the demand the passkey must cover, and write nothing', async () => {
      // Arrange
      const subject = world();

      // Act
      const answer = await call(subject, { ...DEVICE, refusal: 'step-up-required' }, put('warden.yaml', WARDEN_ON));

      // Assert
      should(answer.status).equal(403);
      should(answer.body).deepEqual({
        error: 'changing warden.yaml from this device needs a passkey confirmation',
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'warden', axis: 'configure' },
      });
      should(subject.directory.texts.has('warden.yaml')).be.false();
    });

    it('should refuse a device the grant does not allow to change the file', async () => {
      // Arrange
      const subject = world();

      // Act
      const answer = await call(subject, { ...DEVICE, refusal: 'device-not-granted' }, put('machine.yaml', '{}\n'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body).deepEqual({
        error: 'this device may not change machine.yaml',
        code: 'grant_device_not_granted',
      });
    });

    it('should put a loosening from the host into effect at once, spending nothing', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, HOST, put('warden.yaml', WARDEN_ON));

      // Assert
      should(answer.status).equal(200);
      should(answer.body).deepEqual({ path: 'warden.yaml', etag: digest(WARDEN_ON), outcome: 'applied' });
      should(await wardenInEffect(subject)).be.true();
      should(answer.spent).equal(0);
    });

    it('should hold a governed device loosening without a fresh passkey, the tighter version in effect', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, DEVICE, put('warden.yaml', WARDEN_ON));

      // Assert
      should(answer.status).equal(200);
      should(answer.body).containDeep({
        outcome: 'pending',
        pending: { path: 'warden.yaml', etag: digest(WARDEN_ON) },
      });
      should((answer.body.pending as ConfigPending).changes.join(' ')).match(/Warden may now spend/u);
      should(subject.directory.texts.get('warden.yaml')).equal(WARDEN_ON);
      should(await wardenInEffect(subject)).be.false();
      should(answer.spent).equal(0);
    });

    it('should put a governed device loosening into effect with a fresh passkey, and spend that proof', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, FRESH_DEVICE, put('warden.yaml', WARDEN_ON));

      // Assert
      should(answer.body.outcome).equal('applied');
      should(await wardenInEffect(subject)).be.true();
      should(answer.spent).equal(1);
    });

    it('should not spend a fresh passkey on an edit that loosens nothing', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_ON });
      await call(subject, HOST, put('warden.yaml', WARDEN_ON));

      // Act
      const answer = await call(subject, FRESH_DEVICE, put('warden.yaml', WARDEN_OFF));

      // Assert
      should(answer.body.outcome).equal('applied');
      should(await wardenInEffect(subject)).be.false();
      should(answer.spent).equal(0);
    });

    it('should refuse an agent while "Ferretry settings" is off, and hold its loosening once it is on', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const refused = await call(subject, AGENT, put('warden.yaml', WARDEN_ON));
      subject.off.delete('settings');
      const allowed = await call(subject, AGENT, put('warden.yaml', WARDEN_ON));

      // Assert
      should(refused.status).equal(403);
      should(refused.body).deepEqual({ error: controlRefusal('settings'), code: 'agent_control_off' });
      should(subject.asked).deepEqual(['settings', 'settings']);
      should(allowed.body.outcome).equal('pending');
      should(await wardenInEffect(subject)).be.false();
    });

    it('should hold a loosening a ferret makes on its own session credential, as any agent', async () => {
      // Arrange — the class decides: no session header is involved at all.
      const subject = world({ 'warden.yaml': WARDEN_OFF });
      subject.off.delete('settings');

      // Act
      const answer = await call(subject, FERRET, put('warden.yaml', WARDEN_ON));

      // Assert
      should(answer.body.outcome).equal('pending');
      should(await wardenInEffect(subject)).be.false();
    });

    it('should hold an agent loosening even on the host loopback with a fresh proof', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });
      subject.off.delete('settings');

      // Act
      const answer = await call(subject, { ...AGENT, fresh: true }, put('warden.yaml', WARDEN_ON));

      // Assert
      should(answer.body.outcome).equal('pending');
      should(answer.spent).equal(0);
    });

    it('should refuse a file that does not check with 422 and every located issue, writing nothing', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, HOST, put('warden.yaml', 'enabled: sometimes\n'));

      // Assert
      should(answer.status).equal(422);
      should(answer.body.code).equal('config_invalid');
      should(answer.body.error).match(/^the file does not check \(1 problem\); nothing was written$/u);
      should((answer.body.issues as ConfigIssue[])[0]).containDeep({ path: 'warden.yaml', severity: 'error' });
      should(subject.directory.texts.get('warden.yaml')).equal(WARDEN_OFF);
    });

    it('should count several problems in the plural', async () => {
      // Arrange
      const subject = world();

      // Act
      const answer = await call(subject, HOST, put('warden.yaml', 'enabled: sometimes\nintervalMinutes: -1\n'));

      // Assert
      should(answer.status).equal(422);
      should(answer.body.error).match(/\(\d+ problems\)/u);
    });

    it('should refuse an edit made against a version that is no longer there with 409', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(
        subject,
        HOST,
        put('warden.yaml', WARDEN_ON, digest('enabled: true\nintervalMinutes: 9\n')),
      );

      // Assert
      should(answer.status).equal(409);
      should(answer.body.code).equal('config_conflict');
      should(subject.directory.texts.get('warden.yaml')).equal(WARDEN_OFF);
    });

    it('should accept an edit made against the version on disk', async () => {
      // Arrange
      const subject = world({ 'warden.yaml': WARDEN_OFF });

      // Act
      const answer = await call(subject, HOST, put('warden.yaml', WARDEN_ON, digest(WARDEN_OFF)));

      // Assert
      should(answer.body.outcome).equal('applied');
    });

    it('should let any other failure through to the dispatcher', async () => {
      // Arrange
      const subject = world();
      subject.directory.failWrites = true;

      // Act
      const failing = call(subject, HOST, put('warden.yaml', WARDEN_OFF));

      // Assert
      await should(failing).be.rejectedWith(/ENOSPC/u);
    });
  });

  describe('POST /v1/config/confirm', () => {
    it('should demand a passkey proved for THIS act from a governed device, and change nothing', async () => {
      // Arrange
      const subject = world();
      const pending = await held(subject);

      // Act
      const answer = await call(subject, DEVICE, confirm('warden.yaml', pending.etag));

      // Assert
      should(answer.status).equal(403);
      should(answer.body).deepEqual({
        error: 'putting this change to warden.yaml into effect needs a passkey confirmation for it',
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'warden', axis: 'configure', act: 'loosen-config' },
      });
      should(await wardenInEffect(subject)).be.false();
    });

    it('should confirm the reviewed edit for a device with a fresh passkey, and spend that proof', async () => {
      // Arrange
      const subject = world();
      const pending = await held(subject);

      // Act
      const answer = await call(subject, FRESH_DEVICE, confirm('warden.yaml', pending.etag));

      // Assert
      should(answer.status).equal(200);
      should(answer.body).deepEqual({ path: 'warden.yaml', confirmed: true });
      // The fleet's `use` too, which every door on a held edit asks (heldEditRefusal).
      should(answer.demands).deepEqual([
        { capability: 'warden', axis: 'configure' },
        { capability: 'fleet', axis: 'use' },
      ]);
      should(await wardenInEffect(subject)).be.true();
      should(answer.spent).equal(1);
    });

    it('should confirm from the host without a passkey and spend nothing', async () => {
      // Arrange
      const subject = world();
      const pending = await held(subject);

      // Act
      const answer = await call(subject, HOST, confirm('warden.yaml', pending.etag));

      // Assert
      should(answer.body.confirmed).be.true();
      should(answer.spent).equal(0);
    });

    it('should answer false for an etag nobody reviewed, spending nothing', async () => {
      // Arrange
      const subject = world();
      await held(subject);

      // Act
      const answer = await call(
        subject,
        FRESH_DEVICE,
        confirm('warden.yaml', digest('enabled: true\n# edited since\n')),
      );

      // Assert
      should(answer.body).deepEqual({ path: 'warden.yaml', confirmed: false });
      should(await wardenInEffect(subject)).be.false();
      should(answer.spent).equal(0);
    });

    it('should never let an agent confirm, whatever its switch says', async () => {
      // Arrange
      const subject = world();
      const pending = await held(subject);
      subject.off.delete('settings');

      // Act — on the admin token naming its session, and on its own session credential.
      const answers = [
        await call(subject, AGENT, confirm('warden.yaml', pending.etag)),
        await call(subject, FERRET, confirm('warden.yaml', pending.etag)),
      ];

      // Assert — the handler's own second line (the boundary refuses it first: confirm is `caller: 'person'`).
      for (const answer of answers) {
        should(answer.status).equal(403);
        should(answer.body).deepEqual({
          error: 'an agent cannot confirm a configuration change; the owner confirms it',
          code: 'forbidden',
        });
      }
      should(await wardenInEffect(subject)).be.false();
    });

    it('should refuse a device the file grant does not allow to confirm', async () => {
      // Arrange
      const subject = world();
      const pending = await held(subject);

      // Act
      const answer = await call(
        subject,
        { ...FRESH_DEVICE, refusal: 'not-granted' },
        confirm('warden.yaml', pending.etag),
      );

      // Assert
      should(answer.status).equal(403);
      should(answer.body.code).equal('grant_not_granted');
      should(answer.spent).equal(0);
    });
  });

  describe('POST /v1/agent/config', () => {
    it('should answer 401 without a session credential and 403 for one it does not know', async () => {
      // Arrange
      const subject = world();

      // Act
      const missing = await call(subject, undefined, tool({ tool: 'config.read' }, null));
      const blank = await call(subject, undefined, tool({ tool: 'config.read' }, '   '));
      const unknown = await call(subject, undefined, tool({ tool: 'config.read' }, 'fy_cap_somebody_else'));

      // Assert
      should(missing.status).equal(401);
      should(missing.body.code).equal('missing_capability');
      should(blank.status).equal(401);
      should(unknown.status).equal(403);
      should(unknown.body.code).equal('forbidden');
      should(unknown.body.error).match(/session credential/u);
    });

    it('should take the credential as an Authorization bearer too, and refuse two that differ', async () => {
      // Arrange
      const subject = world();
      subject.off.delete('settings');
      const asBearer = (extra: Readonly<Record<string, string>> = {}): Call => ({
        method: 'POST',
        path: '/v1/agent/config',
        body: { tool: 'config.read' },
        headers: { authorization: `Bearer ${SESSION_CAPABILITY}`, ...extra },
      });

      // Act
      const read = await call(subject, undefined, asBearer());
      const two = await call(subject, undefined, asBearer({ [AGENT_SESSION_CAPABILITY_HEADER]: 'fy_cap_other' }));

      // Assert
      should(read.status).equal(200);
      should([two.status, two.body.code]).deepEqual([401, 'unauthorized']);
    });

    it('should refuse every tool while "Ferretry settings" is off', async () => {
      // Arrange
      const subject = world();

      // Act
      const answer = await call(subject, undefined, tool({ tool: 'config.read' }));

      // Assert
      should(answer.status).equal(403);
      should(answer.body).deepEqual({ error: controlRefusal('settings'), code: 'agent_control_off' });
    });

    describe('with "Ferretry settings" on', () => {
      const on = (files: Readonly<Record<string, string>> = {}): World => {
        const subject = world(files);
        subject.off.delete('settings');
        return subject;
      };

      it('should list every file with a count of errors and of held edits', async () => {
        // Arrange
        const subject = on({ 'warden.yaml': WARDEN_OFF, 'voice.yaml': 'enabled: sometimes\n' });

        // Act
        const answer = await call(subject, undefined, tool({ tool: 'config.read' }));

        // Assert
        should(answer.status).equal(200);
        should(answer.body.summary).match(
          new RegExp(
            `^2 configuration files in ${DIRECTORY}; [1-9]\\d* with errors; 0 waiting for the owner's confirmation\\.$`,
            'u',
          ),
        );
        should(answer.body.files as unknown[]).have.length(2);
        should(answer.body.issues as unknown[]).not.be.empty();
      });

      it('should read one file with its state and etag', async () => {
        // Arrange
        const subject = on({ 'warden.yaml': WARDEN_OFF });

        // Act
        const answer = await call(subject, undefined, tool({ tool: 'config.read', path: 'warden.yaml' }));

        // Assert
        should(answer.body).deepEqual({
          summary: 'warden.yaml (ok).',
          text: WARDEN_OFF,
          etag: digest(WARDEN_OFF),
          issues: [],
        });
      });

      it('should read a file that does not exist as the starter, and say so', async () => {
        // Arrange
        const subject = on();

        // Act
        const answer = await call(subject, undefined, tool({ tool: 'config.read', path: 'learning.yaml' }));

        // Assert
        should(answer.body.summary).equal(
          'learning.yaml does not exist yet; this is the starter a new one begins with.',
        );
        should(answer.body.etag).equal('absent');
      });

      it('should validate a text that checks and one that does not, writing nothing', async () => {
        // Arrange
        const subject = on();

        // Act
        const ok = await call(
          subject,
          undefined,
          tool({ tool: 'config.validate', path: 'warden.yaml', text: WARDEN_ON }),
        );
        const bad = await call(
          subject,
          undefined,
          tool({ tool: 'config.validate', path: 'warden.yaml', text: 'enabled: sometimes\n' }),
        );
        const worse = await call(
          subject,
          undefined,
          tool({ tool: 'config.validate', path: 'warden.yaml', text: 'enabled: sometimes\nintervalMinutes: -1\n' }),
        );

        // Assert
        should(ok.body).deepEqual({ summary: 'warden.yaml checks.', issues: [] });
        should(bad.body.summary).equal('warden.yaml does not check: 1 problem. Fix each and validate again.');
        should(worse.body.summary).match(/does not check: \d+ problems\./u);
        should(subject.directory.texts.size).equal(0);
      });

      it('should write an edit that loosens nothing and say it is in effect', async () => {
        // Arrange
        const subject = on();

        // Act
        const answer = await call(
          subject,
          undefined,
          tool({ tool: 'config.write', path: 'warden.yaml', text: WARDEN_OFF }),
        );

        // Assert
        should(answer.body).deepEqual({ summary: 'Wrote warden.yaml; it is in effect.', etag: digest(WARDEN_OFF) });
      });

      it('should hold a loosening, name what it loosens and tell the agent to tell the owner', async () => {
        // Arrange
        const subject = on({ 'warden.yaml': WARDEN_OFF });

        // Act
        const answer = await call(
          subject,
          undefined,
          tool({ tool: 'config.write', path: 'warden.yaml', text: WARDEN_ON }),
        );

        // Assert
        should(answer.body.summary).match(
          /^Wrote warden\.yaml, but it loosens what this machine allows \(.*Warden may now spend.*\), so it waits for the owner to confirm it; .* Tell the owner with a card whose Allow confirms it: fy agenda add "<the ask>" --title "<title>" --context "<the facts around it>" --confirms warden\.yaml\.$/u,
        );
        should(answer.body.etag).equal(digest(WARDEN_ON));
        should(await wardenInEffect(subject)).be.false();
      });

      it('should answer an invalid write with its issues and a conflicting one with the reason, writing nothing', async () => {
        // Arrange
        const subject = on({ 'warden.yaml': WARDEN_OFF });

        // Act
        const invalid = await call(
          subject,
          undefined,
          tool({ tool: 'config.write', path: 'warden.yaml', text: 'enabled: sometimes\n' }),
        );
        const conflict = await call(
          subject,
          undefined,
          tool({ tool: 'config.write', path: 'warden.yaml', text: WARDEN_ON, etag: digest('stale\n') }),
        );

        // Assert
        should(invalid.status).equal(200);
        should(invalid.body.summary).equal(
          'Nothing was written: warden.yaml does not check. Fix each issue and try again.',
        );
        should(invalid.body.issues as unknown[]).not.be.empty();
        should(conflict.body).deepEqual({
          summary: 'Nothing was written: warden.yaml changed since it was read; read it again and redo the edit.',
        });
        should(subject.directory.texts.get('warden.yaml')).equal(WARDEN_OFF);
      });

      it('should let any other failure through to the dispatcher', async () => {
        // Arrange
        const subject = on();
        subject.directory.failWrites = true;

        // Act
        const failing = call(subject, undefined, tool({ tool: 'config.write', path: 'warden.yaml', text: WARDEN_OFF }));

        // Assert
        await should(failing).be.rejectedWith(/ENOSPC/u);
      });
    });
  });
});
