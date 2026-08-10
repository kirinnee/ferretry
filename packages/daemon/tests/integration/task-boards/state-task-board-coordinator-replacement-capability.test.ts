import { afterAll, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileTaskBoardRepository } from '../../../src/adapters/task-boards/file-task-board-repository.ts';
import { NodeTaskBoardCredentialIssuer } from '../../../src/adapters/task-boards/node-task-board-credential-issuer.ts';
import { StateTaskBoardCoordinatorReplacementCapability } from '../../../src/adapters/task-boards/state-task-board-coordinator-replacement-capability.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import type { ApiResponse } from '../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import {
  BOARD_CAPABILITY_HEADER,
  BOARD_CAPABILITY_VARIABLE,
  type TaskBoardSubsystem,
  taskBoardRoutes,
} from '../../../src/lib/runtime/mounts/task-boards.ts';
import type {
  TaskBoardCoordinatorReplacementCapabilityIdentity,
  TaskBoardSession,
} from '../../../src/lib/task-boards/types.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { CREDENTIALS, human } from '../../unit/runtime/mounts/support.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const IDENTITY: TaskBoardCoordinatorReplacementCapabilityIdentity = {
  requestId: 'replace-1',
  boardId: 'board-1',
  memberSessionId: 'root-1',
  replacementSessionId: 'successor-1',
  replacementRootSessionId: 'replacement-root-1',
  replacementSessionIncarnation: 'successor-1-incarnation',
  replacementRuntimeGeneration: 3,
};

async function capability() {
  const home = await tempDirectory('board-coordinator-replacement-capability');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.home, 0o700);
  return { paths, files };
}

const SESSIONS: readonly TaskBoardSession[] = [
  {
    id: 'root',
    incarnation: 'root-1',
    runtimeGeneration: 1,
    parentSessionId: null,
    mode: 'interactive',
    active: true,
    name: null,
    teammate: null,
    sessionCapabilityHash: createHash('sha256').update('session:root', 'utf8').digest('hex'),
  },
  {
    id: 'coordinator',
    incarnation: 'coordinator-1',
    runtimeGeneration: 1,
    parentSessionId: 'root',
    mode: 'auto',
    active: true,
    name: null,
    teammate: null,
    sessionCapabilityHash: createHash('sha256').update('session:coordinator', 'utf8').digest('hex'),
  },
  {
    id: 'replacement',
    incarnation: 'replacement-1',
    runtimeGeneration: 1,
    parentSessionId: 'root',
    mode: 'auto',
    active: true,
    name: null,
    teammate: null,
    sessionCapabilityHash: createHash('sha256').update('session:replacement', 'utf8').digest('hex'),
  },
];

function restartedWorld(
  paths: ReturnType<typeof createFoundationPaths>,
  deliver: TaskBoardSubsystem['deliver'],
): TaskBoardSubsystem & {
  readonly coordinatorReplacementCapabilities: StateTaskBoardCoordinatorReplacementCapability;
} {
  const files = new StateFileSystem(paths);
  const issuer = new NodeTaskBoardCredentialIssuer();
  return {
    repository: new FileTaskBoardRepository(join(paths.home, 'task-boards.json')),
    sessions: { snapshot: async () => SESSIONS },
    issuer,
    coordinatorReplacementCapabilities: new StateTaskBoardCoordinatorReplacementCapability(paths, files),
    now: () => '2026-08-06T08:00:00.000Z',
    operatorCapabilityHash: async () => issuer.hash('operator-secret'),
    deliver,
  };
}

