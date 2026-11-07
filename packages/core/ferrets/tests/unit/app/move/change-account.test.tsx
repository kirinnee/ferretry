import { afterEach, describe, expect, it } from 'bun:test';
import type { FerretSummary } from '../../../../contract/index.ts';
import {
  type AskToStopJobs,
  ChangeAccount,
  type ChangeAccountProps,
  type MoveFerret,
  moveRequestKey,
} from '../../../../app/features/move/change-account.tsx';
import { chosenAccount, emptySlot, fakeSlot, type SlotLog } from './slot.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { summaryOf } from './support.ts';

/** A refusal as the page reads it: the shell client's fields, and the body when the client carries it. */
const refusal = (message: string, code: string, body?: unknown) =>
  Object.assign(new Error(message), { status: 409, code, ...(body === undefined ? {} : { body }) });

type Over = Parameters<typeof summaryOf>[0];
const source = (over: Over = {}): FerretSummary =>
  summaryOf({
    id: 'same-ferret',
    harness: 'codex',
    runtime: 'codex-auto-loge',
    model: 'gpt-5.6-sol[1m]',
    state: 'working',
    ...over,
  });
const stopped = (over: Over = {}): FerretSummary => source({ state: 'stopped', ...over });

const ATOMI = chosenAccount('codex-auto-atomi', 'codex', {
  displayName: 'Atomi Codex',
  defaultModel: 'gpt-5.6-terra',
  models: [
    { id: 'gpt-5.6-terra', available: true },
    { id: 'gpt-5.6-sol', available: true },
    { id: 'gpt-5.5-retiring', available: false },
  ],
});
const LOGE = chosenAccount('codex-auto-loge', 'codex', { displayName: 'Loge Codex' });

let live: Mounted | undefined;
afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

interface Seen {
  moves: { target: Parameters<MoveFerret>[0]; requestId: string }[];
  moved: FerretSummary[];
  cancels: number;
  asks: number;
}

const show = async (over: Partial<ChangeAccountProps> & { move?: MoveFerret } = {}) => {
  const seen: Seen = { moves: [], moved: [], cancels: 0, asks: 0 };
  const { move, ...rest } = over;
  const element = (props: Partial<ChangeAccountProps>) => (
    <ChangeAccount
      askToStopJobs={async () => {
        seen.asks += 1;
        return { messageId: 'move-jobs-1', jobs: [{ pid: 1, command: 'sleep 9' }], alreadyAsked: false };
      }}
      move={async (target, requestId) => {
        seen.moves.push({ target, requestId });
        return await (move ?? (async () => stopped()))(target, requestId);
      }}
      onCancel={() => {
        seen.cancels += 1;
      }}
      onMoved={next => seen.moved.push(next)}
      slot={fakeSlot([LOGE, ATOMI])}
      summary={source()}
      {...rest}
      {...props}
    />
  );
  live = await mount(element({}));
  await settle();
  const root = live.container;
  return {
    seen,
    root,
    rerender: async (props: Partial<ChangeAccountProps>) => {
      await must(live, 'mounted').render(element(props));
      await settle();
    },
  };
};

const text = (root: HTMLElement): string => root.textContent ?? '';
const control = (root: HTMLElement, label: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(label)),
    `the ${label} button`,
  );
