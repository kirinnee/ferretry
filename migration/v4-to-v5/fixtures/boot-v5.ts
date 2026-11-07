/**
 * Boots v5 on the CONVERTED fixture home and proves it took the home whole (CI-only, like the fixture builder: it
 * starts a daemon, and the daemon may start a tmux server).
 *
 * 1. Starts this repository's v5 `fyd` from source on the converter's real output (`FY_HOME=<home> bun …/fyd.ts --port
 *    0`), with a disposable `HOME`, and waits for its "ready" line and a 200 from `/healthz`. The home must be complete
 *    (report `complete: true`, `home.json` written) and carry the tree v5 makes for a new home (`config`, `state`,
 *    `state/kernel`, `run`, `logs`): v5 makes it only for a NEW home, and without `logs/` it writes no log at all.
 * 2. Proves every plugin came up. The kernel says a plugin is down in four places, all read here: the doctor lines `fyd`
 *    prints before "ready" (a refused state file is named `state/<plugin>/<file>`; a plugin that failed, was refused or
 *    needs one that is down is named by its title), `GET /v1/plugins` (`on: false`), `logs/fyd.log` (a plugin that
 *    failed to build, a file refused when first read, a folder in an older format MOVED ASIDE so the plugin starts
 *    empty) and any `state/<id>-before-*` folder left behind. Every down plugin fails the run: it is a converter bug.
 * 3. Proves the data is there through v5's own HTTP routes, with the admin token the home carries (read from the file,
 *    sent only to the daemon this script started, never printed): the ferrets, projects, board cards and agenda items
 *    `made.json` records, by id, with the names, lanes, dependencies and states it records. While v5's Gate is still a
 *    skeleton, every authenticated route answers `503 admission_unavailable`: the inventory and data checks are then
 *    skipped with a warning, and run by themselves once Gate lands.
 * 4. Stops the daemon with SIGTERM and kills the tmux server on the home's own socket.
 *
 * Imports product code only through `@ferretry/<x>/contract`; runs the product's daemon as a process.
 *
 *   bun boot-v5.ts --fixture <FIXTURE_OUT>     (reads made.json, report.json, v5/; writes boot/)
 */
import { FerretSummarySchema } from '@ferretry/core-ferrets/contract';
import { DAEMON_RUN_FILE, DaemonRunSchema } from '@ferretry/kernel/contract';
import { CardResponseSchema } from '@ferretry/plugin-board/contract';
import { ProjectListSchema } from '@ferretry/plugin-projects/contract';
import { spawn, type Subprocess } from 'bun';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const REPO = resolve(import.meta.dir, '../../..');
const FYD = join(REPO, 'packages/core/kernel/host/fyd.ts');
const READY_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 30_000;

const { values } = parseArgs({ options: { fixture: { type: 'string' } } });
if (values.fixture === undefined) {
  process.stderr.write('usage: bun boot-v5.ts --fixture <FIXTURE_OUT>\n');
  process.exit(64);
}
const fixture = resolve(values.fixture);
const bootDir = join(fixture, 'boot');

/** Ends the boot proof early; the error that caused it is already recorded. */
class BootStop extends Error {}

class RouteError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly said: string,
  ) {
    super(`GET ${path} answered ${String(status)}: ${said}`);
  }
}

// ─── what the run found ──────────────────────────────────────────────────────────────────────────────────────────

const errors: string[] = [];
const warnings: string[] = [];
const fail = (line: string): void => {
  errors.push(line);
  process.stdout.write(`::error title=boot v5::${line}\n`);
};
const warn = (line: string): void => {
  warnings.push(line);
  process.stdout.write(`::warning title=boot v5::${line}\n`);
};
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

interface DownPlugin {
  readonly plugin: string;
  readonly why: string;
  readonly file?: string;
  /** The plugin it needs, which is not running: it is down only because that one is. */
  readonly blockedBy?: string;
}
const down: DownPlugin[] = [];
/** A plugin's id from the title a doctor line names it by (`Board` → `board`, `MCP` → `mcp`). */
const idOf = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');

