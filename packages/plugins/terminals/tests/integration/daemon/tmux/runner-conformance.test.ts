import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { RunnerHandle, RunSpec } from '@ferretry/core-ferrets/contract';
import { emptyChildEnvironment, fenced, ferretId, runnerConformance } from '@ferretry/core-ferrets/contract/testing';
import type { InputHolds } from '@ferretry/kernel/contract';
import { testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';
import { FakeTmuxServer } from '../support/fake-tmux-server.ts';
import { scriptWords } from '../support/script-words.ts';

/** One pane of the in-memory tmux world: its facts, and the composer model that answers its reads and keys. */
interface WorldPane {
  readonly id: string;
  readonly pid: number;
  readonly session: string;
  readonly created: number;
  /** What `#{pane_current_command}` answers: a launch's wrappers exec one into the next at this one pid. */
  command: string;
  /** Programs the next facts reads answer before `command`, one per read (a launch still exec'ing its wrappers). */
  readonly launching: string[];
  /** Called before each guarded write lands, with its index from 0 (a program that changes under the cursor). */
  beforeWrite?: (index: number) => void;
  /** Guarded writes seen so far. */
  writes: number;
  readonly server: FakeTmuxServer;
}

const done = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const refused = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });
const PAYLOAD_WRITES = new Set(['send-keys', 'paste-buffer', 'load-buffer']);

/**
 * The real `TmuxRunner` over an in-memory tmux server of several panes, so the Ferrets runner conformance suite holds
 * the runner itself to the contract, not only `FakeRunner`. No tmux process, shell or spawn runs: the launch script is
 * decoded and answered here, every pane is a `FakeTmuxServer` composer, and every write the runner makes must arrive
 * through the server-side guard (`if-shell`) — a raw payload write throws.
 */
