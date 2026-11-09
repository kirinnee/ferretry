import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DigestsFileSchema,
  DismissedFileSchema,
  GLOBAL_LESSONS_DOCUMENT,
  GlobalDocumentSchema,
  LessonsFileSchema,
  LessonsStateFileSchema,
  ObservationSchema,
  PatchFileSchema,
  RunManifestSchema,
  SuggestedFileSchema,
} from '@ferretry/plugin-lessons/contract';
import { link, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { STEPS } from '../../src/steps/index.ts';
import {
  lessonsStep,
  V5_LESSONS_DISMISSED,
  V5_LESSONS_GLOBAL,
  V5_LESSONS_OBSERVATIONS,
  V5_LESSONS_STATE,
  V5_LESSONS_SUGGESTED,
  v5LessonsDigests,
  v5LessonsPatch,
  v5LessonsRun,
} from '../../src/steps/lessons.ts';
import { AT, fixture, RUNTIME } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const LATER = '2026-11-02T00:00:00.000Z';
const V4_GLOBAL_PATH = '/fake/v4/fleet/assets/instructions/lessons.md';

/** A file as the v5 kernel reads it: `format` must be the FIRST key and exactly 1; the rest is the schema's body. */
async function document<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  const value = JSON.parse(await readFile(join(f.to, path), 'utf8')) as Record<string, unknown>;
  expect(Object.keys(value)[0]).toBe('format');
  const { format, ...body } = value;
  expect(format).toBe(1);
  return schema.parse(body);
}

async function lines(path: string) {
  const text = await readFile(join(f.to, path), 'utf8');
  return text
    .trimEnd()
    .split('\n')
    .map(line => {
      const value = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(value)[0]).toBe('format');
      const { format, ...body } = value;
      expect(format).toBe(1);
      return ObservationSchema.parse(body);
    });
}

async function putText(path: string, text: string): Promise<void> {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
}

const observation = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  sessionId: 'f1',
  mode: 'interactive',
  cwd: '/work/project',
  repo: '/work/project',
  at: AT,
  kind: 'correction',
  gist: 'fake gist',
  quote: 'fake owner quote',
  source: 'human',
  verified: true,
  runId: 'passive',
  ...extra,
});

const proposal = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  category: 'repo',
  state: 'pending',
  title: `Fake rule ${id}`,
  ruleText: `Fake rule ${id}.`,
  target: { kind: 'repo-instructions', path: '/work/project' },
  observationIds: ['o1'],
  occurrences: 1,
  crossRepoCount: 1,
  firstSeen: AT,
  lastSeen: AT,
  identity: `identity-${id}`,
  history: [{ at: AT, event: 'suggested', by: 'ferret' }],
  source: 'passive',
  project: '/work/project',
  suggestedCategory: 'repo',
  count: 1,
  ...extra,
});

const manifest = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId,
  startedAt: AT,
  sessionsScanned: 3,
  sessionsWithSignal: 2,
  minerSessions: ['miner1'],
  observationsProposed: 4,
  observationsVerified: 3,
  rejectedQuotes: 1,
  malformedFiles: 0,
  proposalsCreated: 2,
  proposalsStrengthened: 1,
  proposalsSuppressedByTombstone: 0,
  perHarness: { claude: 2, codex: 1 },
  ...extra,
});

const digest = (sessionId: string) => ({
  sessionId,
  mode: 'auto',
  cwd: '/work/project',
  repo: '/work/project',
  harness: 'claude',
  at: AT,
  hasSignal: true,
  signalReasons: ['correction'],
  corpus: 'fake corpus',
  digest: 'fake digest',
  humanMessages: 2,
  teammateSteers: 0,
  interrupts: 0,
  toolFailures: 0,
});

test('the step is registered in the table, no longer pending, in the same place', () => {
  const index = STEPS.findIndex(step => step.id === 'lessons');
  expect(STEPS[index]).toBe(lessonsStep);
  expect(STEPS[index - 1]?.id).toBe('projects');
  expect(STEPS[index + 1]?.id).toBe('usage');
});

