import { describe, it } from 'bun:test';
import type {
  AskDraft,
  AskFilter,
  AskId,
  AskRef,
  AskSummary,
  AsksApi,
  CloseReason,
} from '@ferretry/core-asks/contract';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { SpawnOptions, SpawnPort, SpawnResult, StateFileDef } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import should from 'should';
import {
  type BoardFile,
  BoardFiles,
  BoardSwitchFiles,
  AsksLaneProposals,
  FerretProjectStamps,
  FerretsProjectFacts,
  GitProjectFacts,
  GitRepositoryProbe,
  LaneSetFiles,
  UsedProjects,
} from '../../../daemon/adapters/lanes/index.ts';
import {
  acceptedProposal,
  LANE_ASK_WITHDRAWN,
  LANE_PROPOSAL_SOURCE,
  LaneProposalAcceptance,
  laneProposalReference,
  LaneSetService,
  UNFILED_PROJECT_NAME,
} from '../../../daemon/lib/lanes/index.ts';
import manifest from '../../../manifest.ts';
import { FERRETRY_ID, project } from '../../unit/lanes/support.ts';

// ─── git, through the spawn port ─────────────────────────────────────────────────────────────────────────────────

type Call = { readonly program: string; readonly args: readonly string[] };

const spawnOf = (answer: (call: Call) => Partial<SpawnResult> | Error): Pick<SpawnPort, 'run'> & { calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    async run(program: string, args: readonly string[], _options?: SpawnOptions): Promise<SpawnResult> {
      const call = { program, args };
      calls.push(call);
      const result = answer(call);
      if (result instanceof Error) throw result;
      return { exitCode: 0, signal: null, stdout: '', stderr: '', ...result };
    },
  };
};

describe('GitRepositoryProbe (git asked for absolute paths, through the spawn port)', () => {
  it('should answer the common directory of a folder inside a repository', async () => {
    const spawn = spawnOf(() => ({ stdout: '/work/ferretry/.git\n' }));

    should(await new GitRepositoryProbe(spawn).commonDirectory('/work/ferretry/src')).equal('/work/ferretry/.git');
    should(spawn.calls[0]).eql({
      program: 'git',
      args: ['-C', '/work/ferretry/src', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    });
  });

  it('should answer null outside a repository, when git fails or is missing, or answers a relative path', async () => {
    should(await new GitRepositoryProbe(spawnOf(() => ({ exitCode: 128 }))).commonDirectory('/tmp')).equal(null);
    should(await new GitRepositoryProbe(spawnOf(() => ({ stdout: '' }))).commonDirectory('/tmp')).equal(null);
    should(await new GitRepositoryProbe(spawnOf(() => new Error('git is not installed'))).commonDirectory('/tmp')).equal(null);
    should(await new GitRepositoryProbe(spawnOf(() => ({ stdout: '.git\n' }))).commonDirectory('/tmp')).equal(null);
  });

  it('should name a repository by the folder holding its common .git, so a linked worktree names its checkout', async () => {
    const probe = new GitRepositoryProbe(spawnOf(() => ({ stdout: '/work/ferretry/.git\n/work/ferretry-wt/feature\n' })));

    should(await probe.locate('/work/ferretry-wt/feature')).eql({
      commonDirectory: '/work/ferretry/.git',
      root: '/work/ferretry',
    });
  });

  it('should name a repository whose common directory is not a .git folder by its working tree', async () => {
    const probe = new GitRepositoryProbe(spawnOf(() => ({ stdout: '/srv/repo.git\n/work/checkout\n' })));

    should(await probe.locate('/work/checkout')).eql({ commonDirectory: '/srv/repo.git', root: '/work/checkout' });
  });

  it('should locate nothing when git answers one line, or a relative one', async () => {
    should(await new GitRepositoryProbe(spawnOf(() => ({ stdout: '/work/x/.git\n' }))).locate('/work/x')).equal(null);
    should(await new GitRepositoryProbe(spawnOf(() => ({ stdout: '.git\n.\n' }))).locate('/work/x')).equal(null);
  });
});

describe('GitProjectFacts', () => {
  const facts = (tags: string, repository = true) =>
    new GitProjectFacts(
      spawnOf(call => (call.args.includes('tag') ? { stdout: tags } : { stdout: repository ? '/w/.git\n' : '', exitCode: repository ? 0 : 128 })),
    );

  it('should say a folder outside a repository has none', async () => {
    should(await facts('v1\n', false).inspect('/w')).eql({ hasRepository: false, hasReleaseTags: false });
  });

  it('should say a repository with a v* tag ships releases, and one without does not', async () => {
    should(await facts('v1.2.0\n').inspect('/w')).eql({ hasRepository: true, hasReleaseTags: true });
    should(await facts('').inspect('/w')).eql({ hasRepository: true, hasReleaseTags: false });
  });

  it('should read a failed tag listing as no tags', async () => {
    const failing = new GitProjectFacts(
      spawnOf(call => (call.args.includes('tag') ? new Error('boom') : { stdout: '/w/.git\n' })),
    );

    should(await failing.inspect('/w')).eql({ hasRepository: true, hasReleaseTags: false });
  });
});

// ─── ferrets ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ferretsOf = (known: Record<string, { folder: string; parent?: string }>): Pick<FerretsApi, 'get'> => ({
  get: async id => (known[id] === undefined ? undefined : ({ id, ...known[id] } as never)),
});

