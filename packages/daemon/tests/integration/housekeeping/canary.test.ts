/**
 * THE CANARY (docs/design/housekeeping-worker.md §2.4 rule 5): a login's token never leaves the job that
 * read it.
 *
 * Every store holds a known token, and every path runs on the REAL worker — a 200, a 401 that echoes the
 * token, a 200 whose body quotes it, a body that is not JSON, an HTML 403 quoting it, a read that times
 * out, material that is not JSON, a Mac's keychain that answers, one that is locked (exit 36) with and
 * without its fallback file. Whatever crossed between the threads in either direction, every answer, the
 * status heads and views the main thread built from them, the profile window, every console line, the
 * notices and the child's stderr are searched for the token in plain, base64, base64url and hex form,
 * and it must appear in none of them.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ClaudeStoreResolution,
  type CodexStoreResolution,
  CredentialStatusService,
  InMemoryCredentialStatusStore,
} from '@ferretry/fleet';
import { credentialFileStamp } from '@ferretry/fleet/adapters';
import should from 'should';
import {
  type HousekeepingWorker,
  InlineHousekeepingJobs,
  WorkerCredentialPorts,
  WorkerHousekeepingJobs,
} from '../../../src/adapters/housekeeping/index.ts';
import { bundledWorkerUrl } from '../../../src/adapters/runtime/bundled-worker.ts';
import type {
  HousekeepingJob,
  HousekeepingRequest,
  HousekeepingResponse,
  HousekeepingSettings,
} from '../../../src/lib/housekeeping/protocol.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';
import { runHousekeepingProcess } from '../support/housekeeping-process.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const CANARY = 'CANARY-5d1e7b-never-leave-the-worker-job';
const FORMS = [
  CANARY,
  Buffer.from(CANARY).toString('base64'),
  Buffer.from(CANARY).toString('base64url'),
  Buffer.from(CANARY).toString('hex'),
];
const NOW = Date.now();
const HOUR = 3_600_000;
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown): string => `${segment({ alg: 'none' })}.${segment(payload)}.${CANARY}`;
const claudeBlob = (): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: CANARY, refreshToken: CANARY, expiresAt: NOW + HOUR } });

/** How the stand-in usage endpoints answer. Every answer that can carry text carries the token. */
type Answer = 'ok' | 'unauthorized-echo' | 'body-echo' | 'not-json' | 'html-403' | 'slow';
const ANSWERS: readonly Answer[] = ['ok', 'unauthorized-echo', 'body-echo', 'not-json', 'html-403', 'slow'];

function serve(answer: Answer): { readonly origin: string; stop(): Promise<void> } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const echoed = request.headers.get('authorization') ?? '';
      const codex = new URL(request.url).pathname.includes('wham');
      const reading = codex
        ? { rate_limit: { primary_window: { used_percent: 9 } } }
        : { five_hour: { utilization: 9 } };
      switch (answer) {
        case 'ok':
          return Response.json(reading);
        case 'unauthorized-echo':
          return Response.json({ error: { message: `bad token ${echoed}` } }, { status: 401 });
        case 'body-echo':
          return Response.json({ ...reading, note: echoed, nested: { token: CANARY } });
        case 'not-json':
          return new Response(`{"five_hour": "${echoed}`, { headers: { 'content-type': 'application/json' } });
        case 'html-403':
          return new Response(`<html>${echoed}</html>`, { status: 403, headers: { 'content-type': 'text/html' } });
        case 'slow':
          await Bun.sleep(400);
          return Response.json(reading);
      }
    },
  });
  return { origin: `http://127.0.0.1:${String(server.port)}`, stop: async () => await server.stop(true) };
}

let root: string;
let work: ClaudeStoreResolution;
let mangled: ClaudeStoreResolution;
let codex: CodexStoreResolution;
let rollout: string;

const claudeAt = (id: string): ClaudeStoreResolution =>
  ({
    harness: 'claude',
    store: 'ferretry',
    secureStorage: join(root, 'credentials', id),
    credentialFile: join(root, 'credentials', id, '.credentials.json'),
  }) as ClaudeStoreResolution;