test('a home with no learning files converts and writes nothing', async () => {
  const report = await lessonsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toBeUndefined();
  await expect(readdir(f.to)).rejects.toThrow();
});

describe('a full v4 learning home', () => {
  beforeEach(async () => {
    await f.put('state/learning/state.json', {
      watermarkAt: AT,
      watermarkId: 'f1',
      lastRunAt: AT,
      lastRunId: 'run-1',
      scan: {
        runId: 'scan-1',
        state: 'finished',
        sessionIds: ['f1', 'f2'],
        batches: [{ minerSessionId: 'miner1', sessionIds: ['f1', 'f2'] }, { sessionIds: [] }],
        startedAt: AT,
        finishedAt: LATER,
        done: 2,
        added: 1,
        merged: 0,
      },
    });
    await f.put('state/learning/sessions.json', [
      { sessionId: 'f1', passive: true, since: AT, setBy: 'default' },
      { sessionId: 'f2', passive: false, since: LATER, setBy: 'owner' },
    ]);
    await putText(
      'state/learning/observations.jsonl',
      [
        JSON.stringify(observation('o1')),
        JSON.stringify(observation('o2', { sessionId: 'f2', teammate: 'arleen', turn: 3, kind: 'suggestion' })),
        '',
      ].join('\n'),
    );
    await f.put('state/learning/proposals.json', [
      proposal('p1'),
      proposal('p2', {
        category: 'global',
        state: 'applied',
        target: { kind: 'global-instructions', path: 'instructions/lessons.md' },
        project: undefined,
        applied: { at: LATER, path: V4_GLOBAL_PATH },
        history: [
          { at: AT, event: 'suggested', by: 'ferret' },
          { at: LATER, event: 'applied', by: 'user', note: V4_GLOBAL_PATH },
        ],
      }),
      // Written before passive lessons: no `source`, no `count` — v4 read it as a scan's, seen once per evidence.
      (({ source: _s, count: _c, ...rest }) => ({
        ...rest,
        state: 'rejected',
        observationIds: ['o1', 'o2'],
        target: { kind: 'global-agent-guidance', path: 'guidance.md', anchor: '## Agent rules' },
      }))(proposal('p3')),
    ]);
    await f.put('state/learning/tombstones.json', [
      { identity: 'identity-p3', titleHash: 'fakehash', ruleGist: 'fake gist', rejectedAt: LATER, note: 'no' },
    ]);
    await f.put('state/learning/runs/run-1/manifest.json', manifest('run-1', { finishedAt: LATER }));
    await f.put('state/learning/runs/run-1/digests.json', [digest('f1')]);
    await f.put('state/learning/runs/run-1/observations.json', { observations: [] });
    await f.put('state/learning/runs/run-2/manifest.json', manifest('run-2'));
    await f.put('state/learning/runs/run-2/digests.json', [digest('f1'), digest('f2')]);
    await putText('state/learning/patches/fake-rule-p1-2026-11-01T00-00-00-000Z.md', '# fake patch\n');
    await putText('fleet/assets/instructions/lessons.md', '## Lessons\n\n- Fake global rule one.\n- Fake two.\n');
    await putText(
      'config/learning.yaml',
      '# yaml-language-server: $schema=../.schema/learning.json\n# the owner keeps this short\nenabled: false\nagent: old-name # the miner\nmaxSessionsPerRun: 12\npassiveDefault: false\n',
    );
    await f.put('fleet/ids.json', {
      version: 1,
      runtimes: { 'claude-work': { id: RUNTIME, formerNames: ['old-name'] } },
    });
  });

  test('every file lands in its v5 place, parsed by the v5 contract, format first', async () => {
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.kept).toEqual([
      { what: 'learning state (watermark, newest scan)', count: 1 },
      { what: 'per-ferret lesson switches', count: 2 },
      { what: 'evidence observations', count: 2 },
      { what: 'pending lessons', count: 1 },
      { what: 'accepted lessons', count: 0 },
      { what: 'applied lessons', count: 1 },
      { what: 'rejected lessons', count: 1 },
      { what: 'dismissed lessons (never suggested again)', count: 1 },
      { what: 'scan run manifests', count: 2 },
      { what: 'digests of unfinished runs', count: 1 },
      { what: 'lesson patches', count: 1 },
      { what: 'Global lessons document', count: 1 },
      { what: 'Global lesson rules', count: 2 },
      { what: 'lessons.yaml settings', count: 4 },
    ]);
    expect(report.note).toBe('1 raw miner output file(s) not carried');

    const state = await document(V5_LESSONS_STATE, LessonsStateFileSchema);
    expect(state).toEqual({
      watermarkAt: AT,
      watermarkId: 'f1',
      lastRunAt: AT,
      lastRunId: 'run-1',
      scan: {
        runId: 'scan-1',
        state: 'finished',
        ferretIds: ['f1', 'f2'],
        batches: [{ minerFerretId: 'miner1', ferretIds: ['f1', 'f2'] }, { ferretIds: [] }],
        startedAt: AT,
        finishedAt: LATER,
        done: 2,
        added: 1,
        merged: 0,
      },
      ferrets: [
        { ferretId: 'f1', passive: true, since: AT, setBy: 'default' },
        { ferretId: 'f2', passive: false, since: LATER, setBy: 'owner' },
      ],
    });

    const evidence = await lines(V5_LESSONS_OBSERVATIONS);
    expect(evidence.map(line => [line.id, line.ferretId, line.turn])).toEqual([
      ['o1', 'f1', undefined],
      ['o2', 'f2', 3],
    ]);
    expect(JSON.stringify(evidence)).not.toContain('sessionId');

    const { proposals } = await document(V5_LESSONS_SUGGESTED, SuggestedFileSchema);
    expect(proposals.map(entry => entry.id)).toEqual(['p1', 'p2', 'p3']);
    expect(proposals[0]).toEqual(proposal('p1') as never);
    const global = proposals[1];
    expect(global?.target).toEqual({ kind: 'global-instructions', path: GLOBAL_LESSONS_DOCUMENT });
    expect(global?.applied).toEqual({ at: LATER, path: GLOBAL_LESSONS_DOCUMENT });
    expect(global?.history.at(-1)).toEqual({ at: LATER, event: 'applied', by: 'user', note: GLOBAL_LESSONS_DOCUMENT });
    // v4's read-time defaults are made explicit: a scan's lesson, counted once per piece of evidence.
    expect(proposals[2]).toMatchObject({ state: 'rejected', source: 'scan', count: 2 });
    expect(proposals[2]?.target).toEqual({
      kind: 'global-agent-guidance',
      path: 'guidance.md',
      anchor: '## Agent rules',
    });

    const { tombstones } = await document(V5_LESSONS_DISMISSED, DismissedFileSchema);
    expect(tombstones).toEqual([
      { identity: 'identity-p3', titleHash: 'fakehash', ruleGist: 'fake gist', rejectedAt: LATER, note: 'no' },
    ]);

    const finished = await document(v5LessonsRun('run-1'), RunManifestSchema);
    expect(finished).toMatchObject({
      runId: 'run-1',
      finishedAt: LATER,
      ferretsScanned: 3,
      ferretsWithSignal: 2,
      minerFerrets: ['miner1'],
      perHarness: { 'claude-code': 2, codex: 1 },
    });
    expect(Object.keys(finished)).not.toContain('sessionsScanned');
    await document(v5LessonsRun('run-2'), RunManifestSchema);
    const { digests } = await document(v5LessonsDigests('run-2'), DigestsFileSchema);
    expect(digests.map(entry => entry.ferretId)).toEqual(['f1', 'f2']);
    await expect(readFile(join(f.to, v5LessonsDigests('run-1')))).rejects.toThrow();

    const patch = await document(v5LessonsPatch('fake-rule-p1-2026-11-01T00-00-00-000Z'), PatchFileSchema);
    expect(patch.contents).toBe('# fake patch\n');

    const doc = await document(V5_LESSONS_GLOBAL, GlobalDocumentSchema);
    expect(doc.text).toBe('## Lessons\n\n- Fake global rule one.\n- Fake two.\n');
  });

  test('learning.yaml becomes lessons.yaml: renamed key, current runtime name, comments kept, modeline dropped', async () => {
    expect((await lessonsStep.run(f.ctx())).status).toBe('converted');
    const text = await readFile(join(f.to, 'config/lessons.yaml'), 'utf8');
    expect(text).not.toContain('yaml-language-server');
    expect(text).toContain('# the owner keeps this short');
    expect(text).toContain('# the miner');
    const value = LessonsFileSchema.parse(parseDocument(text).toJS());
    expect(value).toEqual({ enabled: false, agent: 'claude-work', maxFerretsPerRun: 12, passiveDefault: false });
  });

  test('every v5 file is owner-only', async () => {
    await lessonsStep.run(f.ctx());
    for (const path of [V5_LESSONS_STATE, V5_LESSONS_OBSERVATIONS, V5_LESSONS_SUGGESTED, V5_LESSONS_GLOBAL]) {
      const { mode } = await Bun.file(join(f.to, path)).stat();
      expect(mode & 0o777).toBe(0o600);
    }
  });

  test('a dry run reports the same and writes nothing', async () => {
    const report = await lessonsStep.run(f.ctx(true));
    expect(report.status).toBe('converted');
    expect(report.kept).toContainEqual({ what: 'evidence observations', count: 2 });
    expect(report.note).toContain('dry run: nothing written');
    await expect(readdir(f.to)).rejects.toThrow();
  });
});