describe('FerretsProjectFacts', () => {
  it('should read a ferret’s folder and parent from Ferrets, and the board it was moved onto', async () => {
    const stamps = new FerretProjectStamps();
    const facts = new FerretsProjectFacts(ferretsOf({ koen: { folder: '/work/a', parent: 'lead' }, lead: { folder: '/work' } }), stamps);

    should(await facts.read('koen')).eql({ folder: '/work/a', parent: 'lead' });
    await stamps.stamp('koen', FERRETRY_ID);
    should(await facts.read('koen')).eql({ folder: '/work/a', parent: 'lead', projectId: FERRETRY_ID });
    should(await facts.read('nobody')).equal(null);
    should(await facts.parentOf('koen')).equal('lead');
    should(await facts.parentOf('lead')).be.undefined();
    should(await facts.parentOf('nobody')).be.undefined();
  });

  it('should keep a stamp on a real board: only an Unfiled ferret moves', async () => {
    const stamps = new FerretProjectStamps();
    await stamps.stamp('koen', 'unfiled');
    await stamps.stamp('koen', FERRETRY_ID);
    await stamps.stamp('koen', '33333333-3333-4333-8333-333333333333');

    should(stamps.of('koen')).equal(FERRETRY_ID);
  });
});

// ─── projects ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('UsedProjects', () => {
  it('should list nothing and refuse to register while Projects is off', async () => {
    const used = new UsedProjects(() => undefined);

    should(await used.projects()).eql([]);
    await used.register({ kind: 'confirmed-discovery', path: '/work/x' }).then(
      () => {
        throw new Error('registered with Projects off');
      },
      error => should((error as Error).message).containEql('Projects is off'),
    );
  });

  it('should read and register through Projects when it is on, and throw its refusal', async () => {
    const registered = project(FERRETRY_ID, '/work/ferretry');
    const api = {
      list: async () => [registered],
      register: async (request: { path: string }) =>
        request.path === '/work/ferretry'
          ? { ok: true as const, value: registered }
          : { ok: false as const, error: { code: 'registration_failed' as const, message: 'no such folder' } },
    } as unknown as ProjectsApi;
    const used = new UsedProjects(() => api);

    should(await used.projects()).eql([registered]);
    should(await used.register({ kind: 'confirmed-discovery', path: '/work/ferretry' })).equal(registered);
    await used.register({ kind: 'confirmed-discovery', path: '/nowhere' }).then(
      () => {
        throw new Error('registered a missing folder');
      },
      error => should((error as Error).message).equal('no such folder'),
    );
  });
});

