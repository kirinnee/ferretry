/**
 * The `--rich` half of `build-v4-home.ts`: everything a lived-in v4 home holds that the default fixture does not, made
 * through v4's own CLI and HTTP API with the fake harness, never by writing a v4 file.
 *
 * It runs AFTER the default steps, with the daemon up. Every step here is optional: one v4 cannot do is recorded as
 * `skipped` with the reason (in made.json), exactly as the default builder does, and the run goes on. Nothing here holds
 * a credential: logins and secrets are FAKE, by name, and a secret's value is the same constant the default fixture uses.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FerretRecord, Ran, RichContext } from './build-v4-home.ts';

const FAKE_SECRET_VALUE = 'fixture-not-a-secret';

/** One PNG, drawn here (no image library): a `size`×`size` square of one colour with a lighter border. */
export function makePng(size: number, rgb: readonly [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const edge = x < 3 || y < 3 || x >= size - 3 || y >= size - 3;
      for (let channel = 0; channel < 3; channel++) row[1 + x * 3 + channel] = edge ? 255 : (rgb[channel] ?? 0);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const shellQuote = (value: string): string => `'${value.split("'").join(`'\\''`)}'`;

/** Everything a scripted exchange can contain, written to a file the fake harness reads (see support/fake-claude-rich.ts). */
type Script = { readonly model?: string; readonly steps: readonly Record<string, unknown>[] };

export async function buildRich(ctx: RichContext): Promise<void> {
  const { step, cannot, fy, fyOk, made, out, work, userHome } = ctx;
  const scripts = join(out, 'rich-scripts');
  const files = join(out, 'rich-files');
  await mkdir(scripts, { recursive: true });
  await mkdir(files, { recursive: true });

  const opt = (name: string, body: () => Promise<void>): Promise<boolean> => step(name, false, body);

  /** Plays one scripted exchange into a ferret: its transcript and its pane (the fake harness reads the file). */
  const play = async (ferret: string, name: string, script: Script): Promise<void> => {
    const path = join(scripts, `${name}.json`);
    await writeFile(path, JSON.stringify(script));
    await fyOk(['send', ferret, '--kind', 'blocker', `FIXTURE-REC ${path}`]);
  };

  /** Runs a command AS the ferret (its own pane environment holds its credential; this program never sees it). */
  const asFerret = async (ferret: string, args: readonly string[]): Promise<string> => {
    const result = join(files, `as-${ferret}-${String(Date.now())}.txt`);
    const command = `env FY_URL=${ctx.baseUrl()} ${ctx.v4Dir}/fy ${args.map(shellQuote).join(' ')}`;
    await fyOk(['send', ferret, '--kind', 'blocker', `FIXTURE-RUN ${result} ${command}`]);
    const deadline = Date.now() + 90_000;
    let code = '';
    while (code === '' && Date.now() < deadline) {
      code = (await readFile(`${result}.code`, 'utf8').catch(() => '')).trim();
      if (code === '') await Bun.sleep(400);
    }
    const text = await readFile(result, 'utf8').catch(() => '');
    if (code === '') throw new Error(`the ferret never ran "fy ${args.slice(0, 2).join(' ')}" within 90 s`);
    if (code !== '0')
      throw new Error(
        `fy ${args.slice(0, 2).join(' ')}, run by the ferret, exited ${code}: ${text.trim().slice(0, 300)}`,
      );
    return text;
  };

  const ferrets = new Map<string, FerretRecord>();
  const start = async (
    role: string,
    name: string,
    prompt: string,
    options: { mode?: 'auto' | 'interactive'; cwd?: string; parent?: string; agent?: string } = {},
  ): Promise<FerretRecord> => {
    const record = await ctx.startFerret(role, name, prompt, {
      mode: options.mode ?? 'auto',
      cwd: options.cwd ?? ctx.projectDir,
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    });
    ferrets.set(role, record);
    return record;
  };
  const idOf = (role: string): string => {
    const found = ferrets.get(role) ?? ctx.existing.get(role);
    if (found === undefined) throw new Error(`no ferret with the role ${role}`);
    return found.id;
  };

  // ── the world the harness lives in: skills the home can offer, a second and third project, an image ─────────────
  await step('lay out the extra projects, skill folders and an image', false, async () => {
    for (const name of ['beta', 'gamma']) await mkdir(join(work, name), { recursive: true });
    const git = Bun.which('git');
    if (git !== null) await ctx.run(git, ['init', '--quiet', join(work, 'beta')], { env: ctx.childEnvironment() });
    // gamma stays a plain folder on purpose: a project that is not a git repository.
    await writeFile(join(work, 'gamma', 'README.md'), '# gamma\nA plain folder project.\n');
    await writeFile(join(work, 'beta', 'README.md'), '# beta\nA second git project.\n');
    await mkdir(join(work, 'alpha', 'design'), { recursive: true });
    await writeFile(join(work, 'alpha', 'design', 'mockup.png'), makePng(96, [64, 120, 200]));
    await writeFile(join(work, 'alpha', 'src.txt'), 'line one\nline two\nline three\n');
    for (const [base, name, body] of [
      [join(userHome, '.claude', 'skills'), 'review', 'Review a diff for bugs, then summarise.'],
      [join(userHome, '.claude', 'skills'), 'release-notes', 'Write release notes from merged work.'],
      [join(work, 'alpha', '.claude', 'skills'), 'deploy-check', 'Check a deploy is healthy before telling anyone.'],
    ] as const) {
      await mkdir(join(base, name), { recursive: true });
      await writeFile(
        join(base, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${name}\n\n${body}\n`,
      );
    }
    made.world = { projects: ['alpha', 'beta', 'gamma'], image: join(work, 'alpha', 'design', 'mockup.png') };
  });

  // ── secrets by name (the value is the same constant for all of them) ────────────────────────────────────────────
  await opt('set several secrets by name', async () => {
    const names = ['FIXTURE_GLM_KEY', 'FIXTURE_OPENAI_KEY', 'FIXTURE_GITHUB_TOKEN', 'FIXTURE_DOCS_TOKEN'];
    for (const name of names) await fyOk(['secret', 'set', name], { stdin: `${FAKE_SECRET_VALUE}\n` });
    const listing = await fyOk(['secret', 'ls', '--json']);
    for (const name of names) if (!listing.includes(name)) throw new Error(`${name} is not listed after it was set`);
    made.secrets = ['FIXTURE_NOT_A_SECRET', ...names];
  });

  // ── projects and boards ─────────────────────────────────────────────────────────────────────────────────────────
  await opt('register two more projects (one git, one plain folder)', async () => {
    await fyOk(['project', 'add', join(work, 'beta')]);
    await fyOk(['project', 'add', join(work, 'gamma')]);
    made.projects = parseJsonList(await fyOk(['project', 'ls', '--json']));
  });

  // ── components, profiles, logins, runtimes ──────────────────────────────────────────────────────────────────────
  await opt('add components: instructions, settings, hooks, model sets, skills and MCP servers', async () => {
    const write = async (name: string, text: string): Promise<string> => {
      const path = join(files, name);
      await writeFile(path, text);
      return path;
    };
    const main = await write('main.md', '# House rules\n\n- Say what you did, then stop.\n- Prefer small commits.\n');
    const review = await write('review.md', '# Review\n\nRead the diff first. Quote the line you object to.\n');
    const hooks = await write(
      'hooks.json',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, null, 2),
    );
    const results: Record<string, string> = {};
    const add = async (label: string, args: readonly string[]): Promise<void> => {
      const ran = await fy(['component', 'add', ...args, '--yes', '--json']);
      results[label] = ran.code === 0 ? 'added' : `refused: ${(ran.err || ran.out).trim().slice(0, 200)}`;
    };
    await add('instructions/house', ['instructions/house', '--file', main]);
    await add('instructions/review', ['instructions/review', '--file', review]);
    await add('settings/quiet', ['settings/quiet', '--harness', 'claude', '--env', 'FIXTURE_QUIET=1']);
    await add('hooks/stop', ['hooks/stop', '--harness', 'claude', '--file', hooks]);
    await add('modelSets/fast', [
      'modelSets/fast',
      '--model',
      'claude-sonnet-5-5',
      '--model',
      'claude-haiku-5-5',
      '--default',
      'claude-sonnet-5-5',
    ]);
    await add('mcp/github', [
      'mcp/github',
      '--command',
      'npx',
      '--arg',
      '-y',
      '--arg',
      '@modelcontextprotocol/server-github',
      '--env',
      'GITHUB_TOKEN=${secret:FIXTURE_GITHUB_TOKEN}',
    ]);
    await add('modelSets/openai', [
      'modelSets/openai',
      '--harness',
      'codex',
      '--model',
      'gpt-6.1-sol',
      '--default',
      'gpt-6.1-sol',
    ]);
    await add('mcp/docs', ['mcp/docs', '--url', 'http://127.0.0.1:9/mcp']);
    made.components = results;
    const failed = Object.entries(results).filter(([, value]) => value !== 'added');
    if (failed.length === Object.keys(results).length)
      throw new Error(`no component was added: ${JSON.stringify(failed[0])}`);
  });

  await opt('build profiles from layers', async () => {
    const results: Record<string, string> = {};
    for (const [name, layers] of [
      ['reviewer', ['instructions/house', 'instructions/review', 'settings/quiet']],
      ['tools', ['instructions/house', 'mcp/github', 'mcp/docs', 'hooks/stop']],
      ['fast', ['instructions/house', 'modelSets/fast']],
      ['base', ['instructions/house']],
      ['openai', ['instructions/house', 'modelSets/openai']],
    ] as const) {
      const ran = await fy([
        'profile',
        'build',
        name,
        ...layers.flatMap(layer => ['--layer', layer]),
        '--yes',
        '--json',
      ]);
      results[name] = ran.code === 0 ? 'built' : `refused: ${(ran.err || ran.out).trim().slice(0, 200)}`;
    }
    made.profiles = results;
    if (Object.values(results).every(value => value !== 'built')) throw new Error(JSON.stringify(results));
  });

  await opt('add logins of both harnesses with FAKE credentials, labels and usage budgets', async () => {
    const results: Record<string, string> = {};
    const login = async (id: string, args: readonly string[]): Promise<void> => {
      const ran = await fy(['login', 'add', ...args, '--id', id, '--yes', '--json']);
      results[id] = ran.code === 0 ? 'added' : `refused: ${(ran.err || ran.out).trim().slice(0, 240)}`;
    };
    // Signed-in by v4's own sign-in flow with the fake CLI is attempted after; these are added unsigned first.
    await login('claude-work', ['claude', '--label', 'work', '--no-sign-in']);
    await login('claude-personal', ['claude', '--label', 'personal', '--no-sign-in']);
    await login('codex-main', ['codex', '--label', 'main', '--no-sign-in']);
    {
      const ran = await fy(
        ['login', 'add', 'zai-glm', '--id', 'glm-env', '--label', 'glm gateway', '--yes', '--json'],
        { stdin: `${FAKE_SECRET_VALUE}\n` },
      );
      results['glm-env'] = ran.code === 0 ? 'added' : `refused: ${(ran.err || ran.out).trim().slice(0, 240)}`;
    }
    await login('openai-env', [
      'codex',
      '--label',
      'openai key',
      '--env',
      'OPENAI_API_KEY=${secret:FIXTURE_OPENAI_KEY}',
    ]);
    for (const [id, daily, weekly] of [
      ['claude-work', '20', '80'],
      ['claude-personal', '10', '40'],
      ['codex-main', '15', '60'],
      ['glm-env', '5', '20'],
    ] as const) {
      const ran = await fy([
        'login',
        'budget',
        id,
        '--daily-trigger',
        daily,
        '--daily-hard',
        String(Number(daily) * 2),
        '--weekly-trigger',
        weekly,
      ]);
      if (ran.code !== 0) results[`${id} budget`] = `refused: ${(ran.err || ran.out).trim().slice(0, 200)}`;
    }
    await fy(['login', 'label', 'claude-work', 'work (shared)']);
    made.logins = results;
    if (Object.values(results).every(value => value !== 'added')) throw new Error(JSON.stringify(results));
  });

  await opt('sign two logins in, as the app does: the fake CLI is given the code', async () => {
    const signed: string[] = [];
    const headers = { 'content-type': 'application/json' };
    for (const id of ['claude-work', 'claude-personal']) {
      const started = await ctx.owner('POST', '/v1/fleet/login', { credentialId: id, restart: true }, headers);
      const flow = (started.body as { flowId?: string }).flowId;
      if (started.status >= 300 || flow === undefined) {
        made[`signin ${id}`] = `start answered ${String(started.status)}`;
        continue;
      }
      await Bun.sleep(2500);
      const sent = await ctx.owner('POST', `/v1/fleet/login/${flow}`, { code: 'fixturecode#fixturestate' }, headers);
      if (sent.status >= 300) made[`signin ${id}`] = `code answered ${String(sent.status)}`;
      let state = '';
      for (let at = 0; at < 20 && state !== 'complete' && state !== 'failed'; at++) {
        await Bun.sleep(500);
        const got = await ctx.owner('GET', `/v1/fleet/login/${flow}`);
        state = String((got.body as { state?: unknown }).state ?? '');
      }
      if (state === 'complete') signed.push(id);
      else made[`signin ${id}`] = `ended ${state}`;
    }
    made.signedIn = signed;
    if (signed.length === 0)
      throw new Error('the fake sign-in did not complete for any login (see made.json "signin …")');
  });

  await opt('add runtimes on those logins and profiles, and a default runtime', async () => {
    const results: Record<string, string> = {};
    const runtime = async (name: string, credential: string, profile: string): Promise<void> => {
      const ran = await fy([
        'runtime',
        'add',
        name,
        '--credential',
        credential,
        '--profile',
        profile,
        '--agent',
        '--add-another',
        '--yes',
        '--json',
      ]);
      results[name] = ran.code === 0 ? 'added' : `refused: ${(ran.err || ran.out).trim().slice(0, 200)}`;
    };
    await runtime('claude-work-reviewer', 'claude-work', 'reviewer');
    await runtime('claude-personal-tools', 'claude-personal', 'tools');
    await runtime('claude-personal-default', 'claude-personal', 'claude-default');
    await runtime('claude-work-fast', 'claude-work', 'fast');
    await runtime('codex-main-agent', 'codex-main', 'base');
    await runtime('openai-agent', 'openai-env', 'openai');
    await runtime('glm-agent', 'glm-env', 'base');
    made.runtimes = results;
    const set = await fy(['machine', 'set', 'default-runtime', ctx.runtime(), '--yes']);
    if (set.code !== 0) results['default-runtime'] = `refused: ${(set.err || set.out).trim().slice(0, 160)}`;
  });

  await opt('install skills from a project into a profile and another project, then a skills component', async () => {
    const source = join(work, 'alpha', '.claude', 'skills', 'deploy-check', 'SKILL.md');
    const results: Record<string, string> = {};
    const into = await fy([
      'skill',
      'install',
      '--from',
      source,
      '--to',
      'runtime',
      '--runtime',
      'claude-work-fast',
      '--profile',
      'fast',
      '--yes',
    ]);
    results.profile =
      into.code === 0 ? 'installed into profile fast' : `refused: ${(into.err || into.out).trim().slice(0, 200)}`;
    const project = await fy([
      'skill',
      'install',
      '--from',
      source,
      '--to',
      'project',
      '--project',
      join(work, 'beta'),
      '--harness',
      'claude',
      '--yes',
    ]);
    results.project =
      project.code === 0 ? 'installed into beta' : `refused: ${(project.err || project.out).trim().slice(0, 200)}`;
    const component = await fy(['component', 'add', 'skills/team', '--item', 'deploy-check', '--yes', '--json']);
    results.component =
      component.code === 0 ? 'skills/team added' : `refused: ${(component.err || component.out).trim().slice(0, 200)}`;
    const skilled = await fy([
      'profile',
      'build',
      'skilled',
      '--layer',
      'instructions/house',
      '--layer',
      'skills/team',
      '--layer',
      'mcp/github',
      '--yes',
      '--json',
    ]);
    results.skilledProfile =
      skilled.code === 0 ? 'built' : `refused: ${(skilled.err || skilled.out).trim().slice(0, 200)}`;
    made.skillInstalls = results;
    if (Object.values(results).every(value => value.startsWith('refused'))) throw new Error(JSON.stringify(results));
  });

  // ── Ferretry's own settings files: warden, voice, learning, pack, limits, machine ──────────────────────────────
  const config = async (file: string, text: string): Promise<string> => {
    const ran = await fy(['config', 'write', file], { stdin: text });
    if (ran.code !== 0)
      throw new Error(`config write ${file} exited ${String(ran.code)}: ${(ran.err || ran.out).trim().slice(0, 300)}`);
    return (ran.out || ran.err).trim().slice(0, 200);
  };
  await opt('write the warden, voice, learning and pack settings', async () => {
    const results: Record<string, string> = {};
    for (const [file, text] of [
      [
        'warden.yaml',
        'enabled: true\nrevive:\n  enabled: true\n  windowMinutes: 30\n  waveSize: 2\nmayActAlone:\n  nudge: true\n',
      ],
      ['voice.yaml', 'defaultEngine: browser\npostProcessing:\n  provider: off\n  style: fix\n'],
      ['learning.yaml', 'enabled: true\nintervalMinutes: 240\nbatchSize: 10\npassiveDefault: true\n'],
      [
        'pack.yaml',
        'enabled: true\ndecision: agent\nlimits:\n  autoChildren: 6\n  interactiveChildren: 2\n  maxDepth: 2\nroutingPreferences: Everyday coding on claude-sonnet-5-5.\n',
      ],
    ] as const) {
      try {
        results[file] = await config(file, text);
      } catch (error) {
        results[file] = `refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    made.configFiles = results;
    if (Object.values(results).every(value => value.startsWith('refused'))) throw new Error(JSON.stringify(results));
  });

  await opt('confirm every change that waits for the owner (the owner is at this machine)', async () => {
    const listing = await fy(['config', 'confirm']);
    made.configHeld = (listing.out || listing.err).trim().slice(0, 600);
    // `config confirm <file>` puts one held change into effect; the listing names them one per line.
    const files = (listing.out.match(/\b[\w./-]+\.ya?ml\b/gu) ?? []).filter(
      (file, at, all) => all.indexOf(file) === at,
    );
    const confirmed: string[] = [];
    for (const file of files) {
      const ran = await fy(['config', 'confirm', file]);
      if (ran.code === 0) confirmed.push(file);
    }
    made.configConfirmed = confirmed;
  });

  // ── ferrets: every state, with lived-in conversations ──────────────────────────────────────────────────────────
  const png = join(work, 'alpha', 'design', 'mockup.png');

  await step('start the rich ferrets', false, async () => {
    const first = await Promise.all([
      start('reviewer', 'Rich reviewer', 'Rich: review the open diff and report.'),
      start('imager', 'Rich image', 'Rich: look at the mockup the owner attaches.'),
      start('doner', 'Rich done', 'Rich: a ferret that finishes on its own.'),
      start('waiter', 'Rich waiting', 'Rich: waits for a deploy.'),
      start('helper', 'Rich help', 'Rich: stuck and asking for help.'),
      start('hanger', 'Rich hang', 'Rich: a long turn that has not ended.'),
      start('dead', 'Rich dead', 'Rich: its pane will be killed.'),
      start('beta-idle', 'Rich beta idle', 'Rich: idle on the beta project.', { cwd: join(work, 'beta') }),
      start('gamma-idle', 'Rich gamma idle', 'Rich: idle in a plain folder.', { cwd: join(work, 'gamma') }),
      start('perm', 'Rich permission', 'Rich: asks before it deletes.', { mode: 'interactive' }),
      start('stopped', 'Rich stopped', 'Rich: stopped by the owner.'),
      start('cascade-lead', 'Rich cascade lead', 'Rich: a lead whose sub-ferrets are stopped.'),
    ]);
    void first;
    await Promise.all([
      start('cascade-a', 'Rich cascade A', 'Rich: sub A.', { parent: idOf('cascade-lead') }),
      start('cascade-b', 'Rich cascade B', 'Rich: sub B.', { parent: idOf('cascade-lead') }),
    ]);
  });

  await opt('start a ferret on each other runtime (fake codex, fake env logins)', async () => {
    const results: Record<string, string> = {};
    for (const [role, runtimeName] of [
      ['on-codex', 'codex-main-agent'],
      ['on-openai', 'openai-agent'],
      ['on-fast', 'claude-work-fast'],
      ['on-reviewer', 'claude-work-reviewer'],
    ] as const) {
      try {
        await start(role, `Rich ${role}`, `Rich: runs on ${runtimeName}.`, { agent: runtimeName });
        results[role] = 'started';
      } catch (error) {
        results[role] = `refused: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
      }
    }
    made.otherRuntimeFerrets = results;
  });

  await opt('give the reviewer a long multi-turn conversation with tool calls', async () => {
    const id = idOf('reviewer');
    await play(id, 'reviewer-1', {
      steps: [
        { user: 'Review the open diff in src.txt and tell me what is wrong with it.' },
        {
          assistant: [
            { type: 'thinking', thinking: 'Start with the file, then run the checks.', signature: 'fixture' },
            { type: 'text', text: 'Reading the file first.' },
          ],
        },
        {
          tool: {
            name: 'Read',
            input: { file_path: join(work, 'alpha', 'src.txt') },
            result: '1\tline one\n2\tline two\n3\tline three\n',
          },
        },
        {
          tool: {
            name: 'Grep',
            input: { pattern: 'line', path: join(work, 'alpha') },
            result: 'src.txt:1:line one\nsrc.txt:2:line two\nsrc.txt:3:line three',
          },
        },
        { assistant: [{ type: 'text', text: 'Three lines, no obvious defect yet. I will run the checks.' }] },
        {
          tool: { name: 'Bash', input: { command: 'wc -l src.txt', description: 'Count lines' }, result: '3 src.txt' },
        },
        {
          tool: {
            name: 'Edit',
            input: { file_path: join(work, 'alpha', 'src.txt'), old_string: 'line two', new_string: 'line 2' },
            result: 'The file has been updated.',
          },
        },
        {
          tool: {
            name: 'Bash',
            input: { command: 'cat missing.txt' },
            result: 'cat: missing.txt: No such file or directory',
            error: true,
          },
        },
        {
          assistant: [
            {
              type: 'text',
              text: '**Summary**\n\n- `src.txt` had a naming nit on line two (fixed)\n- `missing.txt` does not exist, so that check could not run\n\n```diff\n- line two\n+ line 2\n```',
            },
          ],
        },
        { user: 'Thanks. Now check the other file too.' },
        {
          tool: {
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Check README', status: 'completed', activeForm: 'Checking README' },
                { content: 'Report', status: 'in_progress', activeForm: 'Reporting' },
              ],
            },
            result: 'Todos have been modified successfully.',
          },
        },
        { assistant: [{ type: 'text', text: 'README is fine. Nothing else to change.' }] },
      ],
    });
  });

  await opt('give a ferret an image attachment, through v4 and into its transcript', async () => {
    const id = idOf('imager');
    // The CLI's -f needs a file loader this release's binary lacks; the app's own route is the same upload then send.
    const uploaded = await ctx.owner('POST', `/v1/sessions/${id}/attachments`, {
      filename: 'mockup.png',
      mime: 'image/png',
      base64: (await Bun.file(png).bytes()).toBase64(),
    });
    const attachment = (uploaded.body as { id?: string }).id;
    if (attachment === undefined) throw new Error(`the upload answered ${String(uploaded.status)}`);
    const sent = await ctx.owner(
      'POST',
      `/v1/sessions/${id}/send`,
      { message: 'Here is the mockup. What do you think of the spacing?', attachmentIds: [attachment] },
      { 'content-type': 'application/json', 'x-fy-request-id': `rich-image-${id}` },
    );
    if (sent.status >= 300) throw new Error(`the send answered ${String(sent.status)}`);
    await Bun.sleep(1500);
    await play(id, 'imager-1', {
      steps: [
        { userImage: { file: png, text: 'Here is the mockup. What do you think of the spacing?' } },
        {
          assistant: [
            {
              type: 'text',
              text: 'The mockup is a blue square with a pale border. The border is about 3 px; I would make it 4 px so it survives scaling.',
            },
          ],
        },
        { user: 'Good, and the colour?' },
        {
          assistant: [
            {
              type: 'text',
              text: 'The blue reads well on white. On dark it needs a lighter edge, which the border already gives it.',
            },
          ],
        },
      ],
    });
  });

  await opt('make a ferret that finishes, one that waits, one that asks for help', async () => {
    const results: Record<string, string> = {};
    await fyOk(['signal', 'done', '--session', idOf('doner'), 'Rich: all finished, nothing left.']);
    results.done = 'signalled done';
    await fyOk(['signal', 'waiting', '--session', idOf('waiter'), '--until', '2h', '--on', 'the deploy to finish']);
    results.waiting = 'signalled waiting';
    await fyOk(['signal', 'help', '--session', idOf('helper'), 'Rich: I cannot tell which branch to use.']);
    results.help = 'signalled help';
    made.signals = results;
  });

  await opt('stop one ferret, stop a lead with its children, and stop another and resume it', async () => {
    await fyOk(['stop', '--reason', 'rich: stopped by the owner', 'orphan', '--yes', idOf('stopped')]);
    await fyOk(['stop', '--reason', 'rich: cascade', 'children', '--yes', idOf('cascade-lead')]);
    made.stops = { orphan: idOf('stopped'), children: idOf('cascade-lead') };
  });

  await opt('queue messages for a ferret that cannot take them, and a note in a draft', async () => {
    const hanger = idOf('hanger');
    await play(hanger, 'hanger-1', {
      steps: [
        { user: 'Run the whole migration and tell me when it is done.' },
        { assistant: [{ type: 'text', text: 'Starting the migration. This will take a while.' }] },
        { hang: true },
      ],
    });
    await Bun.sleep(2000);
    for (const text of ['rich queued one', 'rich queued two (edit me)', 'rich queued three (cancel me)'])
      await fy(['send', hanger, '--kind', 'fyi', text]);
    const queue = parseJsonText(await fyOk(['queue', hanger, '--json']));
    const messages = (isRecord(queue) && Array.isArray(queue.messages) ? queue.messages : []) as unknown[];
    const ids = messages.flatMap(message => (isRecord(message) && typeof message.id === 'string' ? [message.id] : []));
    if (ids[1] !== undefined) await fy(['queue', 'edit', hanger, ids[1], 'rich queued two, reworded']);
    if (ids[2] !== undefined) await fy(['queue', 'cancel', hanger, ids[2]]);
    made.richQueue = { ferret: hanger, messages: ids.length };
  });

  await opt('pin a ferret and notes on others', async () => {
    await fyOk(['session', 'pin', idOf('reviewer')]);
    await fyOk(['pin', '--session', idOf('reviewer'), 'add', 'rich pinned note: remember the border width']);
    await fyOk(['pin', '--session', idOf('imager'), 'add', 'rich pinned note: mockup is blue']);
    made.richPins = [idOf('reviewer'), idOf('imager')];
  });

  // ── board: cards across lanes with links, dependencies, history, blocks, a drop ────────────────────────────────
  await opt('make board cards across lanes, projects and states', async () => {
    for (const project of ['beta']) {
      await fy(['board', 'on', '--project', project]);
      await fy(['board', 'lanes', 'propose', '--project', project, '--template', 'pr']);
    }
    const lanesText = await fy(['board', 'lanes', 'show', '--project', 'alpha', '--json']);
    made.alphaLanes = lanesText.out.trim().slice(0, 800);
    const laneNames = collectNames(parseJsonText(lanesText.out));
    const lane = (index: number): string => laneNames[Math.min(index, laneNames.length - 1)] ?? 'todo';
    const owner = idOf('reviewer');
    const create = async (
      project: string,
      kind: string,
      title: string,
      extra: readonly string[] = [],
    ): Promise<string> => {
      const text = await fyOk([
        'task',
        'create',
        '--kind',
        kind,
        '--title',
        title,
        '--summary',
        `${title} summary`,
        '--ask',
        `${title}: the owner's words`,
        '--ask-source',
        'rich fixture',
        '--workflow',
        'quick',
        '--public',
        '--new',
        '--assignee',
        owner,
        '--project',
        project,
        '--json',
        ...extra,
      ]);
      const id = findId(text);
      if (id === undefined) throw new Error('fy task create printed no card id');
      return id;
    };
    const cards: Record<string, string> = {};
    cards.login = await create('alpha', 'feature', 'Rich login screen', [
      '--premise',
      'Users cannot sign in',
      '--context',
      'Needs the new design',
      '--how-to-test',
      '1. Open the app\n2. Sign in',
    ]);
    cards.crash = await create('alpha', 'bug', 'Rich crash on save', ['--depends-on', cards.login]);
    cards.infra = await create('alpha', 'infra', 'Rich CI cache', ['--file', 'ci/cache.yaml']);
    cards.chore = await create('alpha', 'chore', 'Rich tidy imports');
    cards.shipped = await create('alpha', 'feature', 'Rich shipped thing');
    cards.dropped = await create('alpha', 'chore', 'Rich dropped idea');
    cards.betaOne = await create('beta', 'feature', 'Rich beta feature');
    cards.betaTwo = await create('beta', 'bug', 'Rich beta bug');
    const moves: [string, number][] = [
      [cards.crash, 1],
      [cards.infra, 2],
      [cards.chore, 3],
      [cards.shipped, 4],
      [cards.betaOne, 1],
    ];
    for (const [card, at] of moves) await fy(['task', 'move', card, lane(at), '--reason', 'rich: spread across lanes']);
    await fy(['task', 'link', cards.login, '--branch', 'rich/login-screen']);
    await fy(['task', 'link', cards.crash, '--doc', 'docs/crash.md']);
    await fy(['task', 'note', cards.login, 'rich history: design approved']);
    await fy(['task', 'note', cards.login, 'rich history: first draft pushed']);
    await fy(['task', 'clarify', cards.crash, 'rich clarification: only on large files']);
    await fy(['task', 'block', cards.infra, 'waiting on the cache vendor']);
    await fy(['task', 'depend', cards.betaTwo, cards.betaOne]);
    await fy(['task', 'drop', cards.dropped, 'rich: superseded by the login card']);
    await fy([
      'task',
      'create',
      '--kind',
      'chore',
      '--title',
      'Rich private sub-card',
      '--parent',
      cards.login,
      '--private',
      '--project',
      'alpha',
      '--session',
      owner,
      '--json',
    ]);
    made.richCards = cards;
    cannot(
      'board cards with pull-request links',
      'a PR link makes the daemon ask GitHub for its state, and this build makes no network call; the branch and document links are made instead',
    );
  });

  // ── agenda: items in every state ───────────────────────────────────────────────────────────────────────────────
  await opt('raise agenda items of every kind and bring them to every state', async () => {
    const asker = idOf('reviewer');
    const other = idOf('imager');
    await writeFile(join(files, 'body.md'), '## The full picture\n\nA longer explanation.\n\n- one\n- two\n');
    const add = async (as: string, title: string, args: readonly string[]): Promise<void> => {
      await fyOk(
        [
          'agenda',
          '--json',
          'add',
          '--title',
          title,
          '--premise',
          'Rich: a lived-in home needs asks.',
          '--context',
          'Rich: nothing here is real.',
          '--new',
          'Rich: nothing open fits this one.',
          ...args,
        ],
        { as },
      );
    };
    const results: Record<string, string> = {};
    const attempt = async (label: string, body: () => Promise<void>): Promise<void> => {
      try {
        await body();
        results[label] = 'made';
      } catch (error) {
        results[label] = `refused: ${error instanceof Error ? error.message.slice(0, 220) : String(error)}`;
      }
    };
    await attempt('choice', () =>
      add(asker, 'Rich choice ask', [
        '--kind',
        'choice',
        '--ask',
        'Which database?',
        '-o',
        'Postgres: the safe one',
        '-o',
        'SQLite: the small one',
        '--recommend',
        'Postgres',
        '--recommend-why',
        'Already deployed',
      ]),
    );
    await attempt('reply', () =>
      add(asker, 'Rich reply ask', [
        '--kind',
        'reply',
        '--ask',
        'What should the onboarding say?',
        '--question',
        'Tone?',
        '--question',
        'Length?',
      ]),
    );
    await attempt('yesno', () =>
      add(other, 'Rich yes-no ask', [
        '--kind',
        'yesno',
        '--ask',
        'Ship it today?',
        '--impact',
        'Release slips a day',
        '--urgency',
        'before 17:00',
      ]),
    );
    await attempt('form', () =>
      add(asker, 'Rich form ask', [
        '--kind',
        'form',
        '--ask',
        'Fill in the release form',
        '--field',
        'name|text|Release name',
        '--field',
        'risk|one|How risky?|Low|*Medium|High',
      ]),
    );
    await attempt('todo', () =>
      add(other, 'Rich to-do ask', [
        '--kind',
        'todo',
        '--ask',
        'Rotate the staging key',
        '--step',
        'Open **Settings** and choose Logins',
        '--step',
        'Run `fy login check claude-work`',
        '--link',
        'Runbook=docs/rotate.md=how to rotate',
      ]),
    );
    await attempt('info', () => add(other, 'Rich info note', ['--kind', 'info', '--ask', 'The deploy finished']));
    await attempt('tabs', () =>
      add(asker, 'Rich ask with tabs', [
        '--kind',
        'choice',
        '--ask',
        'Approve the plan?',
        '-o',
        'Approve: go',
        '-o',
        'Change: I will reply',
        '--body-file',
        join(files, 'body.md'),
      ]),
    );
    const board = parseJsonText(await fyOk(['agenda', '--json', 'ls', '--session', asker]));
    const titles = new Map<string, string>();
    if (isRecord(board) && Array.isArray(board.items))
      for (const item of board.items)
        if (isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string')
          titles.set(item.title, item.id);
    const id = (title: string): string | undefined => titles.get(title);
    if (id('Rich choice ask') !== undefined)
      await attempt('answered', () =>
        fyOk(['agenda', 'done', `!${id('Rich choice ask') ?? ''}`, '--session', asker, '--note', 'rich: Postgres'], {
          as: asker,
        }).then(() => undefined),
      );
    if (id('Rich yes-no ask') !== undefined)
      await attempt('snoozed', () =>
        fyOk(['agenda', 'snooze', `!${id('Rich yes-no ask') ?? ''}`, '--session', other]).then(() => undefined),
      );
    if (id('Rich reply ask') !== undefined)
      await attempt('resting', () =>
        fyOk(['agenda', 'rest', `!${id('Rich reply ask') ?? ''}`, '--why', 'rich: working on it'], { as: asker }).then(
          () => undefined,
        ),
      );
    if (id('Rich info note') !== undefined)
      await attempt('dismissed', () =>
        fyOk(['agenda', 'dismiss', `!${id('Rich info note') ?? ''}`, '--session', other]).then(() => undefined),
      );
    if (id('Rich form ask') !== undefined)
      await attempt('needs-info', () =>
        fyOk(['agenda', 'needs-info', `!${id('Rich form ask') ?? ''}`, '--session', asker]).then(() => undefined),
      );
    made.agendaRich = results;
    if (Object.values(results).every(value => value.startsWith('refused'))) throw new Error(JSON.stringify(results));
  });

  // ── notifications and lessons ──────────────────────────────────────────────────────────────────────────────────
  await opt('send notifications (plain, with a body, with a ping)', async () => {
    // Only a ferret (or the daemon) sends a notice, so the ferret runs it: its words stay on ONE line, as a typed line must.
    await asFerret(idOf('beta-idle'), ['notify', 'Rich: the beta build is green']);
    await asFerret(idOf('beta-idle'), [
      'notify',
      'Rich: a longer notice',
      '--body',
      '**Detail:** the longer reading behind it, with `code` and a list: one, two.',
    ]);
    await asFerret(idOf('gamma-idle'), ['notify', 'Rich: needs your eyes today', '--ping']);
    made.richNotices = 3;
  });

  await opt('file lessons as ferrets and judge some as the owner', async () => {
    const source = idOf('beta-idle');
    for (const [rule, scope] of [
      ['Rich rule: run the formatter before committing.', 'global'],
      ['Rich rule: never skip hooks.', 'global'],
      ['Rich rule: this repo uses bun, not npm.', 'repo'],
    ] as const)
      await asFerret(source, ['lesson', 'suggest', rule, '--scope', scope, '--json']);
    const listing = parseJsonText(await fyOk(['learning', 'ls', '--json']));
    const ids = collectIds(listing);
    if (ids[0] !== undefined) await fy(['learning', 'accept', ids[0]]);
    if (ids[1] !== undefined) await fy(['learning', 'reject', ids[1]]);
    made.richLessons = { proposals: ids.length };
  });

  // ── terminals, a browser profile, a second device, a catalog ───────────────────────────────────────────────────
  await opt('open terminals with output in several ferrets', async () => {
    const results: Record<string, string> = {};
    for (const [role, name, command] of [
      ['reviewer', 'build', 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "build step $i ok"; done; sleep 600'],
      ['reviewer', 'logs', 'echo "tailing logs"; sleep 600'],
      ['imager', 'shell', 'echo "hello from the shell"; pwd; sleep 600'],
      ['beta-idle', 'dev', 'echo "dev server on :3000"; sleep 600'],
    ] as const) {
      const ran = await fy(['terminal', 'open', name, command, '-s', idOf(role)], { timeoutMs: 40_000 });
      results[`${role}/${name}`] = ran.code === 0 ? 'open' : `refused: ${(ran.err || ran.out).trim().slice(0, 200)}`;
    }
    made.terminals = results;
    if (Object.values(results).every(value => value !== 'open')) throw new Error(JSON.stringify(results));
  });

  await opt('open a browser profile and a page (headless; local page only)', async () => {
    const ran = await fy(['browser', 'open', 'about:blank', '-s', idOf('reviewer')], { timeoutMs: 90_000 });
    if (ran.code !== 0)
      throw new Error(`fy browser open exited ${String(ran.code)}: ${(ran.err || ran.out).trim().slice(0, 300)}`);
    made.browser = { ferret: idOf('reviewer'), page: 'about:blank' };
  });

  await opt('pair a second device and narrow what it may do', async () => {
    const minted = await ctx.owner('POST', '/v1/pair/code');
    const body = minted.body as { daemonId?: string; code?: string };
    if (typeof body.daemonId !== 'string' || typeof body.code !== 'string')
      throw new Error('the mint answered without a code');
    ctx.addRedaction(body.code);
    const device = await ctx.pairDevice(body.daemonId, body.code, 'Fixture tablet');
    const grant = await fy(['device', 'grant', device.deviceId, 'terminal', '--no-use']);
    made.device2 = {
      id: device.deviceId,
      name: 'Fixture tablet',
      terminalGrant: grant.code === 0 ? 'use revoked' : (grant.err || grant.out).trim().slice(0, 160),
    };
  });

  await opt('make a catalog with a skill in it', async () => {
    await fyOk(['catalog', 'create', 'Rich team tools']);
    const added = await fy([
      'catalog',
      'add',
      'Rich team tools',
      '--skill',
      join(work, 'alpha', '.claude', 'skills', 'deploy-check', 'SKILL.md'),
      '--yes',
    ]);
    if (added.code !== 0) throw new Error((added.err || added.out).trim().slice(0, 240));
    made.catalog = 'Rich team tools';
  });

  cannot(
    'accounts with passwords and 2FA keys',
    'v4 types an account password at a hidden prompt and has no flag, pipe or variable that carries one, so a script cannot make an account',
  );
  cannot(
    'a ferret archived by the daemon',
    'archiving happens only a day after a ferret ended; nothing here may wait or edit a v4 file',
  );

  // ── the ferrets that need their pane left in a state, last (they stop answering further directions) ────────────
  await opt('leave a permission prompt and a question pending', async () => {
    await play(idOf('perm'), 'perm-1', {
      steps: [
        { user: 'Clean the build directory.' },
        { assistant: [{ type: 'text', text: 'I will remove the build output.' }] },
        {
          permission: {
            tool: 'Bash',
            input: { command: 'rm -rf build/', description: 'Remove build dir' },
            shown: 'rm -rf build/',
          },
        },
      ],
    });
    const running = ctx.existing.get('running');
    if (running !== undefined)
      await play(running.id, 'running-ask', {
        steps: [
          { user: 'Which fix should we apply to the failing test?' },
          { tool: { name: 'Bash', input: { command: 'bun test' }, result: '12 pass\n1 fail: parses dates' } },
          {
            ask: {
              questions: [
                {
                  header: 'Fix',
                  question: 'Which fix should I apply?',
                  multiSelect: false,
                  options: [
                    { label: 'Patch the parser', description: 'smallest change' },
                    { label: 'Rewrite the test', description: 'safer' },
                  ],
                },
              ],
              then: 'Applying it.',
            },
          },
        ],
      });
    made.pending = { permission: idOf('perm'), question: running?.id ?? null };
  });

  await opt("give the long-lived ferrets a reply, then kill the dead one's pane by tmux socket", async () => {
    await play(idOf('beta-idle'), 'beta-1', {
      steps: [
        { user: 'Anything to report?' },
        { assistant: [{ type: 'text', text: 'Nothing yet. The beta build is green.' }] },
      ],
    });
    await Bun.sleep(1500);
    // The tmux server is this builder's own (its socket is in the v4 home); the pane is found by the ferret's id.
    const panes = await ctx.tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_name}']);
    const target = panes.out.split('\n').find(line => line.includes(idOf('dead')));
    if (target === undefined) throw new Error('no tmux pane names the ferret that should die');
    const paneId = target.split('\t')[0] ?? '';
    const killed = await ctx.tmux(['kill-pane', '-t', paneId]);
    if (killed.code !== 0) throw new Error(`tmux kill-pane exited ${String(killed.code)}`);
    made.deadPane = idOf('dead');
  });

  await opt('record every ferret and the state v4 shows for it', async () => {
    const listing = parseJsonText((await fyOk(['ps', '--all', '--json'])) || '[]');
    const rows = Array.isArray(listing) ? listing : [];
    made.richFerrets = rows.flatMap(row => {
      if (!isRecord(row)) return [];
      const config = isRecord(row.config) ? row.config : {};
      const state = isRecord(row.state) ? row.state : {};
      return [
        {
          id: typeof config.id === 'string' ? config.id : null,
          name: typeof config.name === 'string' ? config.name : null,
          status: typeof state.status === 'string' ? state.status : (findString(row, ['status']) ?? null),
          mode: typeof config.mode === 'string' ? config.mode : null,
        },
      ];
    });
  });
  made.roles = Object.fromEntries([...ctx.existing, ...ferrets].map(([role, record]) => [role, record.id]));
}

// ─── small readers (the daemon's answer shapes are not a contract) ──────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJsonList(text: string): unknown {
  return parseJsonText(text) ?? text.trim().slice(0, 400);
}

function findString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (depth > 6 || typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string;
  for (const nested of Object.values(record)) {
    const found = findString(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findId(text: string): string | undefined {
  return findString(parseJsonText(text), ['id']) ?? /\b([BFIC][1-9][0-9]*)\b/u.exec(text)?.[1];
}

function collectIds(value: unknown, depth = 0): string[] {
  if (depth > 6 || typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.id === 'string' ? [record.id] : [];
  return [...own, ...Object.values(record).flatMap(nested => collectIds(nested, depth + 1))];
}

/** Lane names in the order the daemon lists them. */
function collectNames(value: unknown, depth = 0): string[] {
  if (depth > 6 || typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.name === 'string' && typeof record.id === 'string' ? [record.name] : [];
  return [...own, ...Object.values(record).flatMap(nested => collectNames(nested, depth + 1))];
}

export type { Ran };
