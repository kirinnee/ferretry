import { afterEach, describe, expect, it } from 'bun:test';
import type { SessionProcess, SessionProcessOutput } from '@ferretry/protocol';
import {
  ProcessesSurface,
  type ProcessesSurfaceProps,
  type ProcessStopper,
} from '../../../src/features/workspace/processes-surface.tsx';
import {
  type ProcessListState,
  type ProcessOutputReader,
  useSessionProcesses,
} from '../../../src/features/workspace/use-session-processes.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import { PROCESS_CHANGED_TEXT, PROCESSES_FORBIDDEN_TEXT } from '../../../src/lib/session-processes.ts';
import { interact, mount, must } from '../../support/dom.ts';
import {
  ALL_PROCESSES,
  COLOURED_TEST_OUTPUT,
  LINT_FAILED,
  outputAnswer,
  PROCESSES_NOW,
  processList,
  TERMINAL_ONLY,
  WATCH_TESTS,
} from '../../support/session-processes.ts';

const daemon = daemonConnection({ daemonId: 'proc-daemon', baseUrl: 'https://proc.example.test', deviceId: 'd' });
const scope = daemonSessionScope(daemon, 'agent-session');

const recorder =
  (stops: string[], signalled: number): ProcessStopper =>
  async (_daemon, _scope, id) => {
    stops.push(id);
    return { signalled };
  };

const mounted: { unmount: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const turns = async (count = 12): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
  });
};

const typeInto = async (field: HTMLInputElement, text: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  await interact(() => {
    setter?.call(field, text);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  });
};

const wait = async (ms: number): Promise<void> => {
  await interact(() => new Promise<void>(resolve => setTimeout(resolve, ms)));
};

interface Options {
  readonly state?: ProcessListState;
  readonly readOutput?: ProcessOutputReader;
  readonly stopProcess?: ProcessStopper;
  readonly openId?: string | null;
  readonly compact?: boolean;
  readonly onShowConsole?: () => void;
  readonly outputPollMs?: number;
  readonly clipboard?: string[];
}

const setup = async (options: Options = {}) => {
  let open: string | null = options.openId ?? null;
  const refreshes: number[] = [];
  const view = await mount(<div />);
  const render = async () => {
    const props: ProcessesSurfaceProps = {
      connection: daemon,
      scope,
      state: options.state ?? { status: 'ready', list: ALL_PROCESSES },
      openId: open,
      onOpenChange: id => {
        open = id;
        void render();
      },
      onRefresh: () => refreshes.push(refreshes.length),
      onShowConsole: options.onShowConsole ?? (() => undefined),
      now: () => PROCESSES_NOW,
      ...(options.compact === undefined ? {} : { compact: options.compact }),
      ...(options.readOutput === undefined ? {} : { readOutput: options.readOutput }),
      ...(options.stopProcess === undefined ? {} : { stopProcess: options.stopProcess }),
      ...(options.outputPollMs === undefined ? {} : { outputPollMs: options.outputPollMs }),
      writeClipboard: async text => {
        options.clipboard?.push(text);
      },
    };
    await view.render(<ProcessesSurface {...props} />);
  };
  await render();
  mounted.push(view);
  const q = <T extends Element>(selector: string, what: string): T =>
    must(view.container.querySelector<T>(selector), what);
  const click = async (element: Element): Promise<void> => {
    await interact(() => (element as HTMLElement).click());
  };
  const rowFor = (id: string) => q<HTMLButtonElement>(`[data-process-id="${id}"] .fy-proc-select`, `row ${id}`);
  return { view, q, click, rowFor, refreshes, text: () => view.container.textContent ?? '' };
};

const readerOf = (answers: Record<string, SessionProcessOutput[]>, calls: { id: string; after?: number }[] = []) => {
  const position = new Map<string, number>();
  const reader: ProcessOutputReader = async (_daemon, _scope, id, after) => {
    calls.push({ id, ...(after === undefined ? {} : { after }) });
    const list = answers[id] ?? [];
    const at = Math.min(position.get(id) ?? 0, list.length - 1);
    position.set(id, (position.get(id) ?? 0) + 1);
    return list[at] as SessionProcessOutput;
  };
  return { reader, calls };
};