function dispatcher(world: TaskBoardSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(taskBoardRoutes(world)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

async function post(world: TaskBoardSubsystem, path: string, body: unknown): Promise<ApiResponse> {
  return await dispatcher(world).dispatch(
    request({
      method: 'POST',
      path: `/v1/task-boards${path}`,
      headers: {
        ...human,
        'content-type': 'application/json',
        'x-fy-board-admin-capability': 'operator-secret',
      },
      body: JSON.stringify(body),
    }),
  );
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('StateTaskBoardCoordinatorReplacementCapability', () => {
  it('should reproduce byte-identical material through a newly constructed adapter over the same state home', async () => {
    // Arrange
    const { paths, files } = await capability();
    const firstBoot = new StateTaskBoardCoordinatorReplacementCapability(paths, files, size => Buffer.alloc(size, 7));

    // Act — the second adapter has no access to the first one's memory, and its issuer must not run.
    const first = await firstBoot.derive(IDENTITY);
    const reopened = new StateTaskBoardCoordinatorReplacementCapability(paths, files, () => {
      throw new Error('a persisted seed must be reused');
    });
    const retry = await reopened.derive(IDENTITY);
    const normalized = await reopened.derive({ ...IDENTITY, requestId: ` ${IDENTITY.requestId} ` });

    // Assert
    should(retry).deepEqual(first);
    should(normalized).deepEqual(first);
    should(retry.hash).equal(createHash('sha256').update(retry.value, 'utf8').digest('hex'));
  });

  it('should recover a post-commit delivery through a newly constructed production world', async () => {
    // Arrange
    const { paths } = await capability();
    let failedCapability: string | undefined;
    const firstBoot = restartedWorld(paths, async (sessionId, variables) => {
      if (sessionId === 'replacement') {
        failedCapability = variables[BOARD_CAPABILITY_VARIABLE];
        throw new Error('the first delivery failed after commit');
      }
    });
    should(
      (await post(firstBoot, '/create', { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' })).status,
    ).equal(201);
    const replacement = {
      requestId: 'restart-recovery',
      sessionId: 'root',
      replacementSessionId: 'replacement',
      replacementRootSessionId: 'root',
    };

    // Act — reconstruct every production adapter over the same home before retrying the exact body.
    const failed = await post(firstBoot, '/coordinator/replace', replacement);
    let recoveredCapability = '';
    const secondBoot = restartedWorld(paths, async (sessionId, variables) => {
      if (sessionId === 'replacement') recoveredCapability = variables[BOARD_CAPABILITY_VARIABLE] ?? '';
    });
    const recovered = await post(secondBoot, '/coordinator/replace', replacement);
    const authenticated = await dispatcher(secondBoot).dispatch(
      request({
        path: '/v1/task-boards/membership',
        headers: { ...human, [BOARD_CAPABILITY_HEADER]: recoveredCapability },
      }),
    );

    // Assert
    should(failed.status).equal(500);
    should(recovered.status).equal(200);
    should(recoveredCapability).equal(failedCapability);
    should(authenticated.status).equal(200);
    should(JSON.stringify(jsonBody(recovered))).not.containEql(recoveredCapability);
  });

  it('should bind every operation and replacement identity term into a domain-separated capability', async () => {
    // Arrange
    const { paths, files } = await capability();
    const subject = new StateTaskBoardCoordinatorReplacementCapability(paths, files, size => Buffer.alloc(size, 5));
    const original = await subject.derive(IDENTITY);
    const variants: TaskBoardCoordinatorReplacementCapabilityIdentity[] = [
      { ...IDENTITY, requestId: 'replace-2' },
      { ...IDENTITY, boardId: 'board-2' },
      { ...IDENTITY, memberSessionId: 'root-2' },
      { ...IDENTITY, replacementSessionId: 'successor-2' },
      { ...IDENTITY, replacementRootSessionId: 'replacement-root-2' },
      { ...IDENTITY, replacementSessionIncarnation: 'successor-1-reincarnated' },
      { ...IDENTITY, replacementRuntimeGeneration: 4 },
    ];

    // Act
    const derived = await Promise.all(variants.map(async identity => await subject.derive(identity)));

    // Assert
    should(new Set([original.value, ...derived.map(secret => secret.value)]).size).equal(variants.length + 1);
  });

  it('should refuse rather than poison the coordinator pane when the durable seed is lost', async () => {
    // Arrange
    const { paths } = await capability();
    let appliedCapability = '';
    const firstBoot = restartedWorld(paths, async (sessionId, variables) => {
      if (sessionId === 'replacement') appliedCapability = variables[BOARD_CAPABILITY_VARIABLE] ?? '';
    });
    should(
      (await post(firstBoot, '/create', { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' })).status,
    ).equal(201);
    const replacement = {
      requestId: 'lost-seed-recovery',
      sessionId: 'root',
      replacementSessionId: 'replacement',
      replacementRootSessionId: 'root',
    };
    should((await post(firstBoot, '/coordinator/replace', replacement)).status).equal(200);
    await unlink(firstBoot.coordinatorReplacementCapabilities.file());
    let poisonedDelivery = '';
    const secondBoot = restartedWorld(paths, async (sessionId, variables) => {
      if (sessionId === 'replacement') poisonedDelivery = variables[BOARD_CAPABILITY_VARIABLE] ?? '';
    });

    // Act
    const replay = await post(secondBoot, '/coordinator/replace', replacement);
    const stillAuthenticates = await dispatcher(secondBoot).dispatch(
      request({
        path: '/v1/task-boards/membership',
        headers: { ...human, [BOARD_CAPABILITY_HEADER]: appliedCapability },
      }),
    );

    // Assert — a newly minted seed cannot reproduce the committed grant, so no secret is delivered.
    should(replay.status).equal(503);
    should(JSON.stringify(jsonBody(replay))).match(/can no longer be recovered/u);
    should(poisonedDelivery).equal('');
    should(stillAuthenticates.status).equal(200);
  });

  it('should persist only the private seed owner-readable, never the derived capability', async () => {
    // Arrange
    const { paths, files } = await capability();
    const subject = new StateTaskBoardCoordinatorReplacementCapability(paths, files, size => Buffer.alloc(size, 9));

    // Act
    const secret = await subject.derive(IDENTITY);
    const seedDocument = await files.readText(subject.file());

    // Assert
    should((await stat(subject.file())).mode & 0o777).equal(0o600);
    should(seedDocument).not.containEql(secret.value);
  });

  it('should refuse a damaged durable seed instead of rotating away recoverable grants', async () => {
    // Arrange
    const { paths, files } = await capability();
    const subject = new StateTaskBoardCoordinatorReplacementCapability(paths, files);
    await writeFile(subject.file(), 'not-a-256-bit-seed\n', 'utf8');

    // Act + Assert
    await should(subject.derive(IDENTITY)).be.rejectedWith(/invalid task-board coordinator replacement seed/u);
  });

  it('should refuse an issuer that does not provide a full 256-bit seed', async () => {
    // Arrange
    const { paths, files } = await capability();
    const subject = new StateTaskBoardCoordinatorReplacementCapability(paths, files, () => Buffer.alloc(31));

    // Act + Assert
    await should(subject.derive(IDENTITY)).be.rejectedWith(/must return exactly 32 bytes/u);
  });
});
