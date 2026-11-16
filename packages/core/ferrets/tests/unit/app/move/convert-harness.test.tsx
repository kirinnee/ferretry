import { afterEach, describe, expect, it } from 'bun:test';
import type { ConversionPreview, FerretSummary } from '../../../../contract/index.ts';
import { ConvertHarness, type ConvertHarnessProps } from '../../../../app/features/move/convert-harness.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { chosenAccount, emptySlot, fakeSlot, type SlotLog } from './slot.tsx';
import { summaryOf } from './support.ts';

const refusal = (message: string, code: string, body?: unknown) =>
  Object.assign(new Error(message), { status: 409, code, ...(body === undefined ? {} : { body }) });

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
  code: 'move_refused',
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

const VIEW = summaryOf({ id: 's1' });
const CODEX_A = chosenAccount('codex-a', 'codex', { displayName: 'Codex A' });
const CODEX_B = chosenAccount('codex-b', 'codex', { displayName: 'Codex B' });

interface Seen {
  reads: string[];
  moves: { agent: string; id: string; force: boolean }[];
  moved: { summary: FerretSummary; notice: string }[];
  cancels: number;
}

const show = async (
  over: Partial<ConvertHarnessProps> & {
    accounts?: Parameters<typeof fakeSlot>[0];
    preview?: () => Promise<ConversionPreview>;
    mover?: () => Promise<FerretSummary>;
    log?: SlotLog;
  } = {},
) => {
  const seen: Seen = { reads: [], moves: [], moved: [], cancels: 0 };
  const { preview, mover, accounts = [CODEX_A, CODEX_B], log, ...rest } = over;
  const element = (props: Partial<ConvertHarnessProps>) => (
    <ConvertHarness
      move={async (agent, id, force) => {
        seen.moves.push({ agent, id, force });
        return await (mover ?? (async () => summaryOf({ id: 's1', runtime: agent, harness: 'codex' })))();
      }}
      onCancel={() => {
        seen.cancels += 1;
      }}
      onMoved={(next, notice) => seen.moved.push({ summary: next, notice })}
      readPreview={async agent => {
        seen.reads.push(agent);
        return await (preview ?? (async () => ready()))();
      }}
      slot={fakeSlot(accounts, log)}
      summary={VIEW}
      {...rest}
      {...props}
    />
  );
  mounted = await mount(element({}));
  await settle();
  return {
    seen,
    root: mounted.container,
    rerender: async (props: Partial<ConvertHarnessProps>) => {
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
const pick = async (root: HTMLElement, wrapper: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(`[data-account="${wrapper}"]`), wrapper).click());
  await settle();
};

describe('ConvertHarness — a ready preview', () => {
  it('offers the OTHER harness’s accounts through the slot and waits for a choice', async () => {
    const log: SlotLog = { fields: [] };
    const { root, seen } = await show({ log });
    expect(log.fields[0]?.harness).toBe('codex');
    expect(seen.reads).toEqual([]);
    expect(text(root)).toContain('Choose an account to see what will move.');
    expect(q(root, 'data-convert-confirm')).toBeNull();
  });

  it('reads the chosen account’s preview and says it in plain words', async () => {
    const { root, seen } = await show();
    await pick(root, 'codex-a');
    expect(seen.reads).toEqual(['codex-a']);
    const said = text(root);
    expect(said).toContain('Move to which Codex account?');
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
    await pick(root, 'codex-a');
    expect(text(root)).toContain('All 40 turns will move.');
    expect(text(root)).not.toContain('Not carried');
    expect(text(root)).not.toContain('shortened');
  });

  it('moves with the chosen account and tells the page, with a sentence naming the account', async () => {
    const { root, seen } = await show();
    await pick(root, 'codex-a');
    await press(root, 'data-convert-confirm');
    expect(seen.moves).toHaveLength(1);
    expect(seen.moves[0]).toMatchObject({ agent: 'codex-a', force: false });
    expect(seen.moved[0]?.notice).toBe('Moved to Codex (Codex A).');
    expect(seen.moved[0]?.summary.runtime).toBe('codex-a');
  });

  it('shows the busy sentence while the daemon checks the converted file, and ignores a second press', async () => {
    let finish: (summary: FerretSummary) => void = () => undefined;
    const { root, seen } = await show({ mover: () => new Promise<FerretSummary>(resolve => (finish = resolve)) });
    await pick(root, 'codex-a');
    await interact(() => must(q(root, 'data-convert-confirm'), 'confirm').click());
    expect(text(root)).toContain('Checking that Codex can open the conversation…');
    expect(q(root, 'data-convert-moving')?.getAttribute('role')).toBe('status');
    expect(q(root, 'data-convert-confirm')).toBeNull();
    await interact(() => finish(summaryOf({ id: 's1' })));
    await settle();
    expect(seen.moves).toHaveLength(1);
    expect(seen.moved).toHaveLength(1);
  });
});

describe('ConvertHarness — the other direction', () => {
  it('moves a Codex ferret to Claude, in those words', async () => {
    const { root, seen } = await show({
      accounts: [chosenAccount('claude-a', 'claude-code', { displayName: 'Claude A' })],
      summary: summaryOf({ id: 's1', harness: 'codex', runtime: 'codex-a' }),
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
    await pick(root, 'claude-a');
    expect(text(root)).toContain('Move to which Claude account?');
    expect(must(q(root, 'data-convert-confirm'), 'confirm').textContent).toBe('Move to Claude');
    expect(text(root)).toContain('Claude Code 2.1.281 · converted from Codex');
    await press(root, 'data-convert-confirm');
    expect(seen.moved[0]?.notice).toBe('Moved to Claude (Claude A).');
  });
});

describe('ConvertHarness — choosing among accounts', () => {
  it('reads the preview again for each choice', async () => {
    const { root, seen } = await show();
    await pick(root, 'codex-b');
    expect(seen.reads).toEqual(['codex-b']);
    expect(q(root, 'data-convert-confirm')).not.toBeNull();
    await pick(root, 'codex-a');
    expect(seen.reads).toEqual(['codex-b', 'codex-a']);
  });

  it('does not follow an account of the wrong harness', async () => {
    const { root, seen } = await show({ accounts: [chosenAccount('claude-a', 'claude-code')] });
    await pick(root, 'claude-a');
    expect(seen.reads).toEqual([]);
    expect(q(root, 'data-convert-confirm')).toBeNull();
  });

  it('without a picker, a typed wrapper is read only when asked', async () => {
    const { root, seen } = await show({ slot: emptySlot });
    const input = must(root.querySelector<HTMLInputElement>('input[data-move-account-fallback]'), 'typed wrapper');
    expect(input.placeholder).toBe('codex-default');
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'codex-z');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen.reads).toEqual([]);
    await press(root, 'data-convert-check');
    expect(seen.reads).toEqual(['codex-z']);
    await press(root, 'data-convert-confirm');
    expect(seen.moves[0]).toMatchObject({ agent: 'codex-z', force: false });
  });
});

describe('ConvertHarness — a preview that cannot be had', () => {
  it('shows a refused preview’s reason with no confirm button', async () => {
    const { root } = await show({
      preview: async () => ({ kind: 'refused', targetAgent: 'codex-a', reason: 'Codex is not installed here.' }),
    });
    await pick(root, 'codex-a');
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
    await pick(root, 'codex-a');
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
      <ConvertHarness
        move={async () => summaryOf()}
        onCancel={() => undefined}
        onMoved={() => undefined}
        readPreview={agent => {
          reads.push(agent);
          return new Promise<ConversionPreview>(resolve => answers.set(agent, resolve));
        }}
        slot={fakeSlot([CODEX_A, CODEX_B])}
        summary={VIEW}
      />,
    );
    mounted = sheet;
    await pick(sheet.container, 'codex-a');
    await pick(sheet.container, 'codex-b');
    await interact(() => answers.get('codex-a')?.({ kind: 'refused', targetAgent: 'codex-a', reason: 'stale answer' }));
    expect(text(sheet.container)).not.toContain('stale answer');
    await interact(() => answers.get('codex-b')?.(ready()));
    await settle();
    expect(q(sheet.container, 'data-convert-confirm')).not.toBeNull();
    expect(reads).toEqual(['codex-a', 'codex-b']);
  });
});

