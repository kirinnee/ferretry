/**
 * Allow on an agenda card puts a held configuration change into effect (docs/agenda.md § Confirming a
 * configuration change).
 *
 * The configuration service is the REAL one over an in-memory directory and the agenda is the real state
 * machine over an in-memory ledger, because what these cases prove — that only the owner's answer confirms,
 * that it confirms exactly the change the card showed, and that a ferret's answer never does — only means
 * something against the evaluation that holds a loosening back. The handler is called with a context each
 * case builds, so governance, the fresh passkey and who is calling are the case's own facts.
 */
import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AcceptedConfigFiles, ConfigFileText } from '@ferretry/fleet';
import {
  AGENDA_CONFIG_CHANGED_CODE,
  type AgendaItem,
  type AgendaSnapshot,
  type GrantRefusal,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance, CapabilityDemand } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import type { AgendaService } from '../../../../src/lib/agenda/index.ts';
import {
  type AcceptedConfigStore,
  type ConfigDirectoryPort,
  ConfigFilesService,
} from '../../../../src/lib/config-files/index.ts';
import { agendaRoutes } from '../../../../src/lib/runtime/mounts/agenda.ts';
import { type AgendaConfigPort, configFilesConfirmations } from '../../../../src/lib/runtime/mounts/agenda-confirms.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agendaService, NO_HELD_REPLIES } from './support.ts';

const WARDEN_OFF = 'layers:\n  llm: false\n';
const WARDEN_ON = 'layers:\n  llm: true\n';
const WARDEN_ON_EDITED = 'layers:\n  llm: true\n  jev: true\n';
const MACHINE_SKIP = 'agentPermissions: skip\n';

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

class MemoryDirectory implements ConfigDirectoryPort {
  readonly directory = '/home/operator/.fy/config';
  readonly texts = new Map<string, string>();

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
  readonly config: ConfigFilesService;
  readonly attention: AgendaService;
}

/** A machine with the Warden's AI investigations off and in effect, and an empty agenda. */
async function world(): Promise<World> {
  const directory = new MemoryDirectory();
  directory.texts.set('warden.yaml', WARDEN_OFF);
  const config = new ConfigFilesService({
    directory,
    accepted: new MemoryAccepted(),
    log: { issue: () => undefined, pending: () => undefined },
    digest,
    now: () => new Date('2026-10-30T09:00:00.000Z'),
  });
  await config.load();
  return { directory, config, attention: agendaService() };
}

/** A ferret's edit that switches the investigations on: written, and held for the owner. */
async function holdLoosening(subject: World, text: string = WARDEN_ON): Promise<string> {
  const written = await subject.config.write('warden.yaml', text, undefined, false);
  should(written.outcome).equal('pending');
  return written.etag;
}

const investigationsOn = async (subject: World): Promise<boolean> =>
  (await subject.config.load()).evaluation.effective.warden.layers.llm;

/** Who is calling, as the authorization boundary would have resolved it. */
interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  /** Absent: nothing can say what this caller may do. */
  readonly governed?: boolean;
  readonly fresh?: boolean;
  readonly refusal?: GrantRefusal;
}

/** The owner at the machine: `fy` with the admin token, ungoverned. */
const HOST: Caller = {
  actor: 'admin-cli',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};
/** The owner's phone, paired, without a passkey proved for this act. */
const DEVICE: Caller = {
  actor: 'device:phone',
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'phone' },
  governed: true,
};
/** The owner's phone with a passkey proved for this act. */
const FRESH_DEVICE: Caller = { ...DEVICE, fresh: true };
/** A ferret's own `fy agenda done --choice Allow`, from inside its pane. */
const FERRET_CLI: Caller = {
  actor: 'peer:s1',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};
/** A warden's token: an agent, not the owner. */
const WARDEN_TOKEN: Caller = {
  actor: 'warden:w1',
  credential: { kind: 'authenticated', tokenClass: 'warden' },
  governed: false,
};
/** The admin token arriving over the relay, not on this host: governed, and no passkey proved. */
const RELAYED: Caller = {
  actor: 'admin-ui',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: true,
};

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly demands: readonly CapabilityDemand[];
  readonly spent: number;
}

