import { describe, expect, test } from 'bun:test';
import type { StateFileDef } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { StateAgentPinRepository } from '../../daemon/adapters/agent-pins/index.ts';
import { StatePinRepository } from '../../daemon/adapters/pins/file-pin-repository.ts';
import { parseSessionId } from '../../daemon/lib/session-id.ts';
import {
  AgentPinsDocumentSchema,
  AgentPinsFile,
  FerretConfigDocumentSchema,
  FerretConfigFile,
  FerretDetailsFile,
  FerretDetailsSchema,
  FerretPinsDocumentSchema,
  FerretPinsFile,
  FerretStateDocumentSchema,
  FerretStateFile,
} from '../../contract/index.ts';
import { memoryStorage, sessionConfig, sessionState, T0 } from '../support/daemon/storage.ts';

/**
 * The five per-ferret files the converter writes (config, state, pins, agent pins, details): each is STRICT (an unknown
 * key is refused, never stripped), starts at format 1, and reads through the daemon's own reader. The key lists are
 * pinned here so a key can neither appear nor vanish without this test — and the converter's key list — changing.
 */

const ID = parseSessionId('20260806-zelda');
const HASH = 'a'.repeat(64);
const FILES = [
  ['config', FerretConfigFile],
  ['state', FerretStateFile],
  ['pins', FerretPinsFile],
  ['agent-pins', AgentPinsFile],
  ['details', FerretDetailsFile],
] as const;

const keysOf = (schema: { readonly shape: Record<string, unknown> }): string[] => Object.keys(schema.shape).sort();

describe('the per-ferret file definitions', () => {
  test.each(FILES)('%s is format 1 and a json file', (_name, file) => {
    expect(file.format).toBe(1);
    expect(file.store).toBe('json');
  });

  test.each(FILES)(
    '%s reads a document with no format as damage, and a newer format as damage',
    async (_name, file) => {
      const def = file as StateFileDef;
      const folder = new MemoryStateFolder();
      const port = folder.port([def]);
      const name = def.path.includes('*') ? 'f1' : undefined;
      folder.plant(def, JSON.stringify({ pins: [] }), name);
      expect((await port.read(def, name)).ok).toBe(false);
      folder.plant(def, JSON.stringify({ format: 2, pins: [] }), name);
      expect((await port.read(def, name)).ok).toBe(false);
    },
  );

  test('config carries the lifecycle keys and the renamed capability hash, and nothing of the old name', () => {
    const keys = keysOf(FerretConfigDocumentSchema);
    for (const key of ['command', 'prompt', 'tmuxSession', 'capabilityHash']) expect(keys).toContain(key);
    expect(keys).not.toContain('sessionCapabilityHash');
  });

  test('FINAL KEY LIST config.json', () => {
    expect(keysOf(FerretConfigDocumentSchema)).toEqual(
      [
        'id',
        'incarnation',
        'runtimeGeneration',
        'name',
        'nameSource',
        'teammate',
        'label',
        'parent',
        'credentialRevoked',
        'projectId',
        'focusTask',
        'focusAnchor',
        'boardSkip',
        'provenance',
        'agent',
        'harness',
        'modelHint',
        'model',
        'launchReasoningEffort',
        'launchFast',
        'launchSettings',
        'mode',
        'remoteControl',
        'harnessFlags',
        'cwd',
        'createdAt',
        'updatedAt',
        'turn',
        'intervalSeconds',
        'timeoutSeconds',
        'nudgeAfterSeconds',
        'killAfterSeconds',
        'directSendMaxChars',
        'resumeMenuChoice',
        'maxSnapshots',
        'move',
        'moves',
        'transferredFrom',
        'conversion',
        'transcript',
        'retry',
        'hypermedia',
        'pack',
        'agenda',
        'compactAt',
        'command',
        'prompt',
        'tmuxSession',
        'capabilityHash',
      ].sort(),
    );
  });

  test('FINAL KEY LIST state.json', () => {
    expect(keysOf(FerretStateDocumentSchema)).toEqual(
      [
        'id',
        'status',
        'turn',
        'pid',
        'startedAt',
        'finishedAt',
        'lastActivityAt',
        'lastSnapshotAt',
        'lastDiffAt',
        'exitCode',
        'reason',
        'health',
        'promptReady',
        'remoteControlUrl',
        'openTools',
        'pendingQuestion',
        'lastAnsweredQuestionToolUseId',
        'lastTranscriptAt',
        'lastPaneAt',
        'lastCounterAdvanceAt',
        'lastTokenAdvanceAt',
        'lastSubprocessAt',
        'subprocessSince',
        'nudgedAt',
        'needsHuman',
        'needsHumanKind',
        'agenda',
        'contextPercent',
        'contextTokens',
        'contextAt',
        'contextWindow',
        'usage5hPercent',
        'usageWeeklyPercent',
        'usage5hResetAt',
        'usageWeeklyResetAt',
        'usageAtLimit',
        'usageAuthOk',
        'launchedAt',
        'harnessStartupMs',
        'harnessNotReadyAfterMs',
        'launchInstructions',
        'observedModel',
        'observedModelAt',
        'observedReasoningEffort',
        'observedFast',
        'activity',
        'lastToolStartedAt',
        'quota',
        'retryAttempt',
        'turnCompleted',
        'turnState',
        'turnStateAt',
        'turnPrompt',
        'permissionRequest',
        'harnessDialog',
        'waiting',
        'waitingCreditSeconds',
      ].sort(),
    );
  });

  test('FINAL KEY LIST pins.json, agent-pins.json and details.json', () => {
    expect(keysOf(FerretPinsDocumentSchema)).toEqual(['pins']);
    expect(keysOf(AgentPinsDocumentSchema)).toEqual(['pins']);
    expect(keysOf(FerretDetailsSchema)).toEqual(['options', 'title']);
  });
});

