import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FleetConfigSchema, FleetPlan, SharedHistoryMigration } from '@ferretry/fleet';
import { FileFleetProvisioner, FileSharedHistoryFileSystem } from '@ferretry/fleet/adapters';
import should from 'should';
import { FleetController } from '../../../src/lib/fleet/controller.ts';
import { resolveFleetLayout } from '../../../src/lib/fleet/layout.ts';
import {
  CapturingOutput,
  FrozenClock,
  RecordingAuthorizationGateway,
  RecordingIdentitySource,
  RecordingLoginService,
  RecordingRecommendationGateway,
  RecordingScaffolder,
  RecordingUsageCollector,
  StubManifestSource,
} from '../../unit/fleet/fixtures.ts';

const ACCOUNT_A = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT_B = '00000000-0000-4000-8000-0000000000b2';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('CLI shared-history apply', () => {
  it('should report an exact collision without writing, then migrate the same disposable homes', async () => {
    // Arrange — every path is beneath this test's temporary FY_HOME/user home.
    const root = await mkdtemp(path.join(tmpdir(), 'fy-cli-shared-history-'));
    temporaryDirectories.push(root);
    const layout = resolveFleetLayout({
      stateHome: path.join(root, 'fy-home'),
      userHome: path.join(root, 'user'),
      product: 'ferretry',
    });
    const config = FleetConfigSchema.parse({
      sharedHistory: { claude: true },
      agents: [
        {
          name: 'a',
          kind: 'claude',
          routes: {
            default: {
              id: ACCOUNT_A,
              wrapper: 'fy-claude-a',
              home: 'claude-a',
              defaultModel: 'opus',
              models: ['opus'],
            },
          },
        },
        {
          name: 'b',
          kind: 'claude',
          routes: {
            default: {
              id: ACCOUNT_B,
              wrapper: 'fy-claude-b',
              home: 'claude-b',
              defaultModel: 'opus',
              models: ['opus'],
            },
          },
        },
      ],
    });
    const homeA = path.join(layout.homesDirectory, 'claude-a');
    const homeB = path.join(layout.homesDirectory, 'claude-b');
    const fileA = path.join(homeA, 'projects', 'project', 'conversation.jsonl');
    const fileB = path.join(homeB, 'projects', 'project', 'conversation.jsonl');
    await mkdir(path.dirname(fileA), { recursive: true });
    await mkdir(path.dirname(fileB), { recursive: true });
    await Bun.write(fileA, 'older\n');
    await Bun.write(fileB, 'newer\n');
    await utimes(fileA, 10, 10);
    await utimes(fileB, 20, 20);

    const roots = [layout.fleetDirectory, layout.userHome];
    const applier = new FileFleetProvisioner(roots, new SharedHistoryMigration(new FileSharedHistoryFileSystem(roots)));
    const output = new CapturingOutput();
    const controller = new FleetController({
      config: { load: () => Promise.resolve(config) },
      manifests: new StubManifestSource(null),
      scaffolder: new RecordingScaffolder(),
      planner: { build: (value, generatedAt) => new FleetPlan().build(value, layout, generatedAt) },
      applier,
      usage: new RecordingUsageCollector(),
      identities: new RecordingIdentitySource(),
      logins: new RecordingLoginService(),
      clock: new FrozenClock('2027-01-15T08:00:00.000Z'),
      recommendations: new RecordingRecommendationGateway(),
      authorizations: new RecordingAuthorizationGateway(),
      out: output,
    });
    const pool = path.join(layout.fleetDirectory, 'shared', 'claude');
    const pooledFile = path.join(pool, 'projects', 'project', 'conversation.jsonl');
    const preserved = path.join(pool, '.migration-conflicts', ACCOUNT_A, 'projects', 'project', 'conversation.jsonl');

    // Act — preview first, then explicitly apply the same configuration.
    await controller.apply({ dryRun: true });
    const preview = output.text;
    const beforeApply = await lstat(path.join(homeA, 'projects'));
    await controller.apply({});

    // Assert — preview named the observed winner/loser and performed no write.
    should(preview).containEql('nothing has been written');
    should(preview).containEql(
      `collision ${fileB} ↔ ${pooledFile}; winner ${fileB}; preserve loser ${pooledFile} at ${preserved}`,
    );
    should(beforeApply.isDirectory()).be.true();

    // Apply materialized the previewed outcome, preserving the older evidence and linking both homes.
    should((await lstat(path.join(homeA, 'projects'))).isSymbolicLink()).be.true();
    should((await lstat(path.join(homeB, 'projects'))).isSymbolicLink()).be.true();
    should(await readlink(path.join(homeA, 'projects'))).equal(path.join(pool, 'projects'));
    should(await readlink(path.join(homeB, 'projects'))).equal(path.join(pool, 'projects'));
    should(await readFile(pooledFile, 'utf8')).equal('newer\n');
    should(await readFile(preserved, 'utf8')).equal('older\n');
    should(output.lines.at(-1)).containEql('shared claude:');
  });
});