describe('the process list', () => {
  it('shows one row per top-level process under its group, with kind and elapsed time', async () => {
    const { view, text } = await setup();
    const headings = [...view.container.querySelectorAll('.fy-proc-group__heading')].map(node => node.textContent);
    expect(headings).toEqual(['Running commands', 'Background', 'Helpers', 'Recently ended']);
    expect(text()).toContain('bun test --watch');
    expect(text()).toContain('2m 14s');
    expect(text()).toContain('Wait for the deploy');
    expect(text()).toContain('ended 3m 0s ago · exit 1');
    expect(view.container.querySelector('[data-process-id="201.3"]')).toBeNull();
  });

  it('gives each kind chip its meaning as a tooltip and as text for a screen reader', async () => {
    const { view } = await setup();
    const chips = new Map(
      [...view.container.querySelectorAll<HTMLElement>('.fy-proc-chip')].map(chip => [chip.dataset.kind, chip]),
    );
    expect(chips.get('background')?.title).toBe('Runs in the background');
    expect(chips.get('helper')?.title).toBe('Kept by the agent (helper)');
    expect(chips.get('background')?.querySelector('.sr-only')?.textContent).toContain('Runs in the background');
  });

  it('collapses what a process started under it, and opens it on demand', async () => {
    const { view, q, click } = await setup();
    const expander = q<HTMLButtonElement>('[data-process-id="200.2"] .fy-proc-expander', 'the expander');
    expect(expander.getAttribute('aria-expanded')).toBe('false');
    expect(expander.textContent).toContain('1');
    await click(expander);
    const child = must(view.container.querySelector('[data-process-id="201.3"]'), 'the child row');
    expect(child.textContent).toContain('vite --port 5173');
    expect(child.textContent).toContain('server');
    await click(expander);
    expect(view.container.querySelector('[data-process-id="201.3"]')).toBeNull();
  });

  it('says nothing is running when the list is empty', async () => {
    const { text } = await setup({ state: { status: 'ready', list: processList([]) } });
    expect(text()).toContain('Nothing running right now.');
  });

  it('gives the daemon’s reason when it cannot list', async () => {
    const { text } = await setup({
      state: { status: 'ready', list: processList([], { available: false, reason: 'No agent pane is attached yet.' }) },
    });
    expect(text()).toContain('No agent pane is attached yet.');
    expect(text()).not.toContain('Nothing running right now.');
  });

  it('says why this device cannot see the processes when the daemon refuses with 403', async () => {
    const { view } = await setup({ state: { status: 'forbidden' } });
    expect(must(view.container.querySelector('[data-processes-forbidden]'), 'the refusal').textContent).toBe(
      PROCESSES_FORBIDDEN_TEXT,
    );
  });

  it('keeps the last list and says it is old when a read failed', async () => {
    const { text } = await setup({ state: { status: 'stale', list: ALL_PROCESSES, reason: 'network down' } });
    expect(text()).toContain('Showing the last answer — network down');
    expect(text()).toContain('bun test --watch');
  });

  it('says a first read is loading, and a first failure as an error', async () => {
    expect((await setup({ state: { status: 'loading' } })).text()).toContain('Loading processes…');
    expect((await setup({ state: { status: 'error', reason: 'boom' } })).text()).toContain(
      'Could not read the processes — boom',
    );
  });
});

