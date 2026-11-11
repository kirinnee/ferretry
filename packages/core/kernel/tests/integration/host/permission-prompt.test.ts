import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Runners } from '../../../../ferrets/contract/index.ts';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/** Ferrets' job that arms the turn watch (its contract does not export the id; the host lists it). */
const TURN_WATCH_JOB = 'ferrets.turn-watch';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

/**
 * ANSWERING WHAT A FERRET IS STOPPED ON, FOR EITHER HARNESS, through the daemon: the REAL Ferrets and the REAL Claude Code
 * (and Codex) halves, as the generated registry builds them. ONE table of harnesses drives the SAME flow for each, so a
 * harness cannot silently drop out:
 *
 *   - a runner whose look carries a permission prompt becomes the ferret's recorded request, and
 *     `GET /v1/ferrets/:id/prompt` serves it;
 *   - `POST /v1/ferrets/:id/permission` and `/dialog` answer THAT prompt on the ferret's own pane, through Ferrets' form
 *     seam (the runner's guarded read and key), never through a pane id this plugin remembered: so the very same answer
 *     works after a daemon restart, for a pane that was already running;
 *   - an answer for a prompt the pane no longer shows is refused 409 and presses NOTHING.
 *
 * The pane is the FakeRunner's form screen: real fixture frames (v4's captured panes), a cursor that moves with Up and
 * Down, and Enter or Escape that ends the prompt. CI only (integration tier). Fixture values only.
 */

const PLUGINS = join(import.meta.dir, '../../../../../plugins/claude-code/tests/fixtures');
const fixture = (folder: string, name: string): string => readFileSync(join(PLUGINS, folder, `${name}.txt`), 'utf8');

const IDLE = '❯ \n  ? for shortcuts';

/** The row marker, the digit, and the rest of a numbered choice row in either harness's list. */
const ROW = /^(\s*)([❯›>]\s)?(\d)([.)]\s.*)$/u;

/** Moves the cursor of the numbered list in `frame` by `by` rows (what Up and Down do in both harnesses). */
function moveCursor(frame: string, by: number): string {
  const lines = frame.split('\n');
  const rows = lines.map(line => ROW.exec(line));
  const marker = rows.find(row => row?.[2] !== undefined)?.[2];
  const at = rows.find(row => row?.[2] !== undefined)?.[3];
  if (marker === undefined || at === undefined) return frame;
  const target = Number(at) + by;
  return lines
    .map((line, index) => {
      const row = rows[index];
      if (row === null || row === undefined) return line;
      const [, lead = '', cursor = '', digit = '', rest = ''] = row;
      const width = lead.length + cursor.length;
      const prefix = Number(digit) === target ? ' '.repeat(width - marker.length) + marker : ' '.repeat(width);
      return `${prefix}${digit}${rest}`;
    })
    .join('\n');
}

interface Row {
  readonly harness: 'claude-code' | 'codex';
  /** The permission screen, and a different prompt for staleness. */
  readonly permission: string;
  readonly otherPermission: string;
  /**
   * The request as the runner's look reports it (the runner parses the screen; the harness is spelled as the state
   * document spells it, and the id digests that spelling): measured off `permission` with the plugin's parser.
   */
  readonly request: Record<string, unknown> & { readonly id: string };
  /** The dialog screen, and the id Ferrets records for it (the one a card answers with). */
  readonly dialog: string;
  readonly dialogId: string;
  /** The wrapper the harness's own half locates (`which`). */
  readonly program: string;
}

const ROWS: readonly Row[] = [
  {
    harness: 'claude-code',
    permission: fixture('permission-prompts', 'claude-2.1.281-read-outside'),
    otherPermission: fixture('permission-prompts', 'claude-2.1.281-bash'),
    request: {
      id: '15e254453e01352b',
      harness: 'claude',
      tool: 'Read',
      action: 'read',
      what: '/etc/hostname',
      question: 'Do you want to proceed?',
      options: [
        { number: 1, label: 'Yes', kind: 'allow' },
        { number: 2, label: 'Yes, allow reading from /etc during this session', kind: 'allow-always' },
        { number: 3, label: 'No', kind: 'deny' },
      ],
      selected: 1,
    },
    dialog: fixture('harness-dialogs', 'claude-2.1.220-settings-error'),
    dialogId: 'd22104f390283939',
    program: 'claude',
  },
  {
    harness: 'codex',
    permission: fixture('codex-permission-prompts', 'codex-0.164.0-shell'),
    otherPermission: fixture('codex-permission-prompts', 'codex-0.164.0-patch'),
    request: {
      id: 'ccff5fdd35ea83f3',
      harness: 'codex',
      tool: 'Shell',
      action: 'run',
      what: 'rm -rf build',
      detail: 'Clean the build output',
      question: 'Would you like to run the following command?',
      options: [
        { number: 1, label: 'Yes, proceed', kind: 'allow' },
        {
          number: 2,
          label: "Yes, and don't ask again for commands that start with `rm -rf build`",
          kind: 'allow-always',
        },
        { number: 3, label: 'No, and tell Codex what to do differently', kind: 'deny' },
      ],
      selected: 1,
    },
    dialog: fixture('codex-harness-dialogs', 'codex-0.156.1-hooks-review'),
    dialogId: 'e3ccf65a20753a84',
    program: 'codex',
  },
];

