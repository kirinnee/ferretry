import { afterEach, describe, expect, it } from 'bun:test';
import type { ConversionPreview, SessionView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { ConvertSheet, type ConvertSheetProps } from '../../../../src/features/session-actions/convert-sheet.tsx';
import type { PickerAccount } from '../../../../src/lib/account-picker-catalog.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const daemon = daemonConnection({ daemonId: 'd-a', baseUrl: 'https://a.invalid', deviceId: 'tok' });
const otherDaemon = daemonConnection({ daemonId: 'd-b', baseUrl: 'https://b.invalid', deviceId: 'tok' });
const scope = daemonSessionScope(daemon, 's1');

const account = (id: string, kind: PickerAccount['kind'], displayName = id): PickerAccount => ({
  id,
  wrapper: id,
  displayName,
  kind,
  agent: true,
  credentialId: `${id}-login`,
  defaultModel: null,
  models: [],
  available: true,
  unavailableReason: null,
});

const ready = (over: Partial<Extract<ConversionPreview, { kind: 'ready' }>['summary']> = {}): ConversionPreview => ({
  kind: 'ready',
  targetAgent: 'codex-a',
  targetModel: 'gpt-5.5',
  summary: {
    converter: 1,
    sourceHarness: 'claude',
    sourceVersion: '2.1.281',
    targetHarness: 'codex',
    targetVersion: '0.163.0',
    turns: 40,
    keptTurns: 12,
    omittedTurns: 28,
    cutNewest: true,
    messages: 24,
    nativeToolCalls: 9,
    toolCallsAsText: 31,
    attachments: 2,
    dropped: { reasoning: 14, sidechains: 3, internal: 57, compactions: 0 },
    estimatedTokens: 90000,
    budgetTokens: 200000,
    ...over,
  },
});

const inflight = {
  error: 'refused',
  code: 'migration_refused',
  inflight: {
    status: 'running',
    turn: 2,
    blockedBy: 'unknown',
    restartsWithCli: 0,
    items: [
      { kind: 'process', verdict: 'unknown', title: 'A program is running', detail: 'fy-helper --watch', blocks: true },
      { kind: 'process', verdict: 'unknown', title: 'No detail here', blocks: true },
    ],
  },
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const VIEW = sessionView('s1');
const ONE = [account('codex-a', 'codex', 'Codex A')];
const TWO = [account('codex-a', 'codex', 'Codex A'), account('codex-b', 'codex', 'Codex B')];

interface Seen {
  reads: string[];
  moves: { agent: string; id: string; force: boolean }[];
  moved: { view: SessionView; notice: string }[];
  closes: number;
}

const show = async (
  over: Partial<ConvertSheetProps> & {
    preview?: () => Promise<ConversionPreview>;
    mover?: () => Promise<SessionView>;
  } = {},
) => {
  const seen: Seen = { reads: [], moves: [], moved: [], closes: 0 };
  const { preview, mover, ...rest } = over;
  const element = (props: Partial<ConvertSheetProps>) => (
    <ConvertSheet
      accounts={ONE}
      connection={daemon}
      move={async (_target, _view, agent, id, force) => {
        seen.moves.push({ agent, id, force });
        return await (mover ?? (async () => sessionView('s1', { config: { agent } })))();
      }}
      onClose={() => {
        seen.closes += 1;
      }}
      onMoved={(next, notice) => seen.moved.push({ view: next, notice })}
      open
      readPreview={async (_target, _scope, agent) => {
        seen.reads.push(agent);
        return await (preview ?? (async () => ready()))();
      }}
      scope={scope}
      view={VIEW}
      {...rest}
      {...props}
    />
  );
  mounted = await mount(element({}));
  await settle();
  return {
    seen,
    root: mounted.container,
    rerender: async (props: Partial<ConvertSheetProps>) => {
      await must(mounted, 'mounted').render(element(props));
      await settle();
    },
  };
};

const text = (root: HTMLElement): string => root.textContent ?? '';
const q = (root: HTMLElement, marker: string): HTMLElement | null => root.querySelector<HTMLElement>(`[${marker}]`);
const press = async (root: HTMLElement, marker: string): Promise<void> => {
  await interact(() => must(q(root, marker), marker).click());
  await settle();
};

describe('ConvertSheet — a ready preview', () => {
  it('reads the only account’s preview at once and says it in plain words, with no picker', async () => {
    const { root, seen } = await show();
    expect(seen.reads).toEqual(['codex-a']);
    expect(q(root, 'data-convert-accounts')).toBeNull();
    const said = text(root);
    expect(said).toContain('Move to Codex');
    expect(said).toContain('12 of 40 turns will move to Codex (28 older turns left out to fit gpt-5.5’s window).');
    expect(said).toContain('9 shell commands carry over as Codex commands.');
    expect(said).toContain('31 other tool calls become short text notes.');
    expect(said).toContain('2 attachments carry over as file references.');
    expect(said).toContain('Not carried: thinking (14), subagent work (3), harness notes (57).');
    expect(said).toContain('The newest turn is too long and will be shortened.');
    expect(said).toContain('Codex 0.163.0 · converted from Claude Code 2.1.281');
    expect(said).toContain('The Claude conversation stays on disk.');
    expect(must(q(root, 'data-convert-confirm'), 'confirm').textContent).toBe('Move to Codex');
  });

  it('says everything moves when nothing was left out', async () => {
    const { root } = await show({
      preview: async () =>
        ready({
          keptTurns: 40,
          omittedTurns: 0,
          cutNewest: false,
          nativeToolCalls: 0,
          toolCallsAsText: 0,
          attachments: 0,
          dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 },
        }),
    });
    expect(text(root)).toContain('All 40 turns will move.');
    expect(text(root)).not.toContain('Not carried');
    expect(text(root)).not.toContain('shortened');
  });

  it('moves with the chosen account, closes, and leaves a toast sentence naming the account', async () => {
    const { root, seen } = await show();
    await press(root, 'data-convert-confirm');
    expect(seen.moves).toHaveLength(1);
    expect(seen.moves[0]).toMatchObject({ agent: 'codex-a', force: false });
    expect(seen.moved[0]?.notice).toBe('Moved to Codex (Codex A).');
    expect(seen.moved[0]?.view.config.agent).toBe('codex-a');
    expect(seen.closes).toBe(1);
  });

  it('shows the busy sentence while the daemon checks the converted file, and ignores a second press', async () => {
    let finish: (view: SessionView) => void = () => undefined;
    const { root, seen } = await show({ mover: () => new Promise<SessionView>(resolve => (finish = resolve)) });
    await interact(() => must(q(root, 'data-convert-confirm'), 'confirm').click());
    expect(text(root)).toContain('Checking that Codex can open the conversation…');
    expect(q(root, 'data-convert-moving')?.getAttribute('role')).toBe('status');
    expect(q(root, 'data-convert-confirm')).toBeNull();
    await interact(() => finish(sessionView('s1')));
    await settle();
    expect(seen.moves).toHaveLength(1);
    expect(seen.closes).toBe(1);
  });
});

describe('ConvertSheet — the other direction', () => {
  it('moves a Codex ferret to Claude, in those words', async () => {
    const view = sessionView('s1', { config: { harness: 'codex', agent: 'codex-a' } });
    const { root, seen } = await show({
      accounts: [account('claude-a', 'claude', 'Claude A')],
      view,
      preview: async () => ({
        kind: 'ready',
        targetAgent: 'claude-a',
        targetModel: 'claude-opus-5',
        summary: {
          ...(ready() as Extract<ConversionPreview, { kind: 'ready' }>).summary,
          sourceHarness: 'codex',
          targetHarness: 'claude',
          targetVersion: '2.1.281',
          sourceVersion: undefined,
        },
      }),
    });
    expect(text(root)).toContain('Move to Claude');
    expect(must(q(root, 'data-convert-confirm'), 'confirm').textContent).toBe('Move to Claude');
    expect(text(root)).toContain('Claude Code 2.1.281 · converted from Codex');
    await press(root, 'data-convert-confirm');
    expect(seen.moved[0]?.notice).toBe('Moved to Claude (Claude A).');
  });
});

describe('ConvertSheet — choosing among several accounts', () => {
  it('offers a picker, waits for a choice, then reads the preview for it', async () => {
    const { root, seen } = await show({ accounts: TWO });
    expect(seen.reads).toEqual([]);
    expect(text(root)).toContain('Choose an account to see what will move.');
    expect(q(root, 'data-convert-confirm')).toBeNull();
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    await interact(() => radios[1]?.click());
    await settle();
    expect(seen.reads).toEqual(['codex-b']);
    expect(q(root, 'data-convert-confirm')).not.toBeNull();
    await interact(() => [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0]?.click());
    await settle();
    expect(seen.reads).toEqual(['codex-b', 'codex-a']);
  });

  it('names an account by its display name and shows its wrapper id beside it when they differ', async () => {
    const { root } = await show({ accounts: [account('codex-a', 'codex', 'Work'), account('codex-b', 'codex')] });
    expect(text(q(root, 'data-convert-accounts') as HTMLElement)).toContain('Work');
    expect(text(q(root, 'data-convert-accounts') as HTMLElement)).toContain('codex-a');
  });
});

describe('ConvertSheet — a preview that cannot be had', () => {
  it('shows a refused preview’s reason with no confirm button', async () => {
    const { root } = await show({
      preview: async () => ({ kind: 'refused', targetAgent: 'codex-a', reason: 'Codex is not installed here.' }),
    });
    expect(text(q(root, 'data-convert-refused') as HTMLElement)).toContain('Codex is not installed here.');
    expect(text(root)).toContain('Nothing was changed.');
    expect(q(root, 'data-convert-confirm')).toBeNull();
  });

  it('shows a failed read with Try again, which reads once more', async () => {
    let attempts = 0;
    const { root, seen } = await show({
      preview: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('the daemon is unreachable');
        if (attempts === 2) throw 'plain failure';
        return ready();
      },
    });
    expect(text(q(root, 'data-convert-failed') as HTMLElement)).toContain('the daemon is unreachable');
    expect(q(root, 'data-convert-confirm')).toBeNull();
    await press(root, 'data-convert-failed] button[type="button"');
    expect(text(q(root, 'data-convert-failed') as HTMLElement)).toContain('plain failure');
    await press(root, 'data-convert-failed] button[type="button"');
    expect(seen.reads).toHaveLength(3);
    expect(q(root, 'data-convert-confirm')).not.toBeNull();
  });

  it('drops a late answer for an earlier choice', async () => {
    const answers = new Map<string, (preview: ConversionPreview) => void>();
    const reads: string[] = [];
    const sheet = await mount(
      <ConvertSheet
        accounts={TWO}
        connection={daemon}
        onClose={() => undefined}
        onMoved={() => undefined}
        open
        readPreview={(_c, _s, agent) => {
          reads.push(agent);
          return new Promise<ConversionPreview>(resolve => answers.set(agent, resolve));
        }}
        scope={scope}
        view={VIEW}
      />,
    );
    mounted = sheet;
    const radios = () => [...sheet.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await interact(() => radios()[0]?.click());
    await interact(() => radios()[1]?.click());
    await interact(() => answers.get('codex-a')?.({ kind: 'refused', targetAgent: 'codex-a', reason: 'stale answer' }));
    expect(text(sheet.container)).not.toContain('stale answer');
    await interact(() => answers.get('codex-b')?.(ready()));
    await settle();
    expect(q(sheet.container, 'data-convert-confirm')).not.toBeNull();
    expect(reads).toEqual(['codex-a', 'codex-b']);
  });
});

describe('ConvertSheet — a move the daemon refuses', () => {
  it('shows an unresumable conversation in place, with nothing changed, and lets the person try again', async () => {
    let attempts = 0;
    const { root, seen } = await show({
      mover: async () => {
        attempts += 1;
        if (attempts === 1)
          throw new FyHttpError('Codex rejected the converted file.', 409, 'conversation_unresumable');
        return sessionView('s1');
      },
    });
    await press(root, 'data-convert-confirm');
    expect(text(q(root, 'data-convert-failure') as HTMLElement)).toContain('Codex rejected the converted file.');
    expect(text(root)).toContain('Nothing was changed.');
    expect(seen.closes).toBe(0);
    expect(q(root, 'data-convert-confirm')).not.toBeNull();
    await press(root, 'data-convert-confirm');
    expect(seen.closes).toBe(1);
    // The same logical move keeps one request id across the retry.
    expect(seen.moves[0]?.id).toBe(seen.moves[1]?.id);
  });

  it('pauses on in-flight work, and “Move anyway” resends with force under a new request id', async () => {
    let attempts = 0;
    const { root, seen } = await show({
      mover: async () => {
        attempts += 1;
        if (attempts === 1) throw new FyHttpError('refused', 409, 'migration_refused', inflight);
        return sessionView('s1');
      },
    });
    await press(root, 'data-convert-confirm');
    const paused = text(q(root, 'data-convert-paused') as HTMLElement);
    expect(paused).toContain('Move paused');
    expect(paused).toContain('A program is running');
    expect(paused).toContain('fy-helper --watch');
    expect(paused).toContain('No detail here');
    expect(q(root, 'data-convert-confirm')).toBeNull();
    expect(seen.closes).toBe(0);
    await press(root, 'data-convert-anyway');
    expect(seen.moves.map(move => move.force)).toEqual([false, true]);
    expect(seen.moves[0]?.id).not.toBe(seen.moves[1]?.id);
    expect(seen.closes).toBe(1);
  });

  it('keeps the pause when forcing past it is refused again, and Cancel closes', async () => {
    const { root, seen } = await show({
      mover: async () => {
        throw new FyHttpError('refused', 409, 'migration_refused', inflight);
      },
    });
    await press(root, 'data-convert-confirm');
    await press(root, 'data-convert-anyway');
    expect(q(root, 'data-convert-paused')).not.toBeNull();
    await press(root, 'data-convert-cancel');
    expect(seen.closes).toBe(1);
  });

  it('shows any other refusal as its sentence', async () => {
    const { root } = await show({
      mover: async () => {
        throw new FyHttpError('That account is not available.', 409, 'agent_unavailable');
      },
    });
    await press(root, 'data-convert-confirm');
    expect(text(q(root, 'data-convert-failure') as HTMLElement)).toContain('That account is not available.');
  });
});

describe('ConvertSheet — identity and state', () => {
  it('refuses a session that does not belong to the connection', async () => {
    const { root, seen } = await show({ connection: otherDaemon });
    expect(text(root)).toContain('does not belong to the selected machine');
    expect(q(root, 'data-convert-confirm')).toBeNull();
    expect(seen.reads).toHaveLength(1);
  });

  it('starts clean each time it opens, and reads nothing while closed', async () => {
    const { root, seen, rerender } = await show({ open: false });
    expect(seen.reads).toEqual([]);
    expect(root.textContent).toBe('');
    await rerender({ open: true });
    expect(seen.reads).toEqual(['codex-a']);
    expect(q(root, 'data-convert-confirm')).not.toBeNull();
  });

  it('drops a finished move’s result when the session changed underneath it', async () => {
    let finish: (view: SessionView) => void = () => undefined;
    const { root, seen, rerender } = await show({
      mover: () => new Promise<SessionView>(resolve => (finish = resolve)),
    });
    await interact(() => must(q(root, 'data-convert-confirm'), 'confirm').click());
    await rerender({ view: sessionView('s2'), scope: daemonSessionScope(daemon, 's2') });
    await interact(() => finish(sessionView('s1')));
    await settle();
    expect(seen.moved).toEqual([]);
    expect(seen.closes).toBe(0);
  });

  it('drops a failed move’s error when the session changed underneath it', async () => {
    let fail: (reason: unknown) => void = () => undefined;
    const { root, seen, rerender } = await show({
      mover: () => new Promise<SessionView>((_resolve, reject) => (fail = reject)),
    });
    await interact(() => must(q(root, 'data-convert-confirm'), 'confirm').click());
    await rerender({ view: sessionView('s2'), scope: daemonSessionScope(daemon, 's2') });
    await interact(() => fail(new Error('late failure')));
    await settle();
    expect(text(root)).not.toContain('late failure');
    expect(seen.moved).toEqual([]);
  });

  it('does nothing when asked to move before a preview is ready', async () => {
    const { root, seen } = await show({ accounts: TWO });
    expect(q(root, 'data-convert-confirm')).toBeNull();
    expect(seen.moves).toEqual([]);
  });
});