describe('ConvertHarness — a move the daemon refuses', () => {
  it('shows an unresumable conversation in place, with nothing changed, and lets the person try again', async () => {
    let attempts = 0;
    const { root, seen } = await show({
      mover: async () => {
        attempts += 1;
        if (attempts === 1) throw refusal('Codex rejected the converted file.', 'conversation_unresumable');
        return summaryOf({ id: 's1' });
      },
    });
    await pick(root, 'codex-a');
    await press(root, 'data-convert-confirm');
    expect(text(q(root, 'data-convert-failure') as HTMLElement)).toContain('Codex rejected the converted file.');
    expect(text(root)).toContain('Nothing was changed.');
    expect(seen.moved).toHaveLength(0);
    expect(q(root, 'data-convert-confirm')).not.toBeNull();
    await press(root, 'data-convert-confirm');
    expect(seen.moved).toHaveLength(1);
    // The same logical move keeps one request id across the retry.
    expect(seen.moves[0]?.id).toBe(seen.moves[1]?.id);
  });

  it('pauses on in-flight work, and “Move anyway” resends with force under a new request id', async () => {
    let attempts = 0;
    const { root, seen } = await show({
      mover: async () => {
        attempts += 1;
        if (attempts === 1) throw refusal('refused', 'move_refused', inflight);
        return summaryOf({ id: 's1' });
      },
    });
    await pick(root, 'codex-a');
    await press(root, 'data-convert-confirm');
    const paused = text(q(root, 'data-convert-paused') as HTMLElement);
    expect(paused).toContain('Move paused');
    expect(paused).toContain('A program is running');
    expect(paused).toContain('fy-helper --watch');
    expect(paused).toContain('No detail here');
    expect(q(root, 'data-convert-confirm')).toBeNull();
    expect(seen.moved).toHaveLength(0);
    await press(root, 'data-convert-anyway');
    expect(seen.moves.map(move => move.force)).toEqual([false, true]);
    expect(seen.moves[0]?.id).not.toBe(seen.moves[1]?.id);
    expect(seen.moved).toHaveLength(1);
  });

  it('keeps the pause when forcing past it is refused again, and Cancel goes back', async () => {
    const { root, seen } = await show({
      mover: async () => {
        throw refusal('refused', 'move_refused', inflight);
      },
    });
    await pick(root, 'codex-a');
    await press(root, 'data-convert-confirm');
    await press(root, 'data-convert-anyway');
    expect(q(root, 'data-convert-paused')).not.toBeNull();
    await press(root, 'data-convert-cancel');
    expect(seen.cancels).toBe(1);
  });

  it('shows any other refusal as its sentence', async () => {
    const { root } = await show({
      mover: async () => {
        throw refusal('That account is not available.', 'agent_unavailable');
      },
    });
    await pick(root, 'codex-a');
    await press(root, 'data-convert-confirm');
    expect(text(q(root, 'data-convert-failure') as HTMLElement)).toContain('That account is not available.');
  });
});