/**
 * The test host's in-memory roots name a scope's own folder with a trailing slash (`/agent-homes/<ferret>/`), which
 * Ferrets and Codex refuse as a home (a canonical home has none, as a real root names it). So the half sees the same
 * roots with that one spelling made canonical; everything else it asks of them is the host's own.
 */
const canonicalHomes = (half: ReturnType<typeof real>) =>
  ({
    ...half,
    build: (ctx: Parameters<NonNullable<typeof half.build>>[0]) => {
      const build = half.build;
      if (build === undefined) throw new Error(`the ${half.manifest.id} daemon half has no build`);
      const roots = {
        ...ctx.kernel.roots,
        root: (...args: Parameters<typeof ctx.kernel.roots.root>) => {
          const handle = ctx.kernel.roots.root(...args);
          return {
            ...handle,
            // The in-memory root also takes only relative names, where a real root takes the absolute path of a folder
            // inside it: the root's own absolute path is its own folder, as a real root reads it.
            resolve: (relative: string) => {
              const own = handle.resolve('');
              const itself =
                own.ok && relative !== '' && relative.replace(/\/+$/u, '') === String(own.value).replace(/\/+$/u, '');
              const resolved = handle.resolve(itself ? '' : relative);
              return resolved.ok
                ? { ...resolved, value: String(resolved.value).replace(/\/+$/u, '') as never }
                : resolved;
            },
          };
        },
      };
      return build({ ...ctx, kernel: { ...ctx.kernel, roots } });
    },
  }) as typeof half;

/**
 * The answer routes are Claude Code's, for EITHER harness. A real host loads both harness halves, each with roots scoped
 * to itself; this test host's in-memory roots are not scoped, so the two would name the same home for a ferret and Ferrets
 * would refuse the start. So the harness NOT under test is left out of the ferret's launch: the Claude Code half is
 * loaded for its routes alone (its `harnesses:claude-code` hook dropped) when the Codex harness is the one running.
 */
const routesOnly = (half: ReturnType<typeof real>) =>
  ({
    ...half,
    build: (ctx: Parameters<NonNullable<typeof half.build>>[0]) => {
      const built = half.build?.(ctx);
      if (built === undefined) throw new Error(`the ${half.manifest.id} daemon half has no build`);
      const { hooks, ...rest } = built as { hooks?: Record<string, unknown> };
      const kept = Object.fromEntries(Object.entries(hooks ?? {}).filter(([key]) => !key.startsWith('harnesses:')));
      return { ...rest, hooks: kept };
    },
  }) as typeof half;

/** The machine the halves ask about: any `claude`/`codex` is found and starts. */
const spawnOf = (program: string) => {
  const done = (exitCode: number, stdout = '') => ({ exitCode, signal: null, stdout, stderr: '' });
  return async (name: string, args: readonly string[]) => {
    if (name === 'printenv') return done(0, '/home/kirin\n');
    if (name === 'uname') return done(0, 'Linux\n');
    if (name === 'which') return done(0, `/usr/local/bin/${program}\n`);
    if (args[0] === '--version')
      return done(0, program === 'claude' ? '2.1.281 (Claude Code)\n' : 'codex-cli 0.164.0\n');
    return done(1);
  };
};

interface World {
  readonly host: TestHost;
  readonly runner: FakeRunner;
  readonly id: string;
  /** Redraws the pane: the screen the ferret is on. */
  show(frame: string): void;
}

/** A host with a ferret of `row.harness` running, on a FakeRunner whose pane shows `row`'s screens. */
async function boot(row: Row): Promise<World> {
  const runner = new FakeRunner();
  const host = await testHost({
    plugins:
      row.harness === 'codex'
        ? [real('ferrets'), routesOnly(real('claude-code')), canonicalHomes(real('codex')), runnerPlugin(runner)]
        : [real('ferrets'), canonicalHomes(real('claude-code')), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    spawn: spawnOf(row.program),
  });
  const started = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Work.', harness: row.harness },
  });
  if (started.status >= 300) throw new Error(started.body + JSON.stringify(host.logs.slice(-12)));
  await host.settle();
  const world: World = {
    host,
    runner,
    id: started.json<{ id: string }>().id,
    show: frame => {
      runner.form = { alive: true, dead: false, promptReady: false, activeWork: false, visible: frame, history: frame };
    },
  };
  // The pane reacts to the keys as a harness's list does: arrows move the cursor, Enter and Escape end the prompt.
  runner.onFormWrite = ({ key }) => {
    const shown = runner.form?.visible ?? '';
    if (key === 'Down') world.show(moveCursor(shown, 1));
    else if (key === 'Up') world.show(moveCursor(shown, -1));
    else if (key === 'Enter' || key === 'Escape') world.show(IDLE);
  };
  return world;
}