describe('damage is read the way v4 read it, counted and never quoted', () => {
  const SECRET = 'fake-owner-words-never-in-a-report';

  test('a bad record or line costs that record alone', async () => {
    await putText(
      'state/learning/observations.jsonl',
      `${JSON.stringify(observation('o1'))}\n{not json ${SECRET}\n${JSON.stringify({ id: SECRET })}\n`,
    );
    await f.put('state/learning/proposals.json', [proposal('p1'), { id: 'p2', title: SECRET }]);
    await f.put('state/learning/sessions.json', [{ sessionId: 'f1', passive: 'yes', note: SECRET }]);
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.kept).toContainEqual({ what: 'evidence observations', count: 1 });
    expect(report.kept).toContainEqual({ what: 'pending lessons', count: 1 });
    expect(report.kept).toContainEqual({ what: 'per-ferret lesson switches', count: 0 });
    expect(report.note).toContain('state/learning/observations.jsonl: 2 damaged evidence line(s) not carried');
    expect(report.note).toContain('state/learning/proposals.json: 1 damaged lesson(s) not carried');
    expect(report.note).toContain('state/learning/sessions.json: 1 damaged switch record(s) not carried');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  test('an unparsable document is read as empty, as v4 did', async () => {
    await putText('state/learning/proposals.json', `[{"id": "${SECRET}"`);
    await putText('state/learning/state.json', SECRET);
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect((await document(V5_LESSONS_SUGGESTED, SuggestedFileSchema)).proposals).toEqual([]);
    expect(await document(V5_LESSONS_STATE, LessonsStateFileSchema)).toEqual({ ferrets: [] });
    expect(report.note).toContain('state/learning/proposals.json is damaged');
    expect(report.note).toContain('state/learning/state.json is damaged');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  test('a damaged manifest is no run; an unsafe run name or a stray file is left behind', async () => {
    await putText('state/learning/runs/run-1/manifest.json', SECRET);
    await f.put('state/learning/runs/.hidden/manifest.json', manifest('.hidden'));
    await putText('state/learning/runs/run-3/notes.txt', SECRET);
    await f.put('state/learning/runs/run-3/manifest.json', manifest('run-3', { finishedAt: LATER }));
    await putText('state/learning/patches/notes.txt', SECRET);
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.kept).toContainEqual({ what: 'scan run manifests', count: 1 });
    expect(report.kept).toContainEqual({ what: 'lesson patches', count: 0 });
    expect(report.note).toContain('1 damaged run manifest(s) or digest file(s) not carried');
    expect(report.note).toContain('2 file(s) under state/learning/runs v4 never read');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  test('a link in place of a learning file fails the step by name', async () => {
    await putText('elsewhere.json', JSON.stringify([proposal('p1')]));
    await mkdir(join(f.from, 'state/learning'), { recursive: true });
    await symlink(join(f.from, 'elsewhere.json'), join(f.from, 'state/learning/proposals.json'));
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe('state/learning/proposals.json: is not a regular file');
  });

  test('n2 a hard-linked Global lessons document fails as "a hard link (v4 refused it)", key unread', async () => {
    await putText('state/daemon-identity.json', `FAKE-KEY-${SECRET}`);
    await mkdir(join(f.from, 'fleet/assets/instructions'), { recursive: true });
    await link(join(f.from, 'state/daemon-identity.json'), join(f.from, 'fleet/assets/instructions/lessons.md'));
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toContain('a hard link (v4 refused it)');
    expect(JSON.stringify(report)).not.toContain('FAKE-KEY');
  });

  test('an unknown learning.yaml key fails by key, never by value', async () => {
    await putText('config/learning.yaml', `enabled: true\nmaxSessions: ${SECRET}\n`);
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe('config/learning.yaml: maxSessions is not a v4 learning setting');
  });

  test('a learning.yaml value v5 refuses fails naming the key path', async () => {
    await putText('config/learning.yaml', 'intervalMinutes: 0\n');
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toContain('config/learning.yaml: v5 refuses it as config/lessons.yaml: intervalMinutes');
  });
});

describe('the Global lessons document', () => {
  test('is read from the file the lessons component names', async () => {
    await putText('config/components/instructions/lessons.yaml', 'file: instructions/team-rules.md\n');
    await putText('fleet/assets/instructions/team-rules.md', '- Fake team rule.\n');
    await putText('fleet/assets/instructions/lessons.md', '- Not this one.\n');
    expect((await lessonsStep.run(f.ctx())).status).toBe('converted');
    expect((await document(V5_LESSONS_GLOBAL, GlobalDocumentSchema)).text).toBe('- Fake team rule.\n');
  });

  test('a component whose document does not exist yet is no document (v4 read it as empty)', async () => {
    await putText('config/components/instructions/lessons.yaml', 'file: instructions/lessons.md\n');
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('converted');
    await expect(readFile(join(f.to, V5_LESSONS_GLOBAL))).rejects.toThrow();
  });

  test('a component pointing outside fleet/assets fails with the remedy, and nothing outside the home is read', async () => {
    await putText('config/components/instructions/lessons.yaml', 'file: /fake/outside/lessons.md\n');
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toStartWith(
      'config/components/instructions/lessons.yaml: the Global lessons document it names',
    );
    expect(report.note).toContain('fleet/assets/instructions/lessons.md');
  });

  test('a link out of the asset tree is never followed', async () => {
    await putText('outside.md', '- fake outside rule\n');
    await mkdir(join(f.from, 'fleet/assets/instructions'), { recursive: true });
    await symlink(join(f.from, 'outside.md'), join(f.from, 'fleet/assets/instructions/lessons.md'));
    const report = await lessonsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    await expect(readFile(join(f.to, V5_LESSONS_GLOBAL))).rejects.toThrow();
  });
});