beforeAll(async () => {
  root = await tempDirectory('fyd-housekeeping-canary-');
  work = claudeAt('work');
  mangled = claudeAt('mangled');
  await mkdir(join(root, 'credentials', 'work'), { recursive: true });
  await mkdir(join(root, 'credentials', 'mangled'), { recursive: true });
  await writeFile(work.credentialFile, claudeBlob());
  await writeFile(mangled.credentialFile, `{"claudeAiOauth":{"accessToken":"${CANARY}"`);
  // A statusLine file that is not the schema — and quotes the token — reads as no reading at all.
  await writeFile(join(root, 'credentials', 'mangled', 'usage.json'), JSON.stringify({ version: 1, note: CANARY }));
  codex = { harness: 'codex', store: 'ferretry', canonicalFile: join(root, 'credentials', 'cx', 'auth.json') };
  await mkdir(join(root, 'credentials', 'cx'), { recursive: true });
  await writeFile(
    codex.canonicalFile,
    JSON.stringify({
      last_refresh: new Date(NOW).toISOString(),
      tokens: {
        access_token: jwt({ exp: (NOW + HOUR) / 1000 }),
        refresh_token: CANARY,
        account_id: CANARY,
        id_token: jwt({ email: 'team@example.com' }),
      },
    }),
  );
  rollout = join(root, 'rollout.jsonl');
  await writeFile(
    rollout,
    `${JSON.stringify({ type: 'response_item', payload: { text: CANARY } })}\n${JSON.stringify({
      timestamp: new Date(NOW).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 4, window_minutes: 300 } } },
    })}\n`,
  );
});

afterAll(async () => {
  await cleanupTempDirectories();
});

const settingsOf = (origin: string, overrides: Partial<HousekeepingSettings> = {}): HousekeepingSettings => ({
  type: 'settings',
  platform: 'linux',
  keychainAccount: 'person',
  defaultClaudeHome: join(root, 'default-claude'),
  fleetRoot: root,
  probeUrls: { anthropic: `${origin}/api/oauth/usage`, codex: `${origin}/backend-api/wham/usage` },
  usageTimeoutMs: 100,
  ...overrides,
});

const allJobs = (): HousekeepingJob[] => [
  { kind: 'credential.local', resolution: work },
  { kind: 'credential.active', resolution: work },
  { kind: 'credential.local', resolution: mangled },
  { kind: 'credential.active', resolution: mangled },
  { kind: 'credential.local', resolution: codex },
  { kind: 'credential.active', resolution: codex },
  { kind: 'usage.passive.claude', credential: 'work' },
  { kind: 'usage.passive.claude', credential: 'mangled' },
  { kind: 'usage.passive.codex', files: [rollout] },
];

/** The worker, with both directions of its traffic recorded as it crosses. */
function spiedSpawn(messages: unknown[]): () => HousekeepingWorker {
  return () => {
    const thread = new Worker(bundledWorkerUrl('housekeeping'), { type: 'module' });
    const spy: HousekeepingWorker = {
      onmessage: null,
      onerror: null,
      postMessage: (message: HousekeepingRequest) => {
        messages.push({ sent: message });
        thread.postMessage(message);
      },
      terminate: () => thread.terminate(),
    };
    thread.onmessage = (event: MessageEvent<HousekeepingResponse>) => {
      messages.push({ received: event.data });
      spy.onmessage?.(event);
    };
    thread.onerror = event => spy.onerror?.(event);
    return spy;
  };
}

function expectNoCanary(seen: string): void {
  for (const form of FORMS) should(seen.includes(form)).be.false(`the token leaked in the form ${form.slice(0, 12)}…`);
}