// ─── inputs: made.json and the conversion report ─────────────────────────────────────────────────────────────────

const MadeFerret = z.object({
  role: z.string(),
  id: z.string(),
  name: z.string(),
  mode: z.enum(['auto', 'interactive']),
  requestedParent: z.string().nullable(),
  state: z.enum(['running', 'ended']),
});
const Made = z.object({
  ferrets: z.array(MadeFerret),
  project: z.object({ name: z.string(), path: z.string(), id: z.string().nullable() }).optional(),
  cards: z
    .array(
      z.object({
        id: z.string(),
        lane: z.string(),
        dependsOn: z.string().optional(),
      }),
    )
    .optional(),
  agenda: z.array(z.object({ id: z.string(), state: z.enum(['answered', 'open']) })).optional(),
});
type Made = z.infer<typeof Made>;

const Report = z.object({
  complete: z.boolean(),
  steps: z.array(z.object({ id: z.string(), status: z.string() })),
});

const made: Made = Made.parse(JSON.parse(await readFile(join(fixture, 'made.json'), 'utf8')));
const report = Report.parse(JSON.parse(await readFile(join(fixture, 'report.json'), 'utf8')));
const home = join(fixture, 'v5');

// ─── the home: the converter's real output, complete ─────────────────────────────────────────────────────────────

if (!report.complete) {
  const open = report.steps.filter(step => step.status !== 'converted' && step.status !== 'not-carried');
  fail(
    `the conversion is not complete (${open.map(step => `${step.id}: ${step.status}`).join(', ') || 'no step named'}): there is no home to boot`,
  );
  process.exit(1);
}
if (!existsSync(join(home, 'home.json'))) {
  fail('the report says complete, but the converted home has no home.json');
  process.exit(1);
}
// The tree `openHome` makes for a NEW home (packages/core/kernel/host/home.ts); on an existing home v5 assumes it.
const missingFolders = ['config', 'state', 'state/kernel', 'run', 'logs'].filter(
  folder => !existsSync(join(home, folder)),
);
for (const folder of missingFolders)
  fail(
    `the converted home has no ${folder}/: v5 makes it only for a NEW home${folder === 'logs' ? ', so fyd writes no log at all' : ''}`,
  );
say(`booting v5 on the converted home itself: ${home}`);

// ─── start fyd ───────────────────────────────────────────────────────────────────────────────────────────────────

await mkdir(join(bootDir, 'user-home'), { recursive: true, mode: 0o700 });
const stderrFile = join(bootDir, 'fyd.stderr');
await writeFile(stderrFile, '', { mode: 0o600 });

const child: Subprocess<'ignore', 'pipe', 'pipe'> = spawn({
  cmd: [process.execPath, FYD, '--port', '0'],
  cwd: REPO,
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(bootDir, 'user-home'),
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    FY_HOME: home,
  },
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
});

const stderrLines: string[] = [];
let readyLine: string | undefined;
const pump = async (stream: ReadableStream<Uint8Array>, keep: boolean): Promise<void> => {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    appendFileSync(stderrFile, text);
    if (!keep) continue;
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      stderrLines.push(line);
      if (readyLine === undefined && /^fyd \S+ ready \(/u.test(line)) readyLine = line;
    }
  }
  if (keep && pending !== '') stderrLines.push(pending);
};
const pumps = Promise.all([pump(child.stderr, true), pump(child.stdout, false)]);

let exited: number | undefined;
void child.exited.then(code => {
  exited = code;
});

const deadline = Date.now() + READY_TIMEOUT_MS;
while (readyLine === undefined && exited === undefined && Date.now() < deadline) await Bun.sleep(250);

let token: string | undefined;
let base: string | undefined;

