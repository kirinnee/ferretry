import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it, setDefaultTimeout } from 'bun:test';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../packages/daemon/src/adapters/index.ts';
import {
  firstTurnInstruction,
  parseSessionId,
  SessionEffectRecordSchema,
  type SessionEffectRecord,
} from '../../packages/daemon/src/lib/index.ts';
import { FyApiClient, FyHttpError } from '../../packages/protocol/src/adapters/fy-api-client.ts';
import {
  AttachmentDownloadSchema,
  type ForkSessionRequest,
  SessionTransferPlanSchema,
} from '../../packages/protocol/src/lib/index.ts';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';

setDefaultTimeout(120_000);

const NOW = '2026-08-06T10:00:00.000Z';
const SOURCE_ID = 'fork-source';
const SOURCE_HARNESS_SESSION_ID = 'codex-source-rollout';
const SOURCE_AGENT = 'codex-auto-fork-source';
const SOURCE_MODEL = 'gpt-5.6-terra';
const TARGET_AGENT = 'claude-auto-fork-target';
const TARGET_MODEL = 'claude-opus-4-8';
const REQUEST_ID = 'compiled-daemon-fork-1';
const SOURCE_MESSAGE = 'Carry this exact source conversation into the compiled-daemon fork target.';
const ATTACHMENT_NAME = 'fork-evidence.txt';
const ATTACHMENT_BODY = 'attachment bytes carried through the mounted fork route\n';
const TARGET_READY_MARKER = 'E2E opening turn accepted';
const THROUGH = { v: 1, byteOffset: 512, blockIndex: 0 } as const;

function sessionDirectory(environment: E2eEnvironment, id: string): string {
  return join(environment.paths.fyHome, 'state', 'sessions', id);
}

async function sessionEffects(environment: E2eEnvironment, id: string): Promise<readonly SessionEffectRecord[]> {
  const directory = join(sessionDirectory(environment, id), 'effects');
  const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
  const records = await Promise.all(
    files.map(async file => SessionEffectRecordSchema.parse(JSON.parse(await readFile(join(directory, file), 'utf8')))),
  );
  return records.sort((left, right) => left.effectId.localeCompare(right.effectId));
}

async function compiledDaemon(environment: E2eEnvironment): Promise<string> {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined;
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64-baseline' : undefined;
  if (platform === undefined || architecture === undefined) throw new Error('this E2E host has no compiled fyd target');
  const executable = await environment.assertSafePath(
    join(environment.repositoryRoot, 'dist', 'bin', `fyd-${platform}-${architecture}`),
    'compiled daemon',
  );
  await access(executable, fsConstants.X_OK);
  return executable;
}

async function installTargetWrapper(environment: E2eEnvironment, targetHome: string): Promise<string> {
  const sourcePath = await environment.assertSafePath(
    join(environment.repositoryRoot, 'scripts', 'test', 'fake-harness.ts'),
    'fake target harness source',
  );
  const targetPath = await environment.assertSafePath(join(environment.paths.bin, TARGET_AGENT), 'target wrapper');
  const source = await readFile(sourcePath, 'utf8');
  const shebang = '#!/usr/bin/env bun\n';
  const scenarioRead = '    source = await Bun.file(scenarioPath).text();';
  if (!source.startsWith(shebang) || !source.includes(scenarioRead)) {
    throw new Error('fake harness source no longer has the transformation anchors this journey requires');
  }
  const declaredHome = `${shebang}\n/*\nexport CLAUDE_CONFIG_DIR=${JSON.stringify(targetHome)}\n*/\n`;
  const transformed = source
    .replace(shebang, declaredHome)
    .replace(
      scenarioRead,
      `${scenarioRead}\n    source = source.replaceAll('__TARGET_SESSION_ID__', process.env.FY_SESSION_ID ?? '');`,
    );
  await writeFile(targetPath, transformed, { encoding: 'utf8', mode: 0o755 });
  await chmod(targetPath, 0o755);
  return targetPath;
}