describe('the housekeeping worker never lets a token out of the job that read it', () => {
  for (const answer of ANSWERS) {
    it(`should keep every token in its job when the usage endpoint answers ${answer}`, async () => {
      // Arrange — the main thread's own path: kept facts, the status service, its heads, over the worker.
      const server = serve(answer);
      const messages: unknown[] = [];
      const consoled: string[] = [];
      const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
      const originals = levels.map(level => console[level]);
      for (const level of levels)
        console[level] = (...args: unknown[]) => void consoled.push(args.map(String).join(' '));
      const recorder = new PerformanceRecorder();
      const window = recorder.open(0);
      const settings = settingsOf(server.origin);
      const notices: string[] = [];
      const jobs = new WorkerHousekeepingJobs({
        settings,
        inline: new InlineHousekeepingJobs(settings),
        probe: recorder,
        activity: () => 'fleet refresh',
        idleMs: () => 1_000,
        retired: () => notices.push('retired'),
        spawn: spiedSpawn(messages),
      });
      const heads = new InMemoryCredentialStatusStore();
      const ports = new WorkerCredentialPorts({
        jobs,
        stamp: credentialFileStamp,
        keychain: false,
        keychainFreshMs: () => 60_000,
        now: Date.now,
        cache: new Map(),
      });
      const status = new CredentialStatusService({
        local: async (resolution, options) => await ports.local(resolution, options),
        // Each passive reading read straight through the worker, as a pass with no live watch reads it.
        passiveUsage: async subject =>
          (subject.resolution.harness === 'claude'
            ? await jobs.run({ kind: 'usage.passive.claude', credential: subject.id })
            : await jobs.run({ kind: 'usage.passive.codex', files: [rollout] })) ?? undefined,
        activeUsage: async resolution => await ports.activeUsage(resolution),
        refresh: { refresh: async () => ({ outcome: 'not_run' }) } as never,
        heads,
        now: Date.now,
        usageIntervalMs: 60_000,
      });
      const subjects = [
        { id: 'work', resolution: work },
        { id: 'mangled', resolution: mangled },
        { id: 'cx', resolution: codex },
      ];

      // Act
      let seen: string;
      try {
        const answers = [
          ...(await Promise.all(allJobs().map(async job => await jobs.run(job).catch(String)))),
          ...(await Promise.all(subjects.map(async subject => await status.observe(subject)))),
          ...(await Promise.all(subjects.map(async subject => await status.view(subject)))),
          ...(await Promise.all(subjects.map(async subject => await heads.read(subject.id)))),
        ];
        seen = JSON.stringify({ answers, messages, consoled, notices, tables: window.tables(60_000) });
      } finally {
        jobs.close();
        for (const [index, level] of levels.entries()) console[level] = originals[index] as never;
        await server.stop();
      }

      // Assert — the token is nowhere, and the work really happened: the threads talked, facts came back.
      expectNoCanary(seen);
      should(messages.length).be.above(allJobs().length);
      should(seen).match(/"fingerprint":"[0-9a-f]+"/);
      should(seen).match(/team@example\.com/);
    });
  }

  const keychains = {
    'a keychain that answers with the login': { script: `printf '%s' '${claudeBlob()}'`, file: false },
    'a locked keychain (exit 36) whose fallback file holds the login': { script: 'exit 36', file: true },
    'a locked keychain (exit 36) with no fallback file': { script: 'exit 36', file: false },
  } as const;
  for (const [name, keychain] of Object.entries(keychains)) {
    it(`should keep the token in its job on a Mac with ${name}`, async () => {
      // Arrange — a fake `security`, and a store whose fallback file is there only when the case says so.
      const server = serve('unauthorized-echo');
      const bin = await tempDirectory('fyd-housekeeping-canary-bin-');
      await writeFile(join(bin, 'security'), `#!/bin/sh\n${keychain.script}\n`);
      await chmod(join(bin, 'security'), 0o755);
      const store = await tempDirectory('fyd-housekeeping-canary-mac-');
      const resolution = {
        harness: 'claude',
        store: 'ferretry',
        secureStorage: store,
        credentialFile: join(store, '.credentials.json'),
      } as ClaudeStoreResolution;
      if (keychain.file) await writeFile(resolution.credentialFile, claudeBlob());

      // Act
      let run: Awaited<ReturnType<typeof runHousekeepingProcess>>;
      try {
        run = await runHousekeepingProcess(
          {
            settings: settingsOf(server.origin, { platform: 'darwin' }),
            jobs: [
              { kind: 'credential.local', resolution },
              { kind: 'credential.active', resolution },
            ],
            activity: 'fleet refresh',
          },
          bin,
        );
      } finally {
        await server.stop();
      }

      // Assert — the keychain was really asked, and nothing it said got out.
      expectNoCanary(JSON.stringify(run));
      should(run.tables.workers[0]?.work?.childProcesses[0]?.command).equal('security find-generic-password');
    });
  }
});
