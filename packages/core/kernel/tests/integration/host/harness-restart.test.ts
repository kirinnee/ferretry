import { expect, test } from 'bun:test';
import { stripVTControlCharacters } from 'node:util';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { FakeGate } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { FerretFiles, FerretsPort } from '../../../../ferrets/contract/index.ts';
import { ferretId, T0 } from '../../../../ferrets/contract/testing/index.ts';
import { implementDaemon } from '../../../manifest/index.ts';
import { nodeHostFacts } from '../../../host/adapters/host-facts.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { fixedClock, testHost } from '../../../testing/index.ts';

const real = (id: string) => {
  const found = daemonImplementations.find(plugin => plugin.manifest.id === id);
  if (found === undefined) throw new Error(`no registered ${id} daemon`);
  return found;
};

/** Decode tmux's stdin command language in memory; nothing here runs a shell or starts tmux. */
function words(script: string): string[] {
  const result: string[] = [];
  let word = '',
    quote = '',
    started = false;
  for (let i = 0; i < script.length; i++) {
    const char = script[i] ?? '';
    if (quote !== '') {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\') {
        const next = script[++i];
        word += next === 'n' ? '\n' : next === 'r' ? '\r' : next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) result.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) result.push(word);
  return result;
}

async function restartedPane(harness: string, ink: 'typed' | 'placeholder' | 'unknown' = 'typed') {
  const id = ferretId('restart-fixture');
  const state = { composer: '', working: false, atPrompt: true, ink, submitted: [] as string[], keys: [] as string[] };
  const answer = (stdout = '') => ({ exitCode: 0, signal: null, stdout, stderr: '' });
  const execute = (args: readonly string[], stdin?: string): ReturnType<typeof answer> => {
    if (args[0] === 'source-file') return execute(words(stdin ?? ''));
    if (args[0] === 'if-shell') return execute(words(args[5] ?? ''));
    if (args[0] === 'display-message') {
      if (args.at(-1)?.startsWith('#{pane_id}|')) return answer(`%7|4242|0|fy-${id}|1000|${harness}|0`);
      return answer(`0||${harness === 'opencode' ? 3 : 2 + state.composer.length}|0|24|100`);
    }
    if (args[0] === 'capture-pane') {
      const color =
        state.ink === 'typed' ? '\x1b[38;2;255;255;255m' : state.ink === 'placeholder' ? '\x1b[38;2;128;128;128m' : '';
      const native = state.working
        ? 'Working'
        : `┃  ${color}${state.composer}\x1b[0m\n┃  Build auto · fixture\n╹▀▀▀▀\n${state.atPrompt ? 'shift+tab agents ctrl+p commands' : 'esc interrupt'}`;
      const text = harness === 'opencode' ? native : `> ${state.composer}\n`;
      return answer(args.includes('-e') ? text : stripVTControlCharacters(text));
    }
    if (args[0] === 'send-keys') {
      const literal = args.indexOf('-l');
      if (literal >= 0) state.composer += args[literal + 1] ?? '';
      else {
        const key = args.at(-1) ?? '';
        state.keys.push(key);
        if (key === 'C-u') state.composer = '';
        if (key === 'Enter') {
          state.submitted.push(state.composer);
          state.composer = '';
          state.working = true;
        }
      }
    }
    return answer();
  };
  let builds = 0;
  const clock = fixedClock();
  const original = real('terminals');
  const terminals = implementDaemon(original.manifest, {
    build: ctx => {
      builds++;
      if (original.build === undefined) throw new Error('no Terminals build');
      return original.build({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          clock: {
            ...ctx.kernel.clock,
            sleep: async ms => {
              await clock.advance(ms);
            },
          },
        },
      });
    },
  });
  const first = await testHost({
    plugins: [real('ferrets'), real('opencode'), terminals],
    clock,
    hostFacts: nodeHostFacts({
      proc: '/fixture/proc',
      sys: '/fixture/sys',
      launchGuard: () => ({ active: true, searchPath: '/fake' }),
    }),
    everyDirectory: true,
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    spawn: (program, args, options) => {
      if (program !== 'tmux') throw new Error('the restart fixture runs only in-memory tmux commands');
      expect(args.slice(0, 2)).toEqual(['-u', '-S']);
      expect(args[2]).toMatch(/^\//u);
      return execute(args.slice(3), typeof options?.stdin === 'string' ? options.stdin : undefined);
    },
  });
  first.state('ferrets').plant(
    FerretFiles,
    JSON.stringify({
      format: 1,
      id,
      name: 'restart-fixture',
      role: 'lead',
      harness,
      runner: 'tmux',
      handle: '%7',
      folder: '/work/fixture',
      state: 'idle',
      createdAt: T0,
      stateAt: T0,
    }),
    id,
  );
  const host = await first.restart();
  expect(builds).toBe(2);
  const seam = await host.provided(FerretsPort).harness?.(id);
  if (seam === undefined) throw new Error('restart must restore the harness facade');
  return { host, seam, state };
}

for (const harness of ['claude-code', 'codex', 'opencode']) {
  test(`restart hydration restores the live ${harness} reader and delivery without a caller attaching`, async () => {
    const { host, seam, state } = await restartedPane(harness);
    try {
      expect(await seam.observe?.()).toMatchObject({ ok: true, value: { promptReady: true } });
      expect(await seam.deliver({ text: 'after restart' })).toMatchObject({ ok: true });
      expect(state.submitted).toEqual(['after restart']);
    } finally {
      await host.stop();
    }
  });
}

for (const ink of ['unknown', 'placeholder'] as const) {
  test(`mailbox submit and repair refuse a native ${ink} composer even when its words match`, async () => {
    const { host, seam, state } = await restartedPane('opencode', ink);
    try {
      const text = 'Ask anything… "fixture"';
      state.composer = text;
      for (const strict of [false, true]) {
        expect(await seam.submitComposer?.(text, strict)).toEqual({ ok: true, value: 'absent' });
        expect(await seam.clearComposer?.(text)).toEqual({ ok: true, value: 'stuck' });
      }
      expect(state.keys).toEqual([]);
      expect(state.composer).toBe(text);
    } finally {
      await host.stop();
    }
  });
}

test('mailbox submit and repair accept positively identified native input and refuse an unreadable working frame', async () => {
  const { host, seam, state } = await restartedPane('opencode');
  try {
    const text = 'Ask anything… "fixture"';
    state.composer = text;
    expect(await seam.submitComposer?.(text, true)).toEqual({ ok: true, value: 'submitted' });
    expect(state.submitted).toEqual([text]);
    state.working = false;
    state.composer = text;
    expect(await seam.clearComposer?.(text)).toEqual({ ok: true, value: 'cleared' });
    expect(state.composer).toBe('');
    state.atPrompt = false;
    state.composer = text;
    const keys = [...state.keys];
    expect(await seam.submitComposer?.(text)).toEqual({ ok: true, value: 'absent' });
    expect(await seam.clearComposer?.(text)).toEqual({ ok: true, value: 'stuck' });
    expect(state.keys).toEqual(keys);
  } finally {
    await host.stop();
  }
});