try {
  if (readyLine === undefined) {
    fail(
      exited === undefined
        ? `fyd did not say ready within ${String(READY_TIMEOUT_MS / 1000)}s`
        : `fyd exited ${String(exited)} before it was ready (v5 refused the home): ${stderrLines.join(' | ')}`,
    );
    throw new BootStop();
  }
  say(`fyd: ${readyLine}`);
  const run = DaemonRunSchema.parse(JSON.parse(await readFile(join(home, DAEMON_RUN_FILE), 'utf8')));
  base = `http://127.0.0.1:${String(run.port)}`;
  const healthy = await waitHealthy(base);
  if (!healthy) {
    fail('/healthz did not answer 200 after ready');
    throw new BootStop();
  }
  token = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
  if (token === '') {
    fail('state/gate/admin-token is empty');
    throw new BootStop();
  }

  // 2. Plugins: the doctor lines fyd printed before "ready" (every failed, refused or damaged plugin), then the
  // inventory. A doctor line names a plugin by its title; the id is the title in kebab case (`MCP` → `mcp`).
  const doctorFails = stderrLines.filter(line => line.startsWith('fyd: ')).map(line => line.slice('fyd: '.length));
  const unexplained: string[] = [];
  for (const line of doctorFails) {
    const damage = /\bstate\/([a-z0-9-]+)\/([^\s,]+)/u.exec(line);
    const needs = /^(.+?) needs (.+?), which (?:is not running|failed)\.$/u.exec(line);
    const build = /^(.+?) failed to build: /u.exec(line);
    const hook = /^([a-z0-9-]+) takes \S+ with a definition different from its offerer's\.$/u.exec(line);
    if (damage?.[1] !== undefined && damage[2] !== undefined && /Ferretry will not use it|is missing/u.test(line))
      down.push({ plugin: damage[1], file: `state/${damage[1]}/${damage[2]}`, why: reasonOf(line) });
    else if (needs?.[1] !== undefined && needs[2] !== undefined)
      down.push({ plugin: idOf(needs[1]), why: line, blockedBy: idOf(needs[2]) });
    else if (build?.[1] !== undefined) down.push({ plugin: idOf(build[1]), why: line });
    else if (hook?.[1] !== undefined) down.push({ plugin: hook[1], why: `refused: ${line}` });
    else unexplained.push(line);
  }
  // A declared check failing on this CI machine (no harness installed, a check not built yet): not a plugin down.
  for (const line of unexplained) say(`doctor (not a plugin down): ${line}`);

  let admitted = true;
  try {
    const inventory = z
      .object({ plugins: z.array(z.object({ id: z.string(), on: z.boolean() })) })
      .parse(await get(base, token, '/v1/plugins'));
    const switchedOff = await pluginsSwitchedOff(home);
    for (const plugin of inventory.plugins) {
      if (plugin.on) continue;
      if (switchedOff.has(plugin.id)) {
        say(`plugin ${plugin.id}: off in config/plugins.yaml (not a failure)`);
        continue;
      }
      down.push({ plugin: plugin.id, why: 'not running (failed to build, or needs a plugin that did not start)' });
    }
    say(
      `plugins: ${String(inventory.plugins.length)} known, ${String(inventory.plugins.filter(plugin => plugin.on).length)} on`,
    );
  } catch (error) {
    // Gate (core) is still a skeleton in v5: with no admission, every route but the public ones refuses with this
    // code. The data cannot be read through v5 yet; the checks run by themselves once Gate lands.
    if (!(error instanceof RouteError && error.status === 503 && error.said.startsWith('admission_unavailable')))
      throw error;
    admitted = false;
    warn(
      'v5 has no admission yet (Gate is a skeleton in this build): every authenticated route answers 503 ' +
        'admission_unavailable, so the plugin inventory and the data checks (ferrets, project, cards, agenda) ' +
        'could NOT run; plugin health comes from the doctor lines and fyd.log alone',
    );
  }

  // 3. The data, through v5's own routes.
  if (admitted) {
    await checkFerrets(base, token);
    await checkProjects(base, token);
    await checkCards(base, token);
    await checkAgenda(base, token);
  }
} catch (error) {
  if (!(error instanceof BootStop))
    fail(`the boot proof stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // 4. Stop: SIGTERM, then the tmux server on the home's own socket.
  if (exited === undefined) {
    child.kill('SIGTERM');
    const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(STOP_TIMEOUT_MS).then(() => false)]);
    if (!stopped) {
      fail(`fyd did not stop within ${String(STOP_TIMEOUT_MS / 1000)}s of SIGTERM; killed`);
      child.kill('SIGKILL');
      await child.exited;
    } else if ((await child.exited) !== 0) fail(`fyd exited ${String(await child.exited)} on SIGTERM`);
    else say('fyd stopped cleanly on SIGTERM');
  }
  await pumps.catch(() => undefined);
  await killTmux(home);
}

// Read after the daemon stopped: everything it logged, and any folder it moved aside.
await readFydLog(home);
await findMovedAside(home);

// ─── verdict ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Every down plugin is a converter bug. A plugin down only because one it needs is down is still listed, so the
// whole effect shows; the root is the one without `blockedBy`.
const seen = new Set<string>();
for (const entry of down) {
  const key = `${entry.plugin}|${entry.file ?? ''}|${entry.why}`;
  if (seen.has(key)) continue;
  seen.add(key);
  fail(`plugin ${entry.plugin} is down${entry.file === undefined ? '' : ` (${entry.file})`}: ${entry.why}`);
}
const downIds = new Set(down.map(entry => entry.plugin));
say(`plugins down: ${[...downIds].join(', ') || 'none'}`);
say(
  `${errors.length === 0 ? 'PASS' : 'FAIL'}: ${String(errors.length)} error(s), ${String(warnings.length)} warning(s)`,
);
await writeFile(join(bootDir, 'summary.json'), `${JSON.stringify({ home, down, errors, warnings }, null, 2)}\n`);
process.exit(errors.length === 0 ? 0 : 1);

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

function reasonOf(line: string): string {
  if (line.includes('has no "format"')) return 'no "format" stamp';
  if (line.includes('older format')) return 'an older format';
  if (line.includes('newer Ferretry')) return 'a newer format';
  if (line.includes('does not hold what Ferretry expects')) return 'refused by its schema';
  if (line.includes('is missing')) return 'a required file is missing';
  if (line.includes('cannot be read')) return 'not readable JSON';
  return 'refused';
}

async function waitHealthy(url: string): Promise<boolean> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.status === 200) return true;
    } catch {
      // not listening yet
    }
    await Bun.sleep(500);
  }
  return false;
}

/** One GET to the daemon this script started. The token goes in the header only; an error names the route. */
async function get(url: string, bearer: string, path: string): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${bearer}`, 'x-ferretry-client': 'cli', accept: 'application/json' },
  });
  const text = await response.text();
  if (response.status !== 200) {
    let said = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { error?: unknown; code?: unknown };
      if (typeof body.error === 'string') said = `${String(body.code ?? '')} ${body.error}`.trim();
    } catch {
      // not JSON
    }
    throw new RouteError(path, response.status, said);
  }
  return JSON.parse(text) as unknown;
}