function tmuxWorld() {
  const panes = new Map<string, WorldPane>();
  let next = 10;
  let starts = 0;

  const add = (session: string, command: string): WorldPane => {
    next += 1;
    const pane: WorldPane = {
      id: `%${next}`,
      pid: 4000 + next,
      session,
      created: 1_000 + next,
      command,
      launching: [],
      writes: 0,
      server: new FakeTmuxServer(),
    };
    panes.set(pane.id, pane);
    return pane;
  };
  /** The pane a `-t` names: a pane id, or the session it is the active pane of. */
  const target = (args: readonly string[]): WorldPane | undefined => {
    const named = args[args.indexOf('-t') + 1] ?? '';
    return panes.get(named) ?? [...panes.values()].find(pane => pane.session === named);
  };
  const cursorRow = ({ server }: WorldPane): number =>
    server.transcript.split('\n').length +
    (server.modal?.split('\n').length ?? 0) +
    (server.working ? 1 : 0) +
    server.composer.split('\n').length -
    1;
  const live = (pane: WorldPane, read = false): Record<string, string> => ({
    pane_id: pane.id,
    pane_pid: String(pane.pid),
    pane_dead: pane.server.dead ? '1' : '0',
    pane_current_command: (read ? pane.launching.shift() : undefined) ?? pane.command,
    cursor_y: String(cursorRow(pane)),
    session_name: pane.session,
    session_created: String(pane.created),
  });

  const execute = async (args: readonly string[], stdin?: string): Promise<TmuxCommandResult> => {
    const command = args[0] ?? '';
    if (command === 'start-server') return done();
    if (command === 'show-options') return done('\n');
    if (command === 'set-option') return done();
    const pane = target(args);
    if (command === 'has-session') return pane === undefined ? refused("can't find session") : done();
    if (pane === undefined) return refused("can't find pane");
    if (command === 'kill-session') {
      panes.delete(pane.id);
      return done();
    }
    if (command === 'display-message' && args.at(-1)?.startsWith('#{pane_id}|')) {
      const facts = live(pane, true);
      return done(
        `${facts.pane_id}|${facts.pane_pid}|${facts.pane_dead}|${facts.session_name}|${facts.session_created}|${facts.pane_current_command}|${facts.cursor_y}\n`,
      );
    }
    if (command === 'if-shell') {
      pane.beforeWrite?.(pane.writes);
      pane.writes += 1;
      const comparisons = [...(args[4] ?? '').matchAll(/#\{==:#\{(\w+)\},([^}]*)\}/gu)];
      const facts = live(pane);
      if (comparisons.length === 0 || !comparisons.every(([, key = '', value]) => facts[key] === value))
        return done('fy-input-guard-refused\n');
      const write = scriptWords(args[5] ?? '');
      return write[0] === 'set-buffer'
        ? await pane.server.execute(['load-buffer', '-b', write[2] ?? '', '-'], write.at(-1))
        : await pane.server.execute(write);
    }
    if (PAYLOAD_WRITES.has(command)) throw new Error('every write a delivery or a stop makes must be guarded');
    return await pane.server.execute(args, stdin);
  };

  const holds: InputHolds = { decide: () => 'allow' };
  const runner = new TmuxRunner({
    tmux: { execute },
    spawn: {
      // The launch script, decoded: `set-option`, `new-session … -s <session> -c <cwd> -- <program> …`, `set-option`.
      run: async (_program, _args, options) => {
        const stdin = options?.stdin ?? '';
        const script = typeof stdin === 'string' ? stdin : new TextDecoder().decode(stdin);
        const lines = script.split('\n').filter(line => line.trim() !== '');
        const created = lines.map(scriptWords).find(words => words[0] === 'new-session');
        if (created === undefined) return { exitCode: 1, signal: null, stdout: '', stderr: 'no new-session' };
        const session = created[created.indexOf('-s') + 1] ?? '';
        const program = created[created.indexOf('--') + 1] ?? '';
        starts += 1;
        const pane = add(session, program);
        return { exitCode: 0, signal: null, stdout: `${pane.id}|${pane.pid}\n`, stderr: '' };
      },
      runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
      start: () => {
        throw new Error('the fixture starts nothing');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
    delivery: {
      act: testActRunner({ holds: () => holds, actor: () => 'ferret', minted: new TestMintedIds(), record: () => {} }),
      sleep: async ms => {
        for (const pane of panes.values()) pane.server.advance(ms);
      },
    },
  });

  const paneOf = (handle: RunnerHandle): WorldPane => {
    const pane = panes.get(handle);
    if (pane === undefined) throw new Error(`no pane ${handle} in the fixture`);
    return pane;
  };
  return {
    runner,
    paneOf,
    spec: { ferret: ferretId('f1'), command: ['harness'], cwd: fenced('/work'), env: emptyChildEnvironment() },
    // A ferret pane a previous daemon started: it is in the server, and this runner never launched it.
    adoptable: async () => add('fy-f0', 'harness').id as RunnerHandle,
    starts: () => starts,
    stopPane: {
      working: (handle: RunnerHandle, working: boolean) => {
        paneOf(handle).server.working = working;
      },
      keys: (handle: RunnerHandle) =>
        paneOf(handle)
          .server.calls.filter(call => call[0] === 'send-keys')
          .map(call => call.at(-1) ?? ''),
    },
  };
}

runnerConformance('TmuxRunner (in-memory tmux server)', tmuxWorld);

describe('registered plugin screen reader through the guarded runner', () => {
  it('delivers once using the registered reader, and refuses unsupported native queue keys', async () => {
    const world = tmuxWorld();
    let server: FakeTmuxServer | undefined;
    const started = await world.runner.start({
      ...world.spec,
      harness: 'opencode',
      execChain: ['harness'],
      screenReader: {
        key: 'opencode',
        read: () => ({
          working: server?.working ?? false,
          atPrompt: !server?.working,
          composer: { text: server?.composer ?? '', placeholder: false, pasted: false },
        }),
      },
    });
    if (!started.ok) throw new Error('fixture launch refused');
    const pane = world.paneOf(started.value.handle);
    server = pane.server;
    expect(await world.runner.deliver(started.value.handle, { text: 'hello' })).toBe('turn-started');
    expect(server.submitted).toEqual(['hello']);
    const writes = pane.writes;
    await expect(world.runner.queue(started.value.handle, 'next')).rejects.toThrow('no native queue');
    expect(pane.writes).toBe(writes);
  });

  it('a mismatched reader is never called and legacy-looking text sends no payload keys', async () => {
    const world = tmuxWorld();
    let reads = 0;
    const started = await world.runner.start({
      ...world.spec,
      harness: 'opencode',
      execChain: ['harness'],
      screenReader: {
        key: 'codex',
        read: () => {
          reads++;
          return { working: false, atPrompt: true, composer: { text: '', placeholder: false, pasted: false } };
        },
      },
    });
    if (!started.ok) throw new Error('fixture launch refused');
    await expect(world.runner.deliver(started.value.handle, { text: 'hello' })).rejects.toThrow();
    expect(reads).toBe(0);
    expect(world.paneOf(started.value.handle).writes).toBe(0);
  });
});

/** The spec of a Codex launch: it execs `env`, the interpreter its installed script runs on, then the harness. */
const codexSpec = (spec: RunSpec): RunSpec => ({ ...spec, execChain: ['env', 'bash', 'sh', 'node', 'harness'] });

/** The spec of a Claude launch: it execs `env`, the seed shell, then the harness (named `harness` in this world). */
const claudeSpec = (spec: RunSpec): RunSpec => ({ ...spec, execChain: ['env', 'sh', 'harness'] });

describe("TmuxRunner first turn at a pane still exec'ing its launch wrappers", () => {
  it('should type the first turn when the program goes tmux → systemd-run → the harness at one pid after it bound', async () => {
    // The P0 on a host with a user manager: `systemd-run --user --scope` takes ~60 ms to exec the harness, so the
    // delivery's first reads saw `systemd-run` and pinned it; the harness's own frame then read as a pane no longer live.
    // Arrange
    const world = tmuxWorld();
    const started = await world.runner.start(claudeSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('tmux', 'systemd-run', 'ionice', 'env');

    // Act
    const delivered = await world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    expect(delivered).toBeDefined();
    expect(pane.launching).toEqual([]);
    expect(pane.server.submitted).toEqual(['Reply with the single word OK.']);
  });

  it('should keep waiting through the launch wrappers and type the first turn once the expected harness runs', async () => {
    // Arrange
    const world = tmuxWorld();
    const started = await world.runner.start(claudeSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('tmux', 'env', 'systemd-run', 'ionice', 'systemd-run');

    // Act
    const delivered = await world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    expect(delivered).toBeDefined();
    expect(pane.server.submitted).toEqual(['Reply with the single word OK.']);
  });

  it('should type a Codex first turn once its wrappers and its script interpreter have given way to the harness', async () => {
    // Arrange — measured on a real limited launch: tmux → systemd-run → bash (the installed script) → codex.
    const world = tmuxWorld();
    const started = await world.runner.start(codexSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('tmux', 'systemd-run', 'bash', 'bash');

    // Act
    const delivered = await world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    expect(delivered).toBeDefined();
    expect(pane.server.submitted).toEqual(['Reply with the single word OK.']);
  });

  it('should refuse a Codex first turn, and type nothing, when the launch ends in a shell outside its chain', async () => {
    // Arrange
    const world = tmuxWorld();
    const started = await world.runner.start(codexSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('systemd-run');
    pane.command = 'zsh';

    // Act
    const delivered = world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    await expect(delivered).rejects.toThrow();
    expect(pane.writes).toBe(0);
    expect(pane.server.submitted).toEqual([]);
  });

  it('should refuse the first turn, and type nothing, when the launch ends in a shell instead of the harness', async () => {
    // Arrange — the wrappers ran and the harness exited at once: the pane is left at a shell.
    const world = tmuxWorld();
    const started = await world.runner.start(claudeSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('systemd-run');
    pane.command = 'bash';

    // Act
    const delivered = world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    await expect(delivered).rejects.toThrow();
    expect(pane.server.submitted).toEqual([]);
    expect(pane.server.calls.some(call => PAYLOAD_WRITES.has(call[0] ?? ''))).toBe(false);
    expect(pane.writes).toBe(0);
  });

  it('should refuse the first turn when the launch ends in a program other than the one it launched', async () => {
    // Arrange
    const world = tmuxWorld();
    const started = await world.runner.start(claudeSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('env', 'systemd-run');
    pane.command = 'node';

    // Act
    const delivered = world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    await expect(delivered).rejects.toThrow();
    expect(pane.writes).toBe(0);
  });

  it("should keep waiting through the seed shell that Claude is exec'd from", async () => {
    // Arrange
    const world = tmuxWorld();
    const started = await world.runner.start(claudeSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('systemd-run', 'env', 'sh', 'sh');

    // Act
    const delivered = await world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    expect(delivered).toBeDefined();
    expect(pane.server.submitted).toEqual(['Reply with the single word OK.']);
  });

  it('should not adopt a launch step for a spec that named no exec chain (Codex)', async () => {
    // Arrange — a pane bound at a wrapper, with no chain to say what it should become, is bound as it always was.
    const world = tmuxWorld();
    const started = await world.runner.start(world.spec);
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('systemd-run');

    // Act
    const delivered = world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    await expect(delivered).rejects.toThrow();
    expect(pane.writes).toBe(0);
    expect(pane.server.submitted).toEqual([]);
  });

  it('should not adopt a program change on a pane that was bound to a stable program', async () => {
    // Arrange — no launch wrapper ever showed: the pane is bound to its harness and anything else is refused (Codex, a
    // pane adopted from an earlier daemon, every later delivery).
    const world = tmuxWorld();
    const started = await world.runner.start(world.spec);
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.launching.push('harness', 'bash');

    // Act
    const delivered = world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    await expect(delivered).rejects.toThrow();
    expect(pane.writes).toBe(0);
    expect(pane.server.submitted).toEqual([]);
  });

  it('should refuse the next write when the program changes after the first key really landed', async () => {
    // Arrange — the first write lands; the harness execs something else under the cursor before the next one.
    const world = tmuxWorld();
    const started = await world.runner.start(claudeSpec(world.spec));
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.beforeWrite = index => {
      if (index === 1) pane.command = 'vim';
    };

    // Act
    const delivered = world.runner.deliver(started.value.handle, { text: 'Reply with the single word OK.' });

    // Assert
    await expect(delivered).rejects.toThrow();
    expect(pane.writes).toBeGreaterThanOrEqual(2);
    expect(pane.server.submitted).toEqual([]);
  });
});

describe('TmuxRunner startup dialogs answer only the REGISTERED harness (a screen never picks the family)', () => {
  const FIXTURES = join(import.meta.dir, '../../../fixtures');
  const codexUpdate = (): string =>
    readFileSync(join(FIXTURES, 'harness-dialogs', 'codex-0.156.1-update.txt'), 'utf8').trimEnd();
  const claudeTrust = (): string =>
    readFileSync(join(FIXTURES, 'startup-dialogs', 'claude-2.1.281-folder-trust.txt'), 'utf8').trimEnd();

  /** A pane parked on `screen`, launched by a harness registered under `harness`; delivery then tries a first turn. */
  async function parkedOn(screen: string, harness: string | undefined, chain: RunSpec['execChain']) {
    const world = tmuxWorld();
    const spec = { ...world.spec, execChain: chain, ...(harness === undefined ? {} : { harness }) };
    const started = await world.runner.start(spec);
    if (!started.ok) throw new Error('the fixture pane did not start');
    const pane = world.paneOf(started.value.handle);
    pane.server.modalReplacesComposer = true;
    pane.server.modal = screen;
    const delivered = await world.runner.deliver(started.value.handle, { text: 'hello' }).then(
      () => 'delivered',
      () => 'refused',
    );
    return { pane, delivered };
  }

  it('should press NO key on a fake third harness that paints Codex’s update prompt (its key has no family row)', async () => {
    const { pane, delivered } = await parkedOn(codexUpdate(), 'fake-third', ['env', 'sh', 'harness']);

    expect(delivered).toBe('refused');
    expect(pane.writes).toBe(0);
  });

  it('should press NO key on a third harness registered under the family word `claude`, whatever its screen says', async () => {
    const { pane, delivered } = await parkedOn(claudeTrust(), 'claude', ['env', 'sh', 'harness']);

    expect(delivered).toBe('refused');
    expect(pane.writes).toBe(0);
  });

  it('should press NO key on a pane no launch named a harness for', async () => {
    const { pane, delivered } = await parkedOn(codexUpdate(), undefined, ['env', 'sh', 'harness']);

    expect(delivered).toBe('refused');
    expect(pane.writes).toBe(0);
  });

  it('should still answer Codex’s update prompt and Claude’s folder trust for the harnesses registered as those', async () => {
    const codex = await parkedOn(codexUpdate(), 'codex', ['env', 'bash', 'sh', 'node', 'harness']);
    const claude = await parkedOn(claudeTrust(), 'claude-code', ['env', 'sh', 'harness']);

    expect(codex.pane.writes).toBeGreaterThan(0);
    expect(claude.pane.writes).toBeGreaterThan(0);
  });
});