async function post(
  subject: World,
  caller: Caller,
  body: unknown,
  config: AgendaConfigPort | null = configFilesConfirmations(subject.config),
): Promise<Answer> {
  const demands: CapabilityDemand[] = [];
  let spent = 0;
  const governance: CallerGovernance | undefined =
    caller.governed === undefined
      ? undefined
      : {
          governed: caller.governed,
          decide: demand => {
            demands.push(demand);
            const refusal = caller.refusal ?? 'granted';
            return { allowed: refusal === 'granted', refusal };
          },
        };
  const context: RouteContext = {
    request: request({
      method: 'POST',
      path: '/v1/sessions/s1/attention',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: new Map([['sessionId', 's1']]),
    actor: caller.actor,
    credential: caller.credential,
    ...(governance === undefined ? {} : { governance }),
    presentation: {
      loopback: caller.governed === false,
      adminToken: caller.credential.tokenClass === 'admin',
      actor: caller.actor,
      stepUp: caller.fresh === true,
      freshStepUp: caller.fresh === true,
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  };
  const route = agendaRoutes(
    subject.attention,
    { agendaDelivered: async () => 0, enrolledDevices: async () => 1 },
    NO_HELD_REPLIES,
    config ?? undefined,
  ).find(each => each.method === 'POST' && each.path === '/v1/sessions/:sessionId/attention');
  let response: ApiResponse;
  try {
    response = await (route as NonNullable<typeof route>).handle(context);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, demands, spent };
  }
  return { status: response.status, body: jsonBody(response), demands, spent };
}

const RAISE = {
  action: 'add',
  title: 'Turn on AI investigations',
  subject: 'Allow the Warden to spend on AI investigations?',
  why: 'investigations need the LLM layer on',
  // No premise: a confirmation's premise is the held change, in the daemon's words.
  context: 'The work waits on this answer.',
  howToResolve: 'Allow, Deny or Discard change',
  confirms: 'warden.yaml',
} as const;

const choose = (choice: string, note?: string) => ({
  action: 'resolve',
  id: 'A1',
  response: { kind: 'multiple-choice', choice },
  ...(note === undefined ? {} : { note }),
});

async function board(subject: World): Promise<AgendaSnapshot> {
  const listed = await subject.attention.list('s1');
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.value;
}

const openItem = async (subject: World): Promise<AgendaItem | undefined> =>
  (await board(subject)).items.find(item => item.id === 'A1');

/** A world with a held loosening and the ferret's card for it raised. */
async function raised(): Promise<{ readonly subject: World; readonly etag: string }> {
  const subject = await world();
  const etag = await holdLoosening(subject);
  const answer = await post(subject, FERRET_CLI, RAISE);
  should(answer.status).equal(200);
  return { subject, etag };
}

describe('Allow on an agenda card that confirms a held configuration change', () => {
  describe('raising it (fy agenda add --confirms)', () => {
    it('should record the held edit’s digest and words, and write the card’s answers and premise', async () => {
      // Arrange
      const subject = await world();
      const etag = await holdLoosening(subject);

      // Act
      const answer = await post(subject, FERRET_CLI, RAISE);

      // Assert
      should(answer.status).equal(200);
      const item = await openItem(subject);
      should(item?.confirms).deepEqual({
        path: 'warden.yaml',
        etag,
        changes: ['the Warden may now spend on AI investigations'],
      });
      should(item?.kind).equal('choice');
      should(item?.ask).deepEqual({
        kind: 'multiple-choice',
        options: [
          { label: 'Allow', description: 'Apply this change to warden.yaml now' },
          { label: 'Deny', description: 'Keep it held: nothing changes, nothing is lost' },
          { label: 'Discard change', description: 'Put warden.yaml back to the version in effect' },
        ],
      });
      should(item?.answers?.map(each => [each.direction, each.label, each.does])).deepEqual([
        ['right', 'Allow', 'choose'],
        ['left', 'Deny', 'choose'],
        ['up', 'Discard change', 'choose'],
      ]);
      should(item?.premise).equal(
        '- the Warden may now spend on AI investigations\n- Allow applies this change to warden.yaml.',
      );
      should(item?.raisedBy).equal('agent');
    });

    it('should keep the raiser’s own premise under the change', async () => {
      // Arrange
      const subject = await world();
      await holdLoosening(subject);

      // Act
      await post(subject, FERRET_CLI, { ...RAISE, premise: ['the dashboard is red'] });

      // Assert
      should((await openItem(subject))?.premise).equal(
        '- the Warden may now spend on AI investigations\n- Allow applies this change to warden.yaml.\n- the dashboard is red',
      );
    });

    it('should refuse a file with no held change, and raise nothing', async () => {
      // Arrange
      const subject = await world();

      // Act
      const answer = await post(subject, FERRET_CLI, RAISE);

      // Assert
      should(answer.status).equal(400);
      should(answer.body.error).equal(
        "warden.yaml has no change waiting for the owner's confirmation (fy config status lists them); nothing was raised",
      );
      should((await board(subject)).items).be.empty();
    });

    it('should refuse --confirms on a daemon that cannot confirm configuration changes', async () => {
      // Arrange
      const subject = await world();
      await holdLoosening(subject);

      // Act
      const answer = await post(subject, FERRET_CLI, RAISE, null);

      // Assert
      should(answer.status).equal(400);
      should(answer.body.error).equal('this daemon cannot confirm configuration changes from the agenda');
      should((await board(subject)).items).be.empty();
    });
  });

  describe('the owner’s Allow', () => {
    it('should confirm the held change from the host, close the card and tell the ferret', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, HOST, choose('Allow'));

      // Assert
      should(answer.status).equal(200);
      should(await investigationsOn(subject)).be.true();
      should((await board(subject)).items).be.empty();
      should((await board(subject)).resolved[0]).containDeep({
        id: 'A1',
        response: { kind: 'multiple-choice', choice: 'Allow' },
        resolutionNote: 'confirmed warden.yaml: the change is in effect',
        resolvedBy: 'human',
      });
      should(answer.spent).equal(0);
    });

    it('should confirm it from a paired device with a passkey proved for the act, and spend that proof', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, FRESH_DEVICE, choose('Allow', 'go ahead'));

      // Assert
      should(answer.status).equal(200);
      should(answer.demands).deepEqual([{ capability: 'warden', axis: 'configure' }]);
      should(answer.spent).equal(1);
      should(await investigationsOn(subject)).be.true();
      should((await board(subject)).resolved[0]?.resolutionNote).equal(
        'confirmed warden.yaml: the change is in effect\ngo ahead',
      );
    });

    it('should demand a passkey proved for this act from a paired device without one, and change nothing', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, DEVICE, choose('Allow'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body).deepEqual({
        error: 'putting this change to warden.yaml into effect needs a passkey confirmation for it',
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'warden', axis: 'configure', act: 'loosen-config' },
      });
      should(await investigationsOn(subject)).be.false();
      should(await openItem(subject)).not.be.undefined();
    });

    it('should refuse a device the Warden grant does not allow to configure, and change nothing', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, { ...FRESH_DEVICE, refusal: 'not-granted' }, choose('Allow'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body.error).equal('this device may not change warden.yaml');
      should(await investigationsOn(subject)).be.false();
      should(await openItem(subject)).not.be.undefined();
    });
  });

  describe('a ferret can never confirm', () => {
    it('should refuse a ferret’s own CLI answer from its session, touching neither the file nor the card', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, FERRET_CLI, choose('Allow'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body).deepEqual({
        error: 'only the owner answers A1: it decides a change to warden.yaml, and a ferret never confirms one',
        code: 'forbidden',
      });
      should(await investigationsOn(subject)).be.false();
      should(await openItem(subject)).not.be.undefined();
    });

    it('should refuse an answer under an agent token', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, WARDEN_TOKEN, choose('Allow'));

      // Assert
      should(answer.status).equal(403);
      should(await investigationsOn(subject)).be.false();
      should(await openItem(subject)).not.be.undefined();
    });

    it('should refuse a relayed request that carries no passkey proof for the act', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, RELAYED, choose('Allow'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body.code).equal(STEP_UP_REQUIRED_CODE);
      should(await investigationsOn(subject)).be.false();
      should(await openItem(subject)).not.be.undefined();
    });

    it('should refuse when nothing can say what the caller may do', async () => {
      // Arrange
      const { subject } = await raised();
      const { governed: _governed, ...ungoverned } = HOST;

      // Act
      const answer = await post(subject, ungoverned, choose('Allow'));

      // Assert
      should(answer.status).equal(403);
      should(answer.body.code).equal('forbidden');
      should(await investigationsOn(subject)).be.false();
    });

    it('should still let the ferret close its own card without answering it', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, FERRET_CLI, { action: 'dismiss', id: 'A1', note: 'not needed' });

      // Assert
      should(answer.status).equal(200);
      should((await board(subject)).items).be.empty();
      should(await investigationsOn(subject)).be.false();
    });
  });

  describe('a held change that moved on', () => {
    it('should confirm nothing, restate the card with the change as it is now, and ask again', async () => {
      // Arrange
      const { subject, etag } = await raised();
      const edited = await holdLoosening(subject, WARDEN_ON_EDITED);

      // Act
      const answer = await post(subject, FRESH_DEVICE, choose('Allow'));

      // Assert
      should(answer.status).equal(409);
      should(answer.body).deepEqual({
        error:
          'warden.yaml was edited after A1 was raised, so nothing was confirmed: the card now shows the change as it is — read it and answer again',
        code: AGENDA_CONFIG_CHANGED_CODE,
      });
      should(answer.spent).equal(0);
      should(await investigationsOn(subject)).be.false();
      const item = await openItem(subject);
      should(item?.confirms?.etag).not.equal(etag);
      should(item?.confirms).deepEqual({
        path: 'warden.yaml',
        etag: edited,
        changes: ['the Warden may now spend on Jev decisions', 'the Warden may now spend on AI investigations'],
        restated: true,
      });
      should(item?.premise).startWith('- the Warden may now spend on Jev decisions\n');
      should(item?.revisions?.[0]).containDeep({ by: 'daemon', changed: ['premise'] });
    });

    it('should confirm the restated change on the owner’s next Allow', async () => {
      // Arrange
      const { subject } = await raised();
      await holdLoosening(subject, WARDEN_ON_EDITED);
      await post(subject, FRESH_DEVICE, choose('Allow'));

      // Act
      const answer = await post(subject, FRESH_DEVICE, choose('Allow'));

      // Assert
      should(answer.status).equal(200);
      should(await investigationsOn(subject)).be.true();
      should((await subject.config.load()).evaluation.effective.warden.layers.jev).be.true();
    });

    it('should close the card and say so when no change waits any more', async () => {
      // Arrange
      const { subject, etag } = await raised();
      should(await subject.config.confirm('warden.yaml', etag)).be.true();

      // Act
      const answer = await post(subject, HOST, choose('Allow'));

      // Assert
      should(answer.status).equal(409);
      should(answer.body.error).equal(
        'warden.yaml has no change waiting any more (it was confirmed, reverted or no longer loosens anything), so nothing was confirmed; A1 is closed',
      );
      should((await board(subject)).items).be.empty();
      should((await board(subject)).resolved[0]?.resolutionNote).equal(
        'nothing was confirmed: warden.yaml has no change waiting any more',
      );
    });
  });

  describe('Deny and Discard change', () => {
    it('should leave the change held on Deny, from any device, and tell the ferret', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, DEVICE, choose('Deny'));

      // Assert
      should(answer.status).equal(200);
      should(answer.demands).be.empty();
      should((await subject.config.status()).pending.map(each => each.path)).deepEqual(['warden.yaml']);
      should((await board(subject)).resolved[0]?.resolutionNote).equal(
        'denied: the change to warden.yaml stays held, not in effect',
      );
    });

    it('should put the file back to the version in effect on Discard change, asking only the configure grant', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, DEVICE, choose('Discard change'));

      // Assert
      should(answer.status).equal(200);
      should(answer.demands).deepEqual([{ capability: 'warden', axis: 'configure' }]);
      should(answer.spent).equal(0);
      should(subject.directory.texts.get('warden.yaml')).equal(WARDEN_OFF);
      should((await subject.config.status()).pending).be.empty();
      should((await board(subject)).resolved[0]?.resolutionNote).equal(
        'discarded the held change to warden.yaml: the version in effect stays',
      );
    });

    it('should remove a new file that was never in effect on Discard change', async () => {
      // Arrange
      const subject = await world();
      should((await subject.config.write('machine.yaml', MACHINE_SKIP, undefined, false)).outcome).equal('pending');
      await post(subject, FERRET_CLI, { ...RAISE, confirms: 'machine.yaml' });

      // Act
      const answer = await post(subject, HOST, choose('Discard change'));

      // Assert
      should(answer.status).equal(200);
      should(subject.directory.texts.has('machine.yaml')).be.false();
      should((await subject.config.status()).pending).be.empty();
    });

    it('should discard nothing when the held change moved on, and restate the card', async () => {
      // Arrange
      const { subject } = await raised();
      await holdLoosening(subject, WARDEN_ON_EDITED);

      // Act
      const answer = await post(subject, HOST, choose('Discard change'));

      // Assert
      should(answer.status).equal(409);
      should(answer.body.error).startWith('warden.yaml was edited after A1 was raised, so nothing was discarded');
      should(subject.directory.texts.get('warden.yaml')).equal(WARDEN_ON_EDITED);
      should((await openItem(subject))?.confirms?.restated).be.true();
    });

    it('should refuse a ferret’s Deny too: only the owner answers', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, FERRET_CLI, choose('Deny'));

      // Assert
      should(answer.status).equal(403);
      should(await openItem(subject)).not.be.undefined();
    });

    it('should record the owner’s own words as an answer that applies nothing', async () => {
      // Arrange
      const { subject } = await raised();

      // Act
      const answer = await post(subject, HOST, {
        action: 'resolve',
        id: 'A1',
        response: { kind: 'other', answer: 'ask me tomorrow' },
      });

      // Assert
      should(answer.status).equal(200);
      should(await investigationsOn(subject)).be.false();
      should((await board(subject)).resolved[0]?.response).deepEqual({ kind: 'other', answer: 'ask me tomorrow' });
    });
  });

  describe('an ordinary item', () => {
    it('should be answered as before, with no configuration act', async () => {
      // Arrange
      const subject = await world();
      await post(subject, FERRET_CLI, {
        action: 'add',
        title: 'Pick a branch',
        subject: 'which base branch?',
        why: 'the ticket names two',
        premise: 'A ferret needs the owner.',
        context: 'The work waits on this answer.',
        howToResolve: 'pick one',
        ask: { kind: 'multiple-choice', options: [{ label: 'Allow' }, { label: 'main' }] },
      });

      // Act
      const answer = await post(subject, FERRET_CLI, choose('Allow'));

      // Assert
      should(answer.status).equal(200);
      should(answer.demands).be.empty();
      should((await board(subject)).resolved[0]?.resolutionNote).be.null();
    });

    it('should answer an unknown item through the board’s own refusal', async () => {
      // Arrange
      const subject = await world();

      // Act
      const answer = await post(subject, HOST, choose('Allow'));

      // Assert
      should(answer.status).equal(404);
    });
  });
});