/** A check that fails names the route; a `store_damaged` answer names the refused file and marks its plugin down. */
async function checked(plugin: string, what: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof RouteError && error.said.includes('store_damaged'))
      down.push({ plugin, why: `answers store_damaged on GET ${error.path}: ${error.said}` });
    fail(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkFerrets(url: string, bearer: string): Promise<void> {
  await checked('ferrets', 'ferrets', async () => {
    const listed = z.array(FerretSummarySchema).parse(await get(url, bearer, '/v1/ferrets'));
    for (const ferret of made.ferrets) {
      const found = listed.find(entry => entry.id === ferret.id);
      if (found === undefined) {
        fail(`ferret ${ferret.id} (${ferret.name}, ${ferret.role}) is not in GET /v1/ferrets`);
        continue;
      }
      // v5's `name` is v4's callsign; v4's free-form `--name` is v5's `title`.
      if (found.title !== ferret.name && found.name !== ferret.name)
        fail(
          `ferret ${ferret.id}: v4 named it "${ferret.name}"; v5 lists name "${found.name}", title "${found.title ?? ''}"`,
        );
      if (ferret.requestedParent !== null && found.parent !== ferret.requestedParent)
        fail(`ferret ${ferret.id}: its parent was ${ferret.requestedParent}; v5 lists ${found.parent ?? 'none'}`);
      if (found.mode !== undefined && found.mode !== ferret.mode)
        fail(`ferret ${ferret.id}: it was ${ferret.mode}; v5 lists ${found.mode}`);
      if (ferret.state === 'ended' && found.state !== 'stopped')
        fail(`ferret ${ferret.id} was ended in v4; v5 lists it ${found.state}`);
      say(`ferret ${ferret.id} (${ferret.role}): listed as ${found.name} "${found.title ?? ''}", ${found.state}`);
    }
  });
}

async function checkProjects(url: string, bearer: string): Promise<void> {
  const project = made.project;
  if (project === undefined) return;
  await checked('projects', 'projects', async () => {
    const listed = ProjectListSchema.parse(await get(url, bearer, '/v1/projects'));
    const found =
      project.id === null
        ? listed.find(entry => entry.path === project.path)
        : listed.find(entry => entry.id === project.id);
    if (found === undefined) {
      fail(`project ${project.id ?? project.path} (${project.name}) is not in GET /v1/projects`);
      return;
    }
    if (found.name !== project.name) fail(`project ${found.id}: it was "${project.name}"; v5 lists "${found.name}"`);
    if (found.path !== project.path) fail(`project ${found.id}: its path changed`);
    say(`project ${found.id}: listed as ${found.name}`);
  });
}

async function checkCards(url: string, bearer: string): Promise<void> {
  for (const card of made.cards ?? [])
    await checked('board', `card ${card.id}`, async () => {
      const { card: view } = CardResponseSchema.parse(await get(url, bearer, `/v1/board/cards/${card.id}`));
      if (view.id !== card.id) fail(`card ${card.id}: v5 answered card ${view.id}`);
      if (view.laneId !== card.lane) fail(`card ${card.id}: it was in lane ${card.lane}; v5 has it in ${view.laneId}`);
      if (card.dependsOn !== undefined && !JSON.stringify(view.dependsOn).includes(`"${card.dependsOn}"`))
        fail(`card ${card.id}: it depended on ${card.dependsOn}; v5 lists no such dependency`);
      say(`card ${card.id}: in lane ${view.laneId}, ${String(view.dependsOn.length)} dependency(ies)`);
    });
}

async function checkAgenda(url: string, bearer: string): Promise<void> {
  const items = made.agenda ?? [];
  if (items.length === 0) return;
  // The fixture raises its asks from the ferret it leaves running; ask ids are per ferret.
  const owner = made.ferrets.find(ferret => ferret.role === 'running');
  if (owner === undefined) {
    fail('made.json records agenda items but no running ferret to hold them');
    return;
  }
  await checked('asks', 'agenda', async () => {
    const snapshot = z
      .object({ items: z.array(z.object({ id: z.string() })), resolved: z.array(z.object({ id: z.string() })) })
      .parse(await get(url, bearer, `/v1/ferrets/${owner.id}/agenda`));
    for (const item of items) {
      const open = snapshot.items.some(entry => entry.id === item.id);
      const resolved = snapshot.resolved.some(entry => entry.id === item.id);
      if (!open && !resolved) fail(`agenda item ${item.id} of ferret ${owner.id} is not on its v5 agenda`);
      else if (item.state === 'open' && !open) fail(`agenda item ${item.id} was open in v4; v5 has it resolved`);
      else if (item.state === 'answered' && !resolved)
        fail(`agenda item ${item.id} was answered in v4; v5 has it open`);
      else say(`agenda item ${item.id} of ${owner.id}: ${open ? 'open' : 'resolved'}`);
    }
  });
}

async function pluginsSwitchedOff(at: string): Promise<ReadonlySet<string>> {
  const path = join(at, 'config/plugins.yaml');
  if (!existsSync(path)) return new Set();
  try {
    const document = parseYaml(await readFile(path, 'utf8')) as { plugins?: Record<string, unknown> } | null;
    return new Set(
      Object.entries(document?.plugins ?? {})
        .filter(([, state]) => state === 'off')
        .map(([id]) => id),
    );
  } catch {
    warn('config/plugins.yaml could not be read by this script');
    return new Set();
  }
}

/** What the kernel logged about a plugin's state: refused files, failed builds, folders moved aside. */
async function readFydLog(at: string): Promise<void> {
  const path = join(at, 'logs/fyd.log');
  if (!existsSync(path)) return;
  const text = await readFile(path, 'utf8');
  await writeFile(join(bootDir, 'fyd.log'), text, { mode: 0o600 });
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: { level?: string; message?: string; fields?: Record<string, unknown> };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const plugin = typeof record.fields?.plugin === 'string' ? record.fields.plugin : undefined;
    const file = typeof record.fields?.file === 'string' ? record.fields.file : undefined;
    const reason = typeof record.fields?.reason === 'string' ? record.fields.reason : undefined;
    // Every warning and error the kernel logged, for the next fix: the message and the names only, no other field.
    if (record.level === 'warn' || record.level === 'error')
      say(
        `fyd.log ${record.level}: ${record.message ?? '?'}${[plugin, file, reason]
          .filter(part => part !== undefined)
          .map(part => ` [${part}]`)
          .join('')}`,
      );
    if (plugin === undefined) continue;
    switch (record.message) {
      case 'a plugin failed to build':
        down.push({ plugin, why: 'failed to build' });
        break;
      case 'a state file cannot be read':
        down.push({ plugin, ...(file === undefined ? {} : { file }), why: `refused when read (${reason ?? '?'})` });
        break;
      case 'a state file uses its narrower refusal':
        down.push({
          plugin,
          ...(file === undefined ? {} : { file }),
          why: `refused at boot (${reason ?? '?'}); the plugin runs without it`,
        });
        break;
      case 'a plugin folder in an older format was moved aside':
        down.push({ plugin, why: 'its folder was in an older format and was MOVED ASIDE: it started empty' });
        break;
    }
  }
}

async function findMovedAside(at: string): Promise<void> {
  const entries = await readdir(join(at, 'state')).catch(() => [] as string[]);
  for (const entry of entries) {
    const match = /^(.+)-before-\d{4}-\d{2}-\d{2}-\d{4}$/u.exec(entry);
    if (match?.[1] !== undefined)
      down.push({ plugin: match[1], file: `state/${entry}`, why: 'its folder was moved aside: it started empty' });
  }
}

/** The tmux server v5's Terminals plugin runs on the home's own socket, if it started one. */
async function killTmux(at: string): Promise<void> {
  const socket = join(at, 'state/terminals/tmux.sock');
  if (!existsSync(socket)) return;
  const tmux = Bun.which('tmux');
  if (tmux === null) return;
  const killed = spawn({ cmd: [tmux, '-S', socket, 'kill-server'], stdout: 'ignore', stderr: 'ignore' });
  await killed.exited;
  say(`tmux server on ${socket}: ${(await killed.exited) === 0 ? 'killed' : 'not running'}`);
}