describe('ConvertHarness — identity and state', () => {
  it('starts clean when the ferret changes', async () => {
    const { root, seen, rerender } = await show();
    await pick(root, 'codex-a');
    expect(q(root, 'data-convert-confirm')).not.toBeNull();
    await rerender({ summary: summaryOf({ id: 's2' }) });
    expect(q(root, 'data-convert-confirm')).toBeNull();
    expect(text(root)).toContain('Choose an account to see what will move.');
    expect(seen.reads).toEqual(['codex-a']);
  });

  it('drops a finished move’s result when the ferret changed underneath it', async () => {
    let finish: (summary: FerretSummary) => void = () => undefined;
    const { root, seen, rerender } = await show({
      mover: () => new Promise<FerretSummary>(resolve => (finish = resolve)),
    });
    await pick(root, 'codex-a');
    await interact(() => must(q(root, 'data-convert-confirm'), 'confirm').click());
    await rerender({ summary: summaryOf({ id: 's2' }) });
    await interact(() => finish(summaryOf({ id: 's1' })));
    await settle();
    expect(seen.moved).toEqual([]);
  });

  it('drops a failed move’s error when the ferret changed underneath it', async () => {
    let fail: (reason: unknown) => void = () => undefined;
    const { root, seen, rerender } = await show({
      mover: () => new Promise<FerretSummary>((_resolve, reject) => (fail = reject)),
    });
    await pick(root, 'codex-a');
    await interact(() => must(q(root, 'data-convert-confirm'), 'confirm').click());
    await rerender({ summary: summaryOf({ id: 's2' }) });
    await interact(() => fail(new Error('late failure')));
    await settle();
    expect(text(root)).not.toContain('late failure');
    expect(seen.moved).toEqual([]);
  });

  it('does nothing when asked to move before a preview is ready', async () => {
    const { root, seen } = await show();
    expect(q(root, 'data-convert-confirm')).toBeNull();
    expect(seen.moves).toEqual([]);
  });
});