describe('an opened process', () => {
  it('shows the full command, pid, kind, CPU and memory, and follows the output', async () => {
    const { reader, calls } = readerOf({
      '100.1': [
        outputAnswer('100.1', 'one\n', { end: 4, size: 4 }),
        outputAnswer('100.1', 'two\n', { start: 4, end: 8, size: 8 }),
        outputAnswer('100.1', '', { start: 8, end: 8, size: 8, complete: true }),
        outputAnswer('100.1', 'never\n', { start: 8, end: 14, size: 14 }),
      ],
    });
    const { q, rowFor, click } = await setup({ readOutput: reader, outputPollMs: 5 });
    await click(rowFor('100.1'));
    await wait(80);
    const detail = q<HTMLElement>('[data-process-detail="100.1"]', 'the detail');
    expect(detail.textContent).toContain('bun test --watch');
    expect(detail.textContent).toContain('pid 100');
    expect(detail.textContent).toContain('CPU 12%');
    expect(detail.textContent).toContain('48 MB');
    expect(q('.fy-proc-body', 'the body').textContent).toContain('one');
    expect(q('.fy-proc-body', 'the body').textContent).toContain('two');
    expect(calls.map(call => call.after)).toEqual([undefined, 4, 8]);
    expect(q('.fy-proc-body', 'the body').textContent).not.toContain('never');
  });

  it('does not read output while no row is open', async () => {
    const { reader, calls } = readerOf({ '100.1': [outputAnswer('100.1', 'x')] });
    await setup({ readOutput: reader, outputPollMs: 5 });
    await wait(30);
    expect(calls).toEqual([]);
  });

  it('draws ANSI colour as styled text and never as markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>\u001b[31m<b>red</b>\u001b[0m\n';
    const { reader } = readerOf({
      '100.1': [outputAnswer('100.1', COLOURED_TEST_OUTPUT + hostile, { complete: true })],
    });
    const { q, view, rowFor, click } = await setup({ readOutput: reader, outputPollMs: 5 });
    await click(rowFor('100.1'));
    await turns();
    const body = q<HTMLElement>('.fy-proc-body', 'the body');
    expect(body.textContent).toContain('bun test v1.3.13');
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(body.textContent).toContain('<b>red</b>');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(view.container.querySelector('[onerror]')).toBeNull();
    const green = [...body.querySelectorAll<HTMLElement>('span')].find(span => span.textContent === '✓');
    expect(green?.style.color).toBe('var(--fy-ansi-2)');
    const bold = [...body.querySelectorAll<HTMLElement>('span')].find(span => span.textContent === 'bun test');
    expect(bold?.className).toContain('fy-ansi-bold');
    expect(body.textContent).not.toContain('[31m');
  });

  it('finds text, counts the matches and steps through them', async () => {
    const { reader } = readerOf({
      '100.1': [outputAnswer('100.1', 'alpha beta\nBeta again\nno\nbeta last\n', { complete: true })],
    });
    const { q, view, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    await turns();
    await click(q('[aria-label="Find in output"].kt-btn', 'the Find button'));
    const input = q<HTMLInputElement>('input[aria-label="Find in output"]', 'the find box');
    await typeInto(input, 'beta');
    const count = () => q('[data-find-count]', 'the count').textContent;
    expect(count()).toBe('1 of 3');
    expect(view.container.querySelectorAll('[data-match]')).toHaveLength(3);
    const current = () => [...view.container.querySelectorAll('[data-current-match]')].map(node => node.textContent);
    expect(current()).toEqual(['beta']);
    const press = async (shiftKey: boolean) =>
      interact(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
      });
    await press(false);
    expect(count()).toBe('2 of 3');
    expect(current()).toEqual(['Beta']);
    await press(false);
    await press(false);
    expect(count()).toBe('1 of 3');
    await press(true);
    expect(count()).toBe('3 of 3');
    await click(q('[aria-label="Next match"]', 'next'));
    expect(count()).toBe('1 of 3');
    await click(q('[aria-label="Previous match"]', 'previous'));
    expect(count()).toBe('3 of 3');
  });

  it('opens Find on Ctrl+F inside the pane and says when nothing matches', async () => {
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', 'abc\n', { complete: true })] });
    const { q, view, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    await turns();
    expect(view.container.querySelector('[role="search"]')).toBeNull();
    await interact(() => {
      q('.fy-proc-body', 'the body').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const input = q<HTMLInputElement>('input[aria-label="Find in output"]', 'the find box');
    await typeInto(input, 'zzz');
    expect(q('[data-find-count]', 'the count').textContent).toBe('No matches');
    await interact(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(view.container.querySelector('[role="search"]')).toBeNull();
  });

  it('copies the output without its escapes and says so', async () => {
    const copied: string[] = [];
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', COLOURED_TEST_OUTPUT, { complete: true })] });
    const { q, view, rowFor, click } = await setup({ readOutput: reader, clipboard: copied });
    await click(rowFor('100.1'));
    await turns();
    await click(q('[aria-label="Copy output"]', 'Copy'));
    await turns();
    expect(copied).toEqual(['bun test v1.3.13\n✓ adds numbers\n✗ fails loudly\n 2 pass, 1 fail']);
    expect(view.container.querySelector('[data-action-toast]')?.textContent).toContain('Copied');
  });

  it('explains output that cannot be read and offers the Console', async () => {
    let consoles = 0;
    const { q, rowFor, click } = await setup({ onShowConsole: () => (consoles += 1) });
    await click(rowFor('500.6'));
    expect(q('[data-output-none]', 'the note').textContent).toContain(TERMINAL_ONLY.output.reason as string);
    await click(q('[data-output-none] button', 'the Console button'));
    expect(consoles).toBe(1);
  });

  it('says a finished process’s output is the conversation’s final result', async () => {
    const { reader } = readerOf({
      '400.5': [outputAnswer('400.5', 'lint failed\n', { source: 'transcript', complete: true })],
    });
    const { q, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('400.5'));
    await turns();
    expect(q('[data-output-note="transcript"]', 'the note').textContent).toBe('Final result from the conversation');
    expect(q('.fy-proc-body', 'the body').textContent).toContain('lint failed');
  });

  it('says earlier output is not shown when the daemon skipped it', async () => {
    const { reader } = readerOf({
      '100.1': [outputAnswer('100.1', 'tail\n', { skipped: true, start: 900, end: 905, size: 905 })],
    });
    const { q, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    await turns();
    expect(q('[data-output-note="skipped"]', 'the note').textContent).toBe('Earlier output not shown');
  });

  it('drops what it held when the output was reset', async () => {
    const { reader } = readerOf({
      '100.1': [
        outputAnswer('100.1', 'old text\n', { end: 9, size: 9 }),
        outputAnswer('100.1', 'fresh\n', { reset: true, start: 0, end: 6, size: 6, complete: true }),
      ],
    });
    const { q, rowFor, click } = await setup({ readOutput: reader, outputPollMs: 5 });
    await click(rowFor('100.1'));
    await wait(60);
    const body = q('.fy-proc-body', 'the body').textContent ?? '';
    expect(body).toContain('fresh');
    expect(body).not.toContain('old text');
  });

  it('says why this device cannot read the output when the daemon refuses with 403', async () => {
    const reader: ProcessOutputReader = async () => {
      throw new DaemonResponseError(403, 'forbidden');
    };
    const { q, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    await turns();
    expect(q('.fy-proc-body [role="alert"]', 'the alert').textContent).toBe(PROCESSES_FORBIDDEN_TEXT);
  });

  it('closes, and on a phone the list shrinks to the open row with a way back', async () => {
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', 'x\n', { complete: true })] });
    const { q, view, rowFor, click } = await setup({ readOutput: reader, compact: true });
    await click(rowFor('100.1'));
    expect(view.container.querySelectorAll('.fy-proc-item')).toHaveLength(1);
    expect(view.container.querySelector('.fy-proc-group')).toBeNull();
    expect(q('[aria-label="Close process"]', 'back').textContent).toContain('Back');
    await click(q('[aria-label="Close process"]', 'back'));
    expect(view.container.querySelector('[data-process-detail]')).toBeNull();
    expect(view.container.querySelectorAll('.fy-proc-group').length).toBeGreaterThan(0);
  });

  it('offers Stop only for a process the daemon says may be stopped', async () => {
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', 'x')], '400.5': [outputAnswer('400.5', 'x')] });
    const { view, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    const stops = () =>
      [...view.container.querySelectorAll('.fy-proc-detail__actions button')].map(b => b.textContent?.trim());
    expect(stops()).toContain('Stop');
    await click(rowFor('400.5'));
    expect(stops()).not.toContain('Stop');
  });
});

describe('stopping a process', () => {
  const openStop = async (options: Options) => {
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', 'x')] });
    const ctx = await setup({ readOutput: reader, ...options });
    await ctx.click(ctx.rowFor('100.1'));
    const stop = must(
      [...ctx.view.container.querySelectorAll<HTMLButtonElement>('.fy-proc-detail__actions button')].find(button =>
        button.textContent?.includes('Stop'),
      ),
      'Stop',
    );
    await ctx.click(stop);
    return ctx;
  };

  it('asks first, naming the command and what will happen to what it started', async () => {
    const stops: string[] = [];
    const { view } = await openStop({ stopProcess: recorder(stops, 1) });
    const dialog = must(view.container.querySelector('[role="dialog"]'), 'the confirmation');
    expect(dialog.querySelector('[data-stop-sentence]')?.textContent).toBe(
      'Stop bun test --watch? It and anything it started will be asked to quit (SIGTERM).',
    );
    expect(stops).toEqual([]);
  });

  it('does nothing when cancelled', async () => {
    const stops: string[] = [];
    const { view, click } = await openStop({ stopProcess: recorder(stops, 1) });
    const cancel = must(
      [...view.container.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Cancel'),
      'Cancel',
    );
    await click(cancel);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(stops).toEqual([]);
  });

  it('sends the stop, then says how many processes were asked to quit and reads the list again', async () => {
    const stops: string[] = [];
    const { view, click, refreshes } = await openStop({
      stopProcess: recorder(stops, 3),
    });
    const confirm = must(
      [...view.container.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Stop'),
      'the confirm button',
    );
    await click(confirm);
    await turns();
    expect(stops).toEqual(['100.1']);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container.querySelector('[data-action-toast]')?.textContent).toContain('Stopped (3 processes)');
    expect(refreshes.length).toBe(1);
  });

  it('says one process in the singular', async () => {
    const { view, click } = await openStop({ stopProcess: async () => ({ signalled: 1 }) });
    await click(
      must(
        [...view.container.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Stop'),
        'Stop',
      ),
    );
    await turns();
    expect(view.container.querySelector('[data-action-toast]')?.textContent).toContain('Stopped (1 process)');
  });

  it('shows the daemon’s refusal as a toast', async () => {
    const { view, click } = await openStop({
      stopProcess: async () => {
        throw new DaemonResponseError(400, 'That process is the agent itself.');
      },
    });
    await click(
      must(
        [...view.container.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Stop'),
        'Stop',
      ),
    );
    await turns();
    expect(view.container.querySelector('[data-action-toast]')?.textContent).toContain(
      'That process is the agent itself.',
    );
  });

  it('says nothing was stopped when the process already ended or was replaced', async () => {
    const { view, click } = await openStop({
      stopProcess: async () => {
        throw new DaemonResponseError(409, 'changed', 'process_changed');
      },
    });
    await click(
      must(
        [...view.container.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Stop'),
        'Stop',
      ),
    );
    await turns();
    expect(view.container.querySelector('[data-action-toast]')?.textContent).toContain(PROCESS_CHANGED_TEXT);
  });
});

describe('a process that leaves the list', () => {
  it('closes its detail rather than showing a process that is gone', async () => {
    const without: SessionProcess[] = [TERMINAL_ONLY, LINT_FAILED];
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', 'x')] });
    const ctx = await setup({ readOutput: reader });
    await ctx.click(ctx.rowFor('100.1'));
    expect(ctx.view.container.querySelector('[data-process-detail="100.1"]')).not.toBeNull();
    await ctx.view.render(
      <ProcessesSurface
        connection={daemon}
        onOpenChange={() => undefined}
        onShowConsole={() => undefined}
        openId="100.1"
        scope={scope}
        state={{ status: 'ready', list: processList(without) }}
      />,
    );
    expect(WATCH_TESTS.id).toBe('100.1');
    expect(ctx.view.container.querySelector('[data-process-detail="100.1"]')).toBeNull();
  });
});

describe('following the output', () => {
  const scrollTo = async (body: HTMLElement, top: number): Promise<void> => {
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 });
    body.scrollTop = top;
    await interact(() => {
      body.dispatchEvent(new Event('scroll'));
    });
  };

  it('stops following when the reader scrolls up, offers Jump to latest, and follows again once back at the end', async () => {
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', 'a\nb\nc\n')] });
    const { view, q, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    await turns();
    const body = q<HTMLElement>('.fy-proc-body', 'the body');
    expect(view.container.querySelector('.fy-proc-jump')).toBeNull();

    await scrollTo(body, 0);
    await click(q('.fy-proc-jump', 'Jump to latest'));
    expect(view.container.querySelector('.fy-proc-jump')).toBeNull();

    await scrollTo(body, 0);
    expect(view.container.querySelector('.fy-proc-jump')).not.toBeNull();
    await scrollTo(body, 790);
    expect(view.container.querySelector('.fy-proc-jump')).toBeNull();
  });

  it('says why the output cannot be read when the daemon fails before anything arrived', async () => {
    const reader: ProcessOutputReader = async () => {
      throw new Error('daemon down');
    };
    const { q, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    await turns();
    expect(q('.fy-proc-body [role="alert"]', 'the alert').textContent).toBe('daemon down');
  });

  it('keeps what it has and says it is not up to date when a later read fails', async () => {
    let reads = 0;
    const reader: ProcessOutputReader = async () => {
      reads += 1;
      if (reads > 1) throw new Error('daemon down');
      return outputAnswer('100.1', 'first\n');
    };
    const { q, rowFor, click } = await setup({ readOutput: reader, outputPollMs: 5 });
    await click(rowFor('100.1'));
    await wait(60);
    expect(q('.fy-proc-note--warn', 'the note').textContent).toBe('Not up to date — daemon down');
    expect(q('.fy-proc-body', 'the body').textContent).toContain('first');
  });

  it('reads again the moment the page is shown again', async () => {
    const { reader, calls } = readerOf({ '100.1': [outputAnswer('100.1', 'x\n')] });
    const { rowFor, click } = await setup({ readOutput: reader, outputPollMs: 60_000 });
    await click(rowFor('100.1'));
    await turns();
    expect(calls).toHaveLength(1);
    await interact(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await turns();
    expect(calls).toHaveLength(2);
  });
});

describe('the process list while the page is hidden', () => {
  const Probe = ({ reads }: { readonly reads: number[] }) => {
    const { state } = useSessionProcesses({
      connection: daemon,
      scope,
      visible: true,
      pollMs: 60_000,
      reader: async () => {
        reads.push(reads.length);
        return ALL_PROCESSES;
      },
    });
    return <span data-status={state.status} />;
  };

  it('reads again the moment the page is shown again', async () => {
    const reads: number[] = [];
    const view = await mount(<Probe reads={reads} />);
    mounted.push(view);
    await turns();
    expect(reads).toHaveLength(1);
    await interact(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await turns();
    expect(reads).toHaveLength(2);
  });
});

describe('opening a child process', () => {
  it('shows it under its parent even though the parent was collapsed', async () => {
    const { reader } = readerOf({ '201.3': [outputAnswer('201.3', 'ready\n', { complete: true })] });
    const { view } = await setup({ readOutput: reader, openId: '201.3' });
    await turns();
    expect(view.container.querySelector('[data-process-id="201.3"]')).not.toBeNull();
    expect(view.container.querySelector('[data-process-detail="201.3"]')).not.toBeNull();
  });
});

describe('inverse colours in the output', () => {
  it('swaps foreground and background, falling back to the code theme for the side with no colour', async () => {
    const text = '\u001b[7mA\u001b[0m \u001b[7;31mB\u001b[0m \u001b[7;42mC\u001b[0m \u001b[7;31;42mD\u001b[0m\n';
    const { reader } = readerOf({ '100.1': [outputAnswer('100.1', text, { complete: true })] });
    const { view, rowFor, click } = await setup({ readOutput: reader });
    await click(rowFor('100.1'));
    await turns();
    const styled = new Map(
      [...view.container.querySelectorAll<HTMLElement>('.fy-proc-body span[style]')].map(span => [
        span.textContent,
        span.getAttribute('style') ?? '',
      ]),
    );
    const has = (letter: string, color: string, background: string): void => {
      const style = styled.get(letter) ?? '';
      expect(style).toContain(`color: ${color}`);
      expect(style).toContain(`background-color: ${background}`);
    };
    has('A', 'var(--code-bg)', 'var(--code-fg)');
    has('B', 'var(--code-bg)', 'var(--fy-ansi-1)');
    has('C', 'var(--fy-ansi-2)', 'var(--code-fg)');
    has('D', 'var(--fy-ansi-2)', 'var(--fy-ansi-1)');
  });
});