// ─── asks ────────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeAsks implements Pick<AsksApi, 'raise' | 'open' | 'close'> {
  readonly raised: AskDraft[] = [];
  readonly closed: Array<readonly [string, CloseReason]> = [];
  private readonly open_: AskSummary[] = [];

  async raise(draft: AskDraft): Promise<AskRef> {
    const existing = this.open_.find(ask => ask.source === draft.source && ask.entry === draft.entry);
    if (existing !== undefined) return { ferret: draft.ferret ?? '', id: existing.id };
    this.raised.push(draft);
    const id = `A${String(this.open_.length + 1)}` as AskId;
    this.open_.push({
      id,
      source: draft.source,
      entry: draft.entry,
      kind: draft.kind,
      subject: draft.subject,
      raisedBy: draft.raisedBy,
      ...(draft.ferret === undefined ? {} : { ferret: draft.ferret }),
      state: 'open',
      raisedAt: '2026-11-01T12:00:00.000Z' as never,
    } as unknown as AskSummary);
    return { ferret: draft.ferret ?? '', id };
  }

  async open(filter: AskFilter): Promise<readonly AskSummary[]> {
    return this.open_.filter(
      ask => ask.state === 'open' && ask.source === filter.source && (filter.entry === undefined || ask.entry === filter.entry),
    );
  }

  async close(ref: AskRef, reason: CloseReason): Promise<void> {
    this.closed.push([ref.id, reason]);
    const at = this.open_.findIndex(ask => ask.id === ref.id);
    if (at !== -1) this.open_[at] = { ...(this.open_[at] as AskSummary), state: 'closed' };
  }
}

const FILE = manifest.data.state.find(file => file.name === 'boards') as StateFileDef<string, BoardFile>;
const OWNER = { kind: 'owner' } as const;

const board = () => {
  const folder = new MemoryStateFolder();
  const files = new BoardFiles(folder.port([FILE]), FILE);
  const asks = new FakeAsks();
  const moves: Array<Readonly<Record<string, string>>> = [];
  const service = new LaneSetService(
    new LaneSetFiles(files),
    new UsedProjects(() => ({ list: async () => [project(FERRETRY_ID, '/work/ferretry')] }) as unknown as ProjectsApi),
    { projectOf: async () => FERRETRY_ID },
    new AsksLaneProposals(asks),
    {
      relocate: async (_project, relocation) => {
        moves.push(relocation);
      },
    },
  );
  return { folder, files, asks, service, moves, switches: new BoardSwitchFiles(files) };
};