const press = async (root: HTMLElement, label: string): Promise<void> => {
  await interact(() =>
    control(root, label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
  );
  await settle();
};
const modelField = (root: HTMLElement): HTMLInputElement =>
  must(root.querySelector<HTMLInputElement>('input[list]'), 'the model field');
const setValue = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const pickAccount = async (root: HTMLElement, wrapper: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(`[data-account="${wrapper}"]`), wrapper).click());
};
const review = async (root: HTMLElement): Promise<void> => {
  await interact(() =>
    must(root.querySelector('form'), 'the move form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
};
const datalist = (root: HTMLElement): readonly (string | null)[] =>
  [...root.querySelectorAll('datalist option')].map(option => option.getAttribute('value'));

describe('moveRequestKey', () => {
  it('is stable for one target and distinct for every field a reader can change', () => {
    const target = { agent: 'codex-auto-atomi', model: 'gpt-5.6-sol', allowContextDowngrade: false } as const;
    expect(moveRequestKey('f1', target)).toBe(moveRequestKey('f1', { ...target }));
    expect(moveRequestKey('f1', target)).not.toBe(moveRequestKey('f1', { ...target, agent: 'codex-auto-loge' }));
    expect(moveRequestKey('f1', target)).not.toBe(moveRequestKey('f1', { ...target, model: 'other' }));
    expect(moveRequestKey('f1', target)).not.toBe(moveRequestKey('f1', { ...target, allowContextDowngrade: true }));
    // The account default is a real target, and must not collide with a named model.
    expect(moveRequestKey('f1', { agent: target.agent, allowContextDowngrade: false })).not.toBe(
      moveRequestKey('f1', target),
    );
    // Another ferret is a different move.
    expect(moveRequestKey('f1', target)).not.toBe(moveRequestKey('f2', target));
  });
});

describe('ChangeAccount', () => {
  it('renders the daemon-owned safety contract, with Review disabled until something changes', async () => {
    const { root } = await show();
    const inputs = [...root.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.map(input => input.value)).toEqual(['gpt-5.6-sol[1m]']);
    expect(text(root)).toContain('Move safety');
    expect(text(root)).toContain('This route has no force switch');
    expect(text(root)).not.toContain('Force move');
    expect(control(root, 'Review move').disabled).toBe(true);
    // The statements are a real list: the preflight clears `list-style`, so the class is explicit.
    expect(must(root.querySelector('ul'), 'the safety list').className).toContain('list-disc');
  });

  it('hands the account slot the ferret’s own harness, and lets the slot propose the wrapper', async () => {
    const log: SlotLog = { fields: [] };
    const { root, seen } = await show({ slot: fakeSlot([LOGE, ATOMI], log) });
    expect(log.fields[0]?.harness).toBe('codex');
    expect(log.fields[0]?.value).toBe('codex-auto-loge');
    await pickAccount(root, 'codex-auto-atomi');
    await review(root);
    await press(root, 'Move and relaunch');
    expect(seen.moves[0]?.target.agent).toBe('codex-auto-atomi');
  });

  it('submits one normalised target for the ferret, then reports the authoritative summary', async () => {
    const moved = stopped({ runtime: 'codex-auto-atomi' });
    const { root, seen } = await show({ move: async () => moved, summary: stopped() });
    await pickAccount(root, 'codex-auto-atomi');
    await setValue(modelField(root), '   ');
    await review(root);
    expect(control(root, 'Relaunch on selected runtime')).toBeDefined();
    await press(root, 'Relaunch on selected runtime');

    expect(seen.moves.map(move => move.target)).toEqual([{ agent: 'codex-auto-atomi', allowContextDowngrade: false }]);
    expect(typeof seen.moves[0]?.requestId).toBe('string');
    expect(seen.moved).toEqual([moved]);
  });

  it('allows an explicitly selected model to be cleared for the same account default', async () => {
    const { root, seen } = await show({ summary: stopped() });
    await setValue(modelField(root), '   ');
    expect(control(root, 'Review move').disabled).toBe(false);
    await review(root);
    await press(root, 'Relaunch on selected runtime');
    expect(seen.moves.map(move => move.target)).toEqual([{ agent: 'codex-auto-loge', allowContextDowngrade: false }]);
  });

  it('warns about a smaller window judged from the model names, and still lets the daemon decide', async () => {
    const { root } = await show();
    await pickAccount(root, 'codex-auto-atomi');
    await setValue(modelField(root), 'gpt-5.6-terra');
    expect(text(root)).toContain('This appears to reduce the context window from 1,000,000 to 200,000 tokens');
    expect(control(root, 'Review move').disabled).toBe(false);
  });

  it('keeps moving a typed wrapper when the slot has no panel', async () => {
    const { root, seen } = await show({ slot: emptySlot, summary: stopped() });
    const typed = must(root.querySelector<HTMLInputElement>('input[data-move-account-fallback]'), 'typed wrapper');
    expect(typed.placeholder).toBe('claude-default');
    await setValue(typed, 'codex-auto-unpublished');
    await review(root);
    await press(root, 'Relaunch on selected runtime');
    expect(seen.moves.map(move => move.target)).toEqual([
      { agent: 'codex-auto-unpublished', model: 'gpt-5.6-sol[1m]', allowContextDowngrade: false },
    ]);
  });

  it('draws no typed wrapper while a panel is contributed to the slot', async () => {
    const { root } = await show();
    expect(root.querySelector('input[data-move-account-fallback]')).toBeNull();
  });

  it('requires a second explicit action before accepting a daemon-confirmed context downgrade', async () => {
    const calls: Parameters<MoveFerret>[0][] = [];
    const moved = source();
    const { root, seen } = await show({
      move: async target => {
        calls.push(target);
        if (calls.length === 1) {
          throw refusal(
            'codex-auto-atomi serves gpt-5.6-terra with a 200000-token window and this session is running in 1000000',
            'context_downgrade_refused',
          );
        }
        return moved;
      },
    });
    await pickAccount(root, 'codex-auto-atomi');
    await setValue(modelField(root), 'gpt-5.6-terra');
    await review(root);
    await press(root, 'Move and relaunch');

    expect(text(root)).toContain('The daemon refused a smaller context window');
    expect(text(root)).toContain('200,000 tokens instead of 1,000,000');
    expect(control(root, 'Move with smaller window').disabled).toBe(true);
    await press(root, 'Move with smaller window');
    expect(calls).toHaveLength(1);

    await interact(() => must(root.querySelector<HTMLElement>('input[type="checkbox"]'), 'acknowledge').click());
    await press(root, 'Move with smaller window');

    expect(calls).toEqual([
      { agent: 'codex-auto-atomi', model: 'gpt-5.6-terra', allowContextDowngrade: false },
      { agent: 'codex-auto-atomi', model: 'gpt-5.6-terra', allowContextDowngrade: true },
    ]);
    expect(seen.moved).toEqual([moved]);
  });

  it('offers the daemon-suggested 1M model without silently accepting a downgrade', async () => {
    const { root } = await show({
      move: async () => {
        throw refusal('codex-auto-atomi serves gpt-5.6-terra with a 200000-token window', 'context_downgrade_refused');
      },
    });
    await pickAccount(root, 'codex-auto-atomi');
    await setValue(modelField(root), 'gpt-5.6-terra');
    await review(root);
    await press(root, 'Move and relaunch');
    await press(root, 'Use gpt-5.6-terra[1m] instead');

    expect(modelField(root).value).toBe('gpt-5.6-terra[1m]');
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('renders the preflight refusal, exposes no force bypass, and retries only through the daemon gate', async () => {
    let attempts = 0;
    const message =
      'open tool work is not safe to interrupt\nin-flight inventory — status tool_running, turn 4, worst: UNKNOWN\n  blind [UNKNOWN] open tool call-7 has no transcript';
    const { root } = await show({
      move: async () => {
        attempts += 1;
        if (attempts === 1) throw refusal(message, 'move_refused');
        return stopped();
      },
    });
    await pickAccount(root, 'codex-auto-atomi');
    await review(root);
    await press(root, 'Move and relaunch');

    expect(must(root.querySelector('pre'), 'the refusal').textContent).toBe(message);
    expect(text(root)).toContain('There is no force control');
    expect(text(root)).not.toContain('Force move');
    await press(root, 'Retry safety check');
    expect(attempts).toBe(2);
  });

  it('keeps an actionable typed failure in confirmation and lets the reader return to edit', async () => {
    const { root } = await show({
      move: async () => {
        throw refusal('no account named missing', 'unknown_agent');
      },
    });
    await pickAccount(root, 'codex-auto-atomi');
    await review(root);
    await press(root, 'Move and relaunch');

    expect(text(root)).toContain('Unknown target account');
    expect(text(root)).toContain('no account named missing');
    await press(root, 'Back');
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('says a refusal for a daemon-side reason in the daemon’s own words (a device without the capability)', async () => {
    const forbidden = Object.assign(new Error('this device may not use the fleet capability'), {
      status: 403,
      code: 'forbidden',
    });
    const { root } = await show({
      move: async () => {
        throw forbidden;
      },
    });
    await pickAccount(root, 'codex-auto-atomi');
    await review(root);
    await press(root, 'Move and relaunch');
    expect(text(root)).toContain('this device may not use the fleet capability');
  });

  it('locks duplicate submits, then ignores a late response from the previous ferret', async () => {
    let resolveFirst: ((summary: FerretSummary) => void) | undefined;
    const pending = new Promise<FerretSummary>(resolve => {
      resolveFirst = resolve;
    });
    const { root, seen, rerender } = await show({ move: () => pending });
    await pickAccount(root, 'codex-auto-atomi');
    await review(root);
    const action = control(root, 'Move and relaunch');
    await interact(() => {
      action.click();
      action.click();
    });
    expect(seen.moves).toHaveLength(1);
    expect(text(root)).toContain('Keep this page open');

    await rerender({ summary: source({ id: 'another-ferret' }) });
    expect([...root.querySelectorAll<HTMLInputElement>('input')].map(input => input.value)).toEqual([
      'gpt-5.6-sol[1m]',
    ]);
    await interact(async () => {
      resolveFirst?.(source());
      await pending;
    });
    await settle();
    expect(seen.moved).toEqual([]);
  });

  it('reuses one request id for a repeated confirmation of the same target, and mints a new one when it changes', async () => {
    // A move is destructive and the client retries its POST, so a second confirmation of the SAME target must be
    // the same operation to the daemon — while a changed target must not be.
    const { root, seen } = await show({
      move: async () => {
        throw refusal('in-flight work refuses this move', 'move_refused');
      },
    });
    await pickAccount(root, 'codex-auto-atomi');
    await review(root);
    await press(root, 'Move and relaunch');
    await press(root, 'Retry safety check');

    expect(seen.moves).toHaveLength(2);
    expect(seen.moves[0]?.requestId).toBe(seen.moves[1]?.requestId);

    await press(root, 'Back');
    // A different model is a different decision.
    await setValue(modelField(root), 'gpt-5.6-terra');
    await review(root);
    await press(root, 'Move and relaunch');
    expect(seen.moves).toHaveLength(3);
    expect(seen.moves[2]?.target.model).toBe('gpt-5.6-terra');
    expect(seen.moves[2]?.requestId).not.toBe(seen.moves[0]?.requestId);
  });

  it('leaves Review disabled when the account chosen is the one already running', async () => {
    const { root } = await show();
    await pickAccount(root, 'codex-auto-loge');
    expect(control(root, 'Review move').disabled).toBe(true);
  });

  it('offers the chosen account’s available models as suggestions without writing one', async () => {
    const { root, seen } = await show({ summary: stopped({ model: undefined }) });
    await pickAccount(root, 'codex-auto-atomi');

    expect(modelField(root).value).toBe('');
    expect(datalist(root)).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol']);

    await review(root);
    await press(root, 'Relaunch on selected runtime');
    // Blank stays blank: the daemon resolves the account's own default.
    expect(seen.moves.map(move => move.target)).toEqual([{ agent: 'codex-auto-atomi', allowContextDowngrade: false }]);
  });

  it('drops the previous account’s suggestions as soon as the wrapper is typed over', async () => {
    const seenFields: { onValueChange: (next: string) => void }[] = [];
    const base = fakeSlot([LOGE, ATOMI]);
    const { root } = await show({
      summary: stopped({ model: undefined }),
      slot: field => {
        seenFields.push(field);
        return base(field);
      },
    });
    await pickAccount(root, 'codex-auto-atomi');
    expect(datalist(root)).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol']);
    await interact(() => seenFields.at(-1)?.onValueChange('codex-auto-elsewhere'));
    expect(datalist(root)).toEqual([]);
  });

  it('resets its draft when another ferret is shown', async () => {
    const { root, rerender } = await show();
    await pickAccount(root, 'codex-auto-atomi');
    await setValue(modelField(root), 'something-else');
    await rerender({ summary: source({ id: 'another-ferret', model: 'gpt-5.6-terra' }) });
    expect(modelField(root).value).toBe('gpt-5.6-terra');
    expect(control(root, 'Review move').disabled).toBe(true);
  });
});

describe('ChangeAccount asking the agent to stop its background jobs', () => {
  const job = (pid: number, detail: string) => ({
    kind: 'process',
    verdict: 'unknown',
    title: 'A program Ferretry doesn’t recognise is running',
    detail,
    age: '4m',
    blocks: true,
    backgroundJob: true,
    pid,
  });
  const refusedBy = (items: readonly object[]) =>
    refusal('refused: A program Ferretry doesn’t recognise is running', 'move_refused', {
      error: 'refused',
      code: 'move_refused',
      inflight: { status: 'waiting', turn: 3, blockedBy: 'unknown', items, restartsWithCli: 1 },
    });
  const SHELL_JOB = job(5100, '/usr/bin/zsh -c source …/shell-snapshots/snapshot-zsh.sh');
  const SCRIPT_JOB = job(5101, 'bash /tmp/merge-all.sh 765');
  const OWNER_CASE = [SHELL_JOB, SCRIPT_JOB];
  const asked = { messageId: 'move-jobs-5100-5101', jobs: [{ pid: 5100, command: 'zsh' }], alreadyAsked: false };

  const refuse = async (over: Partial<ChangeAccountProps>) => {
    const shown = await show(over);
    await pickAccount(shown.root, 'codex-auto-atomi');
    await review(shown.root);
    await press(shown.root, 'Move and relaunch');
    return shown;
  };
  const askButton = (root: HTMLElement): HTMLElement | null => root.querySelector('[data-agent-jobs-ask-button]');

  it('offers the ask when only the agent’s own jobs block, sends it once, and leaves the retry to the reader', async () => {
    let attempts = 0;
    let asks = 0;
    const { root } = await refuse({
      move: async () => {
        attempts += 1;
        throw refusedBy(OWNER_CASE);
      },
      askToStopJobs: async () => {
        asks += 1;
        return asked;
      },
    } as Partial<ChangeAccountProps>);

    expect(text(root)).toContain('These are jobs the agent started itself');
    expect(text(root)).toContain('pid 5101');
    expect(text(root)).toContain('bash /tmp/merge-all.sh 765');
    await press(root, 'Ask the agent to stop its background jobs');

    expect(asks).toBe(1);
    // The ask moves nothing: the move was attempted once, and only the reader's retry tries again.
    expect(attempts).toBe(1);
    expect(must(root.querySelector('[data-agent-jobs-ask] [role="status"]'), 'status').textContent).toContain('Asked.');
    expect(askButton(root)).toBeNull();
    // Still no force control: the only way on is the safety check again.
    expect(text(root)).toContain('There is no force control');
    await press(root, 'Retry safety check');
    expect(attempts).toBe(2);
    // A fresh refusal offers the ask again; the daemon answers a repeat with the message already queued.
    expect(askButton(root)).not.toBeNull();
  });

  it('never offers the ask when something other than the agent’s own jobs blocks', async () => {
    const stranger = {
      kind: 'process',
      verdict: 'unknown',
      title: 'A program',
      detail: 'vendor --watch',
      blocks: true,
    };
    const { root } = await refuse({
      move: async () => {
        throw refusedBy([SCRIPT_JOB, stranger]);
      },
    });
    expect(text(root)).not.toContain('Ask the agent to stop its background jobs');
  });

  it('says so when the agent was already asked about the same jobs', async () => {
    const { root } = await refuse({
      move: async () => {
        throw refusedBy(OWNER_CASE);
      },
      askToStopJobs: (async () => ({ ...asked, alreadyAsked: true })) as AskToStopJobs,
    });
    await press(root, 'Ask the agent to stop its background jobs');
    expect(text(root)).toContain('already asked about these jobs');
  });

  it('sends nothing and says to retry when the jobs have already stopped', async () => {
    const { root } = await refuse({
      move: async () => {
        throw refusedBy([SCRIPT_JOB]);
      },
      askToStopJobs: async () => {
        throw refusal('none of the agent’s own background jobs is in the way any more', 'no_background_jobs');
      },
    });
    expect(text(root)).toContain('This is a job the agent started itself');
    await press(root, 'Ask the agent to stop its background jobs');
    expect(text(root)).toContain('None of them is running any more');
  });

  it('shows the ask in flight and refuses a second press until it answers', async () => {
    let release!: () => void;
    let asks = 0;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { root } = await refuse({
      move: async () => {
        throw refusedBy(OWNER_CASE);
      },
      askToStopJobs: async () => {
        asks += 1;
        await gate;
        return asked;
      },
    });
    await interact(() => must(askButton(root), 'ask button').click());
    const pending = control(root, 'Asking the agent…');
    expect(pending.disabled).toBe(true);
    expect(pending.querySelector('.animate-spin')).not.toBeNull();
    await interact(() => pending.click());
    await interact(async () => {
      release();
      await gate;
    });
    await settle();
    expect(asks).toBe(1);
    expect(text(root)).toContain('Asked.');
  });

  it('reports a failed ask and keeps the button to try again', async () => {
    const { root } = await refuse({
      move: async () => {
        throw refusedBy(OWNER_CASE);
      },
      askToStopJobs: async () => {
        throw new Error('the daemon did not answer');
      },
    });
    await press(root, 'Ask the agent to stop its background jobs');
    expect(text(root)).toContain('Couldn’t ask the agent: the daemon did not answer');
    expect(control(root, 'Ask the agent to stop its background jobs')).toBeDefined();
  });

  it('offers no ask when the client carried no inventory (only the sentence), and says there is no force', async () => {
    const { root } = await refuse({
      move: async () => {
        throw refusal('refused', 'move_refused');
      },
    });
    expect(text(root)).not.toContain('Ask the agent to stop its background jobs');
    expect(text(root)).toContain('There is no force control');
  });
});