/**
 * Posts an answer and drives the daemon's clock until it is in (the answer re-reads the pane on that clock): beat by beat,
 * not for a fixed number of beats, because how many beats the guarded read and key take is the host's, not this test's.
 */
async function answer(host: TestHost, path: string, body: unknown) {
  const posting = host.request('POST', path, { body });
  let done = false;
  void posting.then(
    () => (done = true),
    () => (done = true),
  );
  for (let beat = 0; beat < 200 && !done; beat += 1) {
    await host.clock.advance(200);
    await host.settle();
  }
  return await posting;
}

const keysOf = (runner: FakeRunner): string[] => runner.formKeys.map(press => press.key);

/** The same frame with its cursor glyph undrawn: every label and the request's identity kept (a redraw that lost the marker). */
const markerless = (frame: string): string => frame.replace(/^(\s*)[❯›>]\s(?=[1-9][.)])/gmu, '$1  ');

describe.each(ROWS)('what a $harness ferret is stopped on, through the real halves', row => {
  const { request } = row;
  const dialog = { id: row.dialogId };

  test('the prompt route serves the recorded request, and the permission POST answers exactly that request', async () => {
    const { host, runner, id, show } = await boot(row);
    await host.runJob(TURN_WATCH_JOB);
    await host.settle();

    const before = await host.request('GET', `/v1/ferrets/${id}/prompt`);
    expect([before.status, before.json()]).toEqual([200, {}]);

    show(row.permission);
    runner.screens.set('%1' as never, {
      frame: 'permission-1',
      working: false,
      atPrompt: false,
      permission: true,
      request: request as never,
    });
    for (let beat = 0; beat < 30; beat += 1) {
      await host.clock.advance(2_000);
      await host.settle();
      const seen = await host.request('GET', `/v1/ferrets/${id}/prompt`);
      if (seen.json<{ turnState?: string }>().turnState !== undefined) break;
    }
    const asked = await host.request('GET', `/v1/ferrets/${id}/prompt`);
    expect(asked.status).toBe(200);
    expect(asked.json()).toMatchObject({ turnState: 'needs-input', permissionRequest: { id: request.id } });

    // The card answers with the id Ferrets recorded; the second row is chosen, so the cursor really has to move.
    const answered = await answer(host, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: request.id,
      number: 2,
    });
    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ requestId: request.id, cleared: true });
    expect(keysOf(runner)).toEqual(['Down', 'Enter']);
    expect(runner.formPastes).toEqual([]);
  });

  test('a deny presses Escape alone', async () => {
    const { host, runner, id, show } = await boot(row);
    show(row.permission);

    const answered = await answer(host, `/v1/ferrets/${id}/permission`, { kind: 'deny', requestId: request.id });

    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ requestId: request.id, cleared: true });
    expect(keysOf(runner)).toEqual(['Escape']);
  });

  test('allow on the row the cursor already holds presses Enter alone', async () => {
    const { host, runner, id, show } = await boot(row);
    show(row.permission);

    const answered = await answer(host, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: request.id,
      number: 1,
    });

    expect(answered.status).toBe(200);
    expect(keysOf(runner)).toEqual(['Enter']);
  });

  test('the dialog is answered by choosing a row, and by Escape', async () => {
    const { host, runner, id, show } = await boot(row);
    show(row.dialog);

    const chosen = await answer(host, `/v1/ferrets/${id}/dialog`, { kind: 'choice', dialogId: dialog.id, number: 2 });

    expect(chosen.status).toBe(200);
    expect(chosen.json()).toEqual({ dialogId: dialog.id, cleared: true });
    expect(keysOf(runner)).toEqual(['Down', 'Enter']);

    runner.formKeys.length = 0;
    show(row.dialog);
    const escaped = await answer(host, `/v1/ferrets/${id}/dialog`, { kind: 'escape', dialogId: dialog.id });

    expect(escaped.status).toBe(200);
    expect(keysOf(runner)).toEqual(['Escape']);
  });

  test('a stale prompt is refused 409 and nothing is pressed: another prompt on the pane, or none', async () => {
    const { host, runner, id, show } = await boot(row);

    show(row.otherPermission);
    const other = await answer(host, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: request.id,
      number: 1,
    });
    show(IDLE);
    const none = await answer(host, `/v1/ferrets/${id}/permission`, { kind: 'deny', requestId: request.id });
    show(row.permission);
    const forged = await answer(host, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: 'ffffffffffffffff',
      number: 1,
    });
    show(IDLE);
    const dialogGone = await answer(host, `/v1/ferrets/${id}/dialog`, { kind: 'escape', dialogId: dialog.id });

    expect([other.status, other.json<{ code: string }>().code]).toEqual([409, 'permission_prompt_gone']);
    expect([none.status, none.json<{ code: string }>().code]).toEqual([409, 'permission_prompt_gone']);
    expect([forged.status, forged.json<{ code: string }>().code]).toEqual([409, 'permission_prompt_gone']);
    expect([dialogGone.status, dialogGone.json<{ code: string }>().code]).toEqual([409, 'harness_dialog_gone']);
    expect(runner.formKeys).toEqual([]);
  });

  test('after a daemon restart the same pane is still answered: no pane is remembered by the harness', async () => {
    const { host, runner, id, show } = await boot(row);
    show(row.permission);
    const restarted = await host.restart();
    await restarted.settle();

    const answered = await answer(restarted, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: request.id,
      number: 2,
    });

    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ requestId: request.id, cleared: true });
    expect(keysOf(runner)).toEqual(['Down', 'Enter']);
  });

  // The cursor is never guessed: Enter confirms whichever row the harness's list is REALLY on, so every Enter needs exactly one
  // cursor row positively read on the chosen row (reviewer's probes for rebuild/perm-codex 872d2bab8e).
  test('a frame with no cursor glyph is refused 409 before any key: the live row is not guessed to be 1', async () => {
    const { host, runner, id, show } = await boot(row);
    // The live list is on row 2 ("allow always"); the captured frame shows no cursor. Choosing 1 must not press Enter.
    let committed: number | undefined;
    show(markerless(row.permission));
    runner.onFormWrite = ({ key }) => {
      if (key === 'Enter') {
        committed = 2;
        show(IDLE);
      }
    };

    const answered = await answer(host, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: request.id,
      number: 1,
    });

    expect([answered.status, answered.json<{ code: string }>().code]).toEqual([409, 'permission_cursor_unknown']);
    expect({ committed, keys: keysOf(runner), pastes: runner.formPastes }).toEqual({
      committed: undefined,
      keys: [],
      pastes: [],
    });
  });

  test('a dropped Up and a markerless redraw never prove the cursor arrived: no Enter', async () => {
    const { host, runner, id, show } = await boot(row);
    // Start on row 3, choose 1: one Up is lost, the live list sits on row 2 and redraws without its glyph.
    show(moveCursor(moveCursor(row.permission, 1), 1));
    let committed: number | undefined;
    runner.onFormWrite = ({ key }) => {
      if (key === 'Up') show(markerless(row.permission));
      if (key === 'Enter') {
        committed = 2;
        show(IDLE);
      }
    };

    const answered = await answer(host, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: request.id,
      number: 1,
    });

    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ requestId: request.id, cleared: false });
    expect({ committed, keys: keysOf(runner) }).toEqual({ committed: undefined, keys: ['Up', 'Up'] });
  });

  test('two cursor rows are an unknown cursor too: refused before any key', async () => {
    const { host, runner, id, show } = await boot(row);
    const glyph = /^(\s*)([❯›>])\s(?=1[.)])/mu.exec(row.permission)?.[2] ?? '>';
    // A stale marker left on row 1 while the cursor drew on row 2.
    show(moveCursor(row.permission, 1).replace(/^(\s*)\s\s(?=1[.)])/mu, `$1${glyph} `));

    const answered = await answer(host, `/v1/ferrets/${id}/permission`, {
      kind: 'choice',
      requestId: request.id,
      number: 1,
    });

    expect([answered.status, answered.json<{ code: string }>().code]).toEqual([409, 'permission_cursor_unknown']);
    expect(runner.formKeys).toEqual([]);
  });

  test('a dialog with no cursor glyph is refused 409 and nothing is pressed', async () => {
    const { host, runner, id, show } = await boot(row);
    show(markerless(row.dialog));

    const chosen = await answer(host, `/v1/ferrets/${id}/dialog`, { kind: 'choice', dialogId: dialog.id, number: 1 });

    expect([chosen.status, chosen.json<{ code: string }>().code]).toEqual([409, 'harness_dialog_gone']);
    expect(runner.formKeys).toEqual([]);
  });

  test('a ferret with no live pane answers 409 pane_unknown and presses nothing', async () => {
    const { host, runner, id } = await boot(row);
    runner.form = undefined;

    const answered = await answer(host, `/v1/ferrets/${id}/permission`, { kind: 'deny', requestId: request.id });

    expect([answered.status, answered.json<{ code: string }>().code]).toEqual([409, 'pane_unknown']);
    expect(runner.formKeys).toEqual([]);
  });
});