describe('lane proposals through Asks, over the stored board file', () => {
  it('should raise one choice ask for the proposing ferret, keyed by project and version', async () => {
    const { asks, service } = board();

    const change = await service.apply(FERRETRY_ID, { action: 'propose', template: 'quick', renames: {} }, { kind: 'ferret', name: 'koen', ferretId: 'koen' });

    should(change.ok && change.value.ask).equal('raised');
    should(asks.raised).have.length(1);
    const [draft] = asks.raised;
    should(draft?.source).equal(LANE_PROPOSAL_SOURCE);
    should(draft?.entry).equal(laneProposalReference(FERRETRY_ID, 1));
    should(draft?.kind).equal('choice');
    should(draft?.ferret).equal('koen');
    should(draft?.raisedBy).eql({ kind: 'daemon' });
    should(draft?.options?.map(option => option.label)).eql(['Edit', 'Accept']);
  });

  it('should raise the same proposal once however often it is asked', async () => {
    const { asks } = board();
    const raise = new AsksLaneProposals(asks);
    const card = { subject: 's', title: 't', kind: 'choice' as const, options: [{ label: 'Edit', description: 'e' }, { label: 'Accept', description: 'a' }], why: 'w', howToResolve: 'h' };

    await raise.raise('koen', laneProposalReference(FERRETRY_ID, 1), card);
    await raise.raise('koen', laneProposalReference(FERRETRY_ID, 1), card);

    should(asks.raised).have.length(1);
  });

  it('should carry the recommendation as the ask’s context', async () => {
    const { asks } = board();

    await new AsksLaneProposals(asks).raise('koen', laneProposalReference(FERRETRY_ID, 2), {
      subject: 's',
      title: 't',
      kind: 'choice',
      options: [{ label: 'Edit', description: 'e' }, { label: 'Accept', description: 'a' }],
      why: 'w',
      recommendation: { decision: 'Edit', why: 'read it first' },
      howToResolve: 'h',
    });

    should(asks.raised[0]?.context).equal('Recommended: Edit. read it first');
  });

  it('should confirm the lanes when the owner’s Accept comes back, and not before', async () => {
    const { service, asks, files } = board();
    await service.apply(FERRETRY_ID, { action: 'propose', template: 'quick', renames: {} }, { kind: 'ferret', name: 'koen', ferretId: 'koen' });
    const acceptance = new LaneProposalAcceptance(service);
    const lanes = new LaneSetFiles(files);
    should((await lanes.read(FERRETRY_ID))?.confirmedBy).equal(null);

    await acceptance.answered({
      source: LANE_PROPOSAL_SOURCE,
      entry: asks.raised[0]?.entry ?? '',
      effect: 'choose',
      choice: 'Edit',
    });
    should((await lanes.read(FERRETRY_ID))?.confirmedBy).equal(null);
    await acceptance.answered({
      source: LANE_PROPOSAL_SOURCE,
      entry: asks.raised[0]?.entry ?? '',
      effect: 'choose',
      choice: 'Accept',
    });

    should((await lanes.read(FERRETRY_ID))?.confirmedBy).equal('owner');
    should(acceptedProposal({ source: LANE_PROPOSAL_SOURCE, entry: asks.raised[0]?.entry ?? '', effect: 'choose', choice: 'Accept' })).eql({
      projectId: FERRETRY_ID,
      version: 1,
    });
  });

  it('should close the ask of a proposal the owner replaced by editing the lanes', async () => {
    const { service, asks } = board();
    await service.apply(FERRETRY_ID, { action: 'propose', template: 'quick', renames: {} }, { kind: 'ferret', name: 'koen', ferretId: 'koen' });
    // The owner confirms the live set; a ferret then waits behind it with a change, which the owner replaces.
    await service.apply(FERRETRY_ID, { action: 'confirm', version: 1 }, OWNER);
    const ferret = { kind: 'ferret', name: 'koen', ferretId: 'koen' } as const;
    const stored = (await service.laneSet(FERRETRY_ID))!;
    await service.apply(
      FERRETRY_ID,
      { action: 'edit', version: stored.version, layout: { lanes: stored.lanes.map(lane => ({ ...lane, name: `${lane.name}!` })), variants: stored.variants }, relocate: {} } as never,
      ferret,
    );
    const waiting = (await service.laneSet(FERRETRY_ID))?.pending;
    should(waiting).not.be.undefined();

    await service.apply(FERRETRY_ID, { action: 'edit', version: stored.version, layout: { lanes: stored.lanes, variants: stored.variants }, relocate: {} } as never, OWNER);

    should(asks.closed.map(([, reason]) => reason)).containEql('withdrawn');
    should(LANE_ASK_WITHDRAWN.dropped).containEql('proposal is gone');
  });

  it('should list the Unfiled board first and name it', async () => {
    const { service } = board();

    const projects = await service.projects();

    should(projects[0]?.id).equal('unfiled');
    should(projects[0]?.name).equal(UNFILED_PROJECT_NAME);
    should(projects[1]?.id).equal(FERRETRY_ID);
  });
});