describe('every body is strict: an unknown key is refused', () => {
  const config = sessionConfig(ID, { command: ['/fleet/bin/claude-auto-atomi'], tmuxSession: 'fy-zelda' });
  const state = sessionState(ID);

  test.each([
    ['config', FerretConfigDocumentSchema, config],
    ['state', FerretStateDocumentSchema, state],
    ['pins', FerretPinsDocumentSchema, { pins: [] }],
    ['agent-pins', AgentPinsDocumentSchema, { pins: [] }],
    ['details', FerretDetailsSchema, { title: 'Port it' }],
  ] as const)('%s', (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, surprise: 1 }).success).toBe(false);
  });

  test('the old name of the capability hash is an unknown key', () => {
    expect(FerretConfigDocumentSchema.safeParse({ ...config, sessionCapabilityHash: HASH }).success).toBe(false);
    expect(FerretConfigDocumentSchema.safeParse({ ...config, capabilityHash: HASH }).success).toBe(true);
  });

  test('the state port reads a config or state with an unknown key as damaged, never as stripped', async () => {
    const { storage, folder } = await memoryStorage();
    folder.plant(FerretConfigFile, JSON.stringify({ format: 1, ...config, surprise: 1 }), ID);
    folder.plant(FerretStateFile, JSON.stringify({ format: 1, ...state, surprise: 1 }), ID);
    await expect(storage.readConfig(ID)).rejects.toThrow();
    await expect(storage.readState(ID)).rejects.toThrow();
  });
});

describe('every file round-trips through the daemon’s reader', () => {
  test('config and state, with every lifecycle key', async () => {
    const { storage, folder } = await memoryStorage();
    const config = sessionConfig(ID, {
      command: ['/fleet/bin/claude-auto-atomi', '--flag'],
      prompt: 'port the thing',
      tmuxSession: 'fy-zelda',
      capabilityHash: HASH,
    });
    await storage.writeConfig(ID, config);
    await storage.writeState(ID, sessionState(ID, { status: 'running', pid: 42, startedAt: T0 }));
    expect(await storage.readConfig(ID)).toEqual(config as never);
    expect(await storage.readState(ID)).toEqual(
      sessionState(ID, { status: 'running', pid: 42, startedAt: T0 }) as never,
    );
    expect(JSON.parse(folder.raw(FerretConfigFile, ID) ?? '{}')).toMatchObject({ format: 1, capabilityHash: HASH });
  });

  test('pins', async () => {
    const folder = new MemoryStateFolder();
    const repository = new StatePinRepository(folder.port([FerretPinsFile]), FerretPinsFile, { now: () => T0 });
    const pin = {
      id: crypto.randomUUID(),
      at: 1,
      kind: 'note',
      text: 'remember',
      by: 'human',
      createdBy: null,
      createdByName: null,
    };
    await repository.mutate('f1', () => [pin as never]);
    expect((await repository.snapshot('f1')).pins).toEqual([pin as never]);
    expect(JSON.parse(folder.raw(FerretPinsFile, 'f1') ?? '{}').format).toBe(1);
  });

  test('agent pins', async () => {
    const folder = new MemoryStateFolder();
    const repository = new StateAgentPinRepository(folder.port([AgentPinsFile]), AgentPinsFile);
    const pins = [{ sessionId: ID, pinnedAt: T0 }];
    await repository.save(pins);
    expect(await repository.load()).toEqual(pins);
    expect(JSON.parse(folder.raw(AgentPinsFile) ?? '{}')).toEqual({ format: 1, pins });
  });

  test('details', async () => {
    const folder = new MemoryStateFolder();
    const port = folder.port([FerretDetailsFile]);
    const details = { title: 'Port the converter exports', options: { model: 'opus' } };
    await port.write(FerretDetailsFile, details, 'f1');
    const read = await port.read(FerretDetailsFile, 'f1');
    expect(read.ok && read.value).toEqual(details);
  });
});