async function writeSourceTranscript(file: string, cwd: string): Promise<void> {
  const header = {
    type: 'session_meta',
    payload: { id: SOURCE_HARNESS_SESSION_ID, cwd },
    padding: '',
  };
  const emptyHeader = JSON.stringify(header);
  const paddingLength = THROUGH.byteOffset - Buffer.byteLength(`${emptyHeader}\n`);
  if (paddingLength < 0) throw new Error('the source transcript header no longer fits before the pinned cut');
  const firstLine = JSON.stringify({ ...header, padding: 'x'.repeat(paddingLength) });
  if (Buffer.byteLength(`${firstLine}\n`) !== THROUGH.byteOffset) {
    throw new Error('the source transcript fixture did not place its second record at byte 512');
  }
  const secondLine = JSON.stringify({
    timestamp: NOW,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: SOURCE_MESSAGE }],
    },
  });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${firstLine}\n${secondLine}\n`, 'utf8');
}

async function seedSource(environment: E2eEnvironment, transcriptFile: string, sourceHome: string): Promise<void> {
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: environment.paths.fyHome }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  const id = parseSessionId(SOURCE_ID);
  try {
    await opened.storage.writeConfig(id, {
      id,
      incarnation: `${id}-1`,
      runtimeGeneration: 1,
      name: 'Compiled fork source',
      boardAccess: 'none',
      agent: SOURCE_AGENT,
      harness: 'codex',
      modelHint: SOURCE_MODEL,
      model: SOURCE_MODEL,
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: join(environment.paths.root, 'workspace'),
      createdAt: NOW,
      updatedAt: NOW,
      turn: 1,
      intervalSeconds: 60,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      transcript: {
        v: 1,
        home: sourceHome,
        harnessSessionId: SOURCE_HARNESS_SESSION_ID,
        identity: 'correlated',
        file: transcriptFile,
        resolvedAt: NOW,
      },
      retry: {
        transientAttempts: 0,
        stalledAttempts: 0,
        waitForQuotaReset: false,
        allowAccountFailover: false,
      },
    });
    await opened.storage.writeState(id, { id, status: 'stopped', turn: 1, finishedAt: NOW });
    await opened.storage.append(id, 'session.stopped', { reason: 'seeded E2E source' });
  } finally {
    await opened.storage.close();
  }
}

async function publishManifest(
  environment: E2eEnvironment,
  input: {
    readonly sourceWrapper: string;
    readonly sourceHome: string;
    readonly targetWrapper: string;
    readonly targetHome: string;
  },
): Promise<void> {
  const fleet = join(environment.paths.fyHome, 'fleet');
  await mkdir(fleet, { recursive: true });
  await writeFile(
    join(fleet, 'manifest.json'),
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: NOW,
        accounts: [
          {
            id: '00000000-0000-4000-8000-000000000121',
            kind: 'codex',
            mode: 'auto',
            wrapper: input.sourceWrapper,
            home: input.sourceHome,
            displayName: 'E2E Codex source',
            defaultModel: SOURCE_MODEL,
            models: [{ id: SOURCE_MODEL, available: true }],
            available: true,
            unavailableReason: null,
          },
          {
            id: '00000000-0000-4000-8000-000000000122',
            kind: 'claude',
            mode: 'auto',
            wrapper: input.targetWrapper,
            home: input.targetHome,
            displayName: 'E2E Claude target',
            defaultModel: TARGET_MODEL,
            models: [{ id: TARGET_MODEL, available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function startCompiledDaemon(environment: E2eEnvironment, executable: string): Promise<void> {
  await environment.startDaemon({
    command: [executable, '--host', '127.0.0.1', '--port', String(environment.ports.api)],
    useDaemonPrivateTmux: true,
    readyUrl: environment.httpUrl('/healthz'),
    timeoutMs: 30_000,
  });
}

async function connect(environment: E2eEnvironment): Promise<FyApiClient> {
  const token = (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
  return await FyApiClient.connect({ baseUrl: environment.httpUrl(), token, version: '0.0.0' });
}

async function stopPrivateTmux(environment: E2eEnvironment): Promise<void> {
  const executable = environment.childEnvironment().FY_E2E_REAL_TMUX;
  if (executable === undefined || executable === '') return;
  const process = Bun.spawn([executable, '-S', join(environment.paths.fyHome, 'tmux.sock'), 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await process.exited;
}

describe('compiled daemon conversation fork', () => {
  it('should fork across harnesses once and replay the frozen outcome after restart', async () => {
    await withE2eEnvironment(async environment => {
      const workspace = join(environment.paths.root, 'workspace');
      const sourceHome = join(environment.paths.root, 'codex-home');
      const targetHome = join(environment.paths.root, 'claude-home');
      const transcriptFile = join(sourceHome, 'sessions', '2026', '08', '06', 'rollout-source.jsonl');
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(sourceHome, { recursive: true }),
        mkdir(targetHome, { recursive: true }),
      ]);
      await writeSourceTranscript(transcriptFile, workspace);
      const sourceWrapper = await environment.installFakeHarness(SOURCE_AGENT);
      const targetWrapper = await installTargetWrapper(environment, targetHome);
      await seedSource(environment, transcriptFile, sourceHome);
      await publishManifest(environment, { sourceWrapper, sourceHome, targetWrapper, targetHome });

      const expectedTurn = firstTurnInstruction(
        join(sessionDirectory(environment, '__TARGET_SESSION_ID__'), 'turns', 'turn-001.md'),
      );
      await environment.setFakeHarnessScenario({
        version: 1,
        steps: [
          { type: 'say', text: 'E2E target ready' },
          { type: 'ask', text: '>\u001b[1A', expect: '/effort high' },
          { type: 'ask', text: '>\u001b[1A', expect: expectedTurn },
          { type: 'say', text: TARGET_READY_MARKER },
          { type: 'ask', text: '>\u001b[1A', expect: '__E2E_CLEANUP__' },
        ],
      });

      const executable = await compiledDaemon(environment);
      let client: FyApiClient | undefined;
      let targetId: string | undefined;
      let daemonRunning = false;
      try {
        await startCompiledDaemon(environment, executable);
        daemonRunning = true;
        client = await connect(environment);
        const sourceMessages = await client.messages(SOURCE_ID, undefined, 1);
        should(sourceMessages.messages).have.length(1);
        should(sourceMessages.sessionId).equal(SOURCE_ID);
        const sourceMessage = sourceMessages.messages[0];
        if (sourceMessage === undefined) throw new Error('source session did not return its one forkable message');
        should(sourceMessage.point).deepEqual(THROUGH);
        should(sourceMessage.text).equal(SOURCE_MESSAGE);

        const sourceAttachment = await client.upload(
          SOURCE_ID,
          new Blob([ATTACHMENT_BODY], { type: 'text/plain' }),
          ATTACHMENT_NAME,
        );
        const request: ForkSessionRequest = {
          through: THROUGH,
          selectionBinding: sourceMessage.selectionBinding,
          agent: TARGET_AGENT,
          model: TARGET_MODEL,
          effort: 'high',
        };

        const first = await client.fork(SOURCE_ID, request, REQUEST_ID);
        const createdTargetId = first.session.id;
        targetId = createdTargetId;
        should(createdTargetId).not.equal(SOURCE_ID);
        should(first.plan.source.sessionId).equal(SOURCE_ID);
        should(first.plan.source.cutMessagePoint).deepEqual(THROUGH);
        should(first.plan.target.agent).equal(TARGET_AGENT);
        should(first.plan.target.harness).equal('claude');
        should(first.plan.target.model).equal(TARGET_MODEL);
        should(first.plan.target.effort).equal('high');
        should(first.session.agent).equal(TARGET_AGENT);
        should(first.session.harness).equal('claude');
        should(first.session.model).equal(TARGET_MODEL);
        should(first.session.status).equal('running');

        const target = await client.get(createdTargetId);
        should(target.config.harness).equal('claude');
        should(target.config.transferredFrom?.cutMessagePoint).deepEqual(THROUGH);
        should(target.config.transferredFrom?.sourceHarness).equal('codex');
        should(target.config.transferredFrom?.planId).equal(first.plan.planId);
        should(target.state.status).equal('running');

        const persistedPlan = SessionTransferPlanSchema.parse(
          JSON.parse(
            await readFile(join(sessionDirectory(environment, createdTargetId), 'transfer-plan.json'), 'utf8'),
          ),
        );
        should(persistedPlan.planId).equal(first.plan.planId);
        should(persistedPlan.source.cutMessagePoint).deepEqual(THROUGH);
        should(persistedPlan.source.harness).equal('codex');

        const brief = await readFile(
          join(sessionDirectory(environment, createdTargetId), 'turns', 'turn-001.md'),
          'utf8',
        );
        should(brief).startWith('# Assigned task\n\n');
        should(brief).containEql(SOURCE_MESSAGE);
        should(brief).containEql(ATTACHMENT_NAME);
        should(persistedPlan.facets.attachments.attachments.map(attachment => attachment.id)).deepEqual([
          sourceAttachment.id,
        ]);
        const download = await client.request(
          `/v1/sessions/${encodeURIComponent(createdTargetId)}/attachments/${encodeURIComponent(sourceAttachment.id)}`,
          AttachmentDownloadSchema,
        );
        should(download.attachment).deepEqual(sourceAttachment);
        should(Buffer.from(download.base64, 'base64').toString('utf8')).equal(ATTACHMENT_BODY);

        const targetTranscript = target.config.transcript;
        if (targetTranscript === undefined) throw new Error('fork target did not mint its own transcript provenance');
        should(persistedPlan.source.transcriptProvenance?.identity).equal('correlated');
        should(targetTranscript.identity).equal('minted');
        should(targetTranscript.home).equal(targetHome);
        should(targetTranscript.harnessSessionId).not.equal(SOURCE_HARNESS_SESSION_ID);
        should(targetTranscript.file).not.equal(transcriptFile);

        const invocations = await environment.readFakeHarnessInvocations();
        should(invocations).have.length(1);
        should(invocations[0]).deepEqual({
          wrapper: TARGET_AGENT,
          argv: ['--model', TARGET_MODEL, '--session-id', targetTranscript.harnessSessionId],
          cwd: workspace,
        });
        should(await client.snapshot(createdTargetId)).containEql(TARGET_READY_MARKER);
        should((await client.attachTarget(createdTargetId)).paneId).equal('%0');

        const events = await client.history(createdTargetId);
        const eventTypes = events.map(event => event.type);
        const starting = eventTypes.indexOf('session.starting');
        const runtime = eventTypes.indexOf('control.runtime_model');
        const running = eventTypes.indexOf('session.running');
        should(starting).be.above(-1);
        should(runtime).be.above(starting);
        should(running).be.above(runtime);
        const runtimeEvents = events.filter(event => event.type === 'control.runtime_model');
        should(runtimeEvents).have.length(1);
        should(runtimeEvents[0]?.data).containDeep({
          harness: 'claude',
          requestedEffort: 'high',
        });
        should(JSON.stringify(events)).not.containEql('runtime_control_refused');

        const effects = await sessionEffects(environment, createdTargetId);
        should(effects.map(effect => [effect.effectId, effect.phase])).deepEqual([
          [`runtime:${first.plan.planId}:startup-runtime`, 'settled'],
          ['turn-1', 'settled'],
        ]);
        should(effects.filter(effect => effect.effectId === 'turn-1')).have.length(1);

        const stoppedForRestart = await environment.stopDaemon(10_000);
        daemonRunning = false;
        should(stoppedForRestart?.code).equal(0);
        await startCompiledDaemon(environment, executable);
        daemonRunning = true;
        client = await connect(environment);

        const replay = await client.fork(SOURCE_ID, request, REQUEST_ID);
        should(replay.session.id).equal(createdTargetId);
        should(replay).deepEqual(first);
        should(await sessionEffects(environment, createdTargetId)).deepEqual(effects);
        const replayEvents = await client.history(createdTargetId);
        should(replayEvents.filter(event => event.type === 'control.runtime_model')).have.length(1);
        should(JSON.stringify(replayEvents)).not.containEql('runtime_control_refused');
        should((await client.list()).map(session => session.config.id).sort()).deepEqual(
          [SOURCE_ID, createdTargetId].sort(),
        );
        should(await environment.readFakeHarnessInvocations()).have.length(1);

        const conflict = await client.fork(SOURCE_ID, { ...request, effort: 'medium' }, REQUEST_ID).then(
          () => undefined,
          error => error,
        );
        if (!(conflict instanceof FyHttpError)) throw new Error('changed fork replay did not return an HTTP refusal');
        should(conflict.status).equal(409);
        should(conflict.code).equal('request_id_reused');
        should((await client.list()).map(session => session.config.id).sort()).deepEqual(
          [SOURCE_ID, createdTargetId].sort(),
        );
        should(await environment.readFakeHarnessInvocations()).have.length(1);

        const stoppedTarget = await client.stop(createdTargetId, 'compiled fork E2E cleanup');
        should(stoppedTarget.state.status).equal('stopped');
        targetId = undefined;
        const stoppedDaemon = await environment.stopDaemon(10_000);
        daemonRunning = false;
        should(stoppedDaemon?.code).equal(0);
      } finally {
        if (targetId !== undefined && client !== undefined && daemonRunning) {
          await client.stop(targetId, 'compiled fork E2E failure cleanup').catch(() => undefined);
        }
        if (daemonRunning) await environment.stopDaemon(10_000).catch(() => undefined);
        await stopPrivateTmux(environment).catch(() => undefined);
      }
    });
  });
});
