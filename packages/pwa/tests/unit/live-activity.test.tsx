import { afterEach, describe, expect, test } from 'bun:test';
import { LiveActivityLine, type PaneFrameReader, usePaneActivity } from '../../src/components/live-activity.tsx';
import { type PaneReading, UNREAD_PANE } from '../../src/lib/session-activity.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value !== null && typeof value === 'object' && 'children' in value)
    return textOf((value as { readonly children: unknown }).children);
  return '';
};

let seen: PaneReading | 'unset' = 'unset';
/** The status line the last reading carried, or `null` when there was none (or nothing was read). */
const line = () => (seen === 'unset' ? 'unset' : seen.activity);
function Probe({ read, active }: { readonly read: PaneFrameReader | undefined; readonly active: boolean }) {
  seen = usePaneActivity(read, active, 5);
  return null;
}

afterEach(() => {
  seen = 'unset';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('usePaneActivity', () => {
  test('reads the pane while active, keeps reading, and clears when the session goes idle', async () => {
    const frames = ['✽ Pontificating… (1s · esc to interrupt)', '✽ Pontificating… (2s · esc to interrupt)'];
    let reads = 0;
    const read: PaneFrameReader = async () => frames[Math.min(reads++, 1)] as string;
    const view = render(<Probe active read={read} />);
    await settleUntil(
      () => line() !== null && line() !== 'unset' && (line() as { elapsed?: string }).elapsed === '2s',
      'the second frame',
      runAsync,
    );
    expect(seen).toMatchObject({ read: true });
    run(() => view.update(<Probe active={false} read={read} />));
    expect(seen).toEqual(UNREAD_PANE);
    const after = reads;
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 30)));
    expect(reads).toBe(after);
    run(() => view.unmount());
  });

  test('a frame with no status line is READ, and carries no activity — an agent at its prompt', async () => {
    const read: PaneFrameReader = async () => '❯ \n  ? for shortcuts';
    const view = render(<Probe active read={read} />);
    await settleUntil(() => seen !== 'unset' && seen.read, 'a first reading', runAsync);
    expect(seen).toEqual({ read: true, activity: null });
    run(() => view.unmount());
  });

  test('a failed read clears the line instead of keeping a stale verb', async () => {
    let fail = false;
    const read: PaneFrameReader = async () => {
      if (fail) throw new Error('pane gone');
      return '✻ Thinking…';
    };
    const view = render(<Probe active read={read} />);
    await settleUntil(() => line() !== null && line() !== 'unset', 'a first reading', runAsync);
    fail = true;
    await settleUntil(() => seen !== 'unset' && !seen.read, 'the failure to clear the line', runAsync);
    expect(seen).toEqual(UNREAD_PANE);
    run(() => view.unmount());
  });

  test('reads nothing while the page is hidden or no reader is wired', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    let reads = 0;
    const read: PaneFrameReader = async () => {
      reads += 1;
      return '✻ Thinking…';
    };
    const view = render(<Probe active read={read} />);
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 30)));
    expect(reads).toBe(0);
    run(() => view.update(<Probe active read={undefined} />));
    expect(seen).toEqual(UNREAD_PANE);
    run(() => view.unmount());
  });

  test('an answer that lands after the session went idle is discarded', async () => {
    let release: (frame: string) => void = () => undefined;
    const read: PaneFrameReader = () =>
      new Promise<string>(resolve => {
        release = resolve;
      });
    const view = render(<Probe active read={read} />);
    run(() => view.update(<Probe active={false} read={read} />));
    await runAsync(async () => release('✻ Late…'));
    expect(seen).toEqual(UNREAD_PANE);
    run(() => view.unmount());
  });

  test('a failure that lands after the session went idle is discarded too', async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const read: PaneFrameReader = () =>
      new Promise<string>((_resolve, no) => {
        reject = no;
      });
    const view = render(<Probe active read={read} />);
    run(() => view.update(<Probe active={false} read={read} />));
    await runAsync(async () => reject(new Error('late')));
    expect(seen).toEqual(UNREAD_PANE);
    run(() => view.unmount());
  });
});

describe('LiveActivityLine', () => {
  test('prints the harness’s own verb and numbers', () => {
    const view = render(
      <LiveActivityLine
        activity={{ harness: 'claude', verb: 'Pontificating…', elapsed: '42s', tokens: '↓ 3.1k tokens' }}
      />,
    );
    const status = view.root.findByProps({ role: 'status' });
    expect(status.props['data-activity-harness']).toBe('claude');
    expect(textOf(view.toJSON())).toBe('Pontificating… 42s · ↓ 3.1k tokens');
  });

  test('falls back to the daemon’s sentence, then to Working…', () => {
    expect(textOf(render(<LiveActivityLine activity={null} fallback="Editing app.tsx (3s)" />).toJSON())).toBe(
      'Editing app.tsx',
    );
    const bare = render(<LiveActivityLine activity={{ harness: 'codex', verb: 'Working…' }} />);
    expect(textOf(bare.toJSON())).toBe('Working…');
    const none = render(<LiveActivityLine activity={null} />);
    expect(none.root.findByProps({ role: 'status' }).props['data-activity-harness']).toBe('unknown');
    expect(textOf(none.toJSON())).toBe('Working…');
  });
});
