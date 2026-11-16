/**
 * The list's live read. NEW (v4 had none: it read a store, not a route): read on mount, re-read on `ferrets.changed`
 * with at most one read in flight and one queued, a `gone` ferret dropped at once, a failed re-read keeping the rows.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { STALE_LIST, useFerretList } from '../../../../app/features/list/use-ferret-list.ts';
import { UNREADABLE_LIST } from '../../../../app/features/list/list-wire.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { ferretSummary } from '../header/support.ts';
import { type ListDaemon, listDaemon } from './support.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

function Probe({ daemon, on }: { readonly daemon: ListDaemon; readonly on?: (retry: () => void) => void }) {
  const { read, retry } = useFerretList(daemon.client);
  on?.(retry);
  return (
    <p data-kind={read.kind} data-stale={read.kind === 'ready' && read.stale ? '' : undefined}>
      {read.kind === 'ready'
        ? read.ferrets.map(ferret => ferret.id).join(',')
        : read.kind === 'failed'
          ? read.sentence
          : ''}
    </p>
  );
}

const probe = async (daemon: ListDaemon, on?: (retry: () => void) => void): Promise<HTMLElement> => {
  mounted = await mount(<Probe daemon={daemon} on={on} />);
  await settle();
  return mounted.container.querySelector('p') as HTMLElement;
};

describe('the live ferret list', () => {
  it('reads on mount and says it is loading until the answer arrives', async () => {
    const daemon = listDaemon([ferretSummary('a'), ferretSummary('b')]);
    let release = (): void => undefined;
    daemon.hold = new Promise<void>(resolve => (release = resolve));
    mounted = await mount(<Probe daemon={daemon} />);
    expect(mounted.container.querySelector('p')?.getAttribute('data-kind')).toBe('loading');
    release();
    await settle();
    expect(mounted.container.querySelector('p')?.textContent).toBe('a,b');
    expect(daemon.reads).toBe(1);
  });

  it('re-reads on ferrets.changed, at most one in flight, and drops a gone ferret at once', async () => {
    const daemon = listDaemon([ferretSummary('a'), ferretSummary('b')]);
    const line = await probe(daemon);
    expect(daemon.reads).toBe(1);

    // Five events while one read is held: one in flight and ONE queued, not five.
    let release = (): void => undefined;
    daemon.hold = new Promise<void>(resolve => (release = resolve));
    daemon.ferrets = [ferretSummary('a'), ferretSummary('b'), ferretSummary('c')];
    await interact(() => {
      for (let count = 0; count < 5; count += 1) daemon.announce('c');
    });
    expect(daemon.reads).toBe(2);
    daemon.hold = undefined;
    release();
    await settle();
    expect(daemon.reads).toBe(3);
    expect(line.textContent).toBe('a,b,c');

    // `gone` drops the row before the read answers.
    let finish = (): void => undefined;
    daemon.hold = new Promise<void>(resolve => (finish = resolve));
    daemon.ferrets = [ferretSummary('a'), ferretSummary('c')];
    await interact(() => daemon.announce('b', true));
    expect(line.textContent).toBe('a,c');
    expect(daemon.reads).toBe(4);
    daemon.hold = undefined;
    finish();
    await settle();
    expect(line.textContent).toBe('a,c');
  });

  it('a failed re-read keeps the rows and says they may be stale; the next good read clears it', async () => {
    const daemon = listDaemon([ferretSummary('a')]);
    const line = await probe(daemon);
    daemon.failWith = new Error('the daemon is unreachable');
    await interact(() => daemon.announce('a'));
    await settle();
    expect(line.textContent).toBe('a');
    expect(line.hasAttribute('data-stale')).toBe(true);
    expect(STALE_LIST).toContain('may be out of date');
    daemon.failWith = undefined;
    await interact(() => daemon.announce('a'));
    await settle();
    expect(line.hasAttribute('data-stale')).toBe(false);
  });

  it('a read that fails before any rows arrived fails in words, and Retry reads again', async () => {
    const daemon = listDaemon([ferretSummary('a')]);
    daemon.failWith = new Error('the daemon is unreachable');
    let retry = (): void => undefined;
    const line = await probe(daemon, run => (retry = run));
    expect(line.getAttribute('data-kind')).toBe('failed');
    expect(line.textContent).toBe('the daemon is unreachable');
    daemon.failWith = undefined;
    await interact(() => retry());
    await settle();
    expect(line.getAttribute('data-kind')).toBe('ready');
    // A gone event before anything was read changes nothing on screen but still asks for a read.
    const waiting = listDaemon([ferretSummary('z')]);
    let release = (): void => undefined;
    waiting.hold = new Promise<void>(resolve => (release = resolve));
    await mounted?.unmount();
    mounted = await mount(<Probe daemon={waiting} />);
    await interact(() => waiting.announce('z', true));
    expect(mounted.container.querySelector('p')?.getAttribute('data-kind')).toBe('loading');
    waiting.hold = undefined;
    release();
    await settle();
    expect(mounted.container.querySelector('p')?.textContent).toBe('z');
    await mounted.unmount();
    const early = listDaemon([ferretSummary('z')]);
    early.failWith = 'not an error object' as never;
    const failed = await probe(early);
    expect(failed.textContent).toBe('not an error object');
  });

  it('an element that does not parse fails the read in words', async () => {
    const daemon = listDaemon([ferretSummary('a')]);
    daemon.ferrets = [{ id: 'broken' } as never];
    const line = await probe(daemon);
    expect(line.getAttribute('data-kind')).toBe('failed');
    expect(line.textContent).toBe(UNREADABLE_LIST);
  });

  it('S-0405 reads through the conditional route where the client has one, and a gone event reads unconditionally', async () => {
    const daemon = listDaemon([ferretSummary('a'), ferretSummary('b')], { conditional: true });
    const line = await probe(daemon);
    expect(line.textContent).toBe('a,b');
    daemon.ferrets = [ferretSummary('a')];
    await interact(() => daemon.announce('b', true));
    await settle();
    expect(line.textContent).toBe('a');
  });

  it('stops listening and ignores a read that lands after it was closed', async () => {
    const daemon = listDaemon([ferretSummary('a')]);
    let release = (): void => undefined;
    daemon.hold = new Promise<void>(resolve => (release = resolve));
    mounted = await mount(<Probe daemon={daemon} />);
    expect(daemon.listeners.size).toBe(1);
    await mounted.unmount();
    expect(daemon.listeners.size).toBe(0);
    release();
    await settle();
    // A failure after unmount is ignored too.
    const failing = listDaemon([ferretSummary('a')]);
    failing.failWith = new Error('late');
    let go = (): void => undefined;
    failing.hold = new Promise<void>(resolve => (go = resolve));
    mounted = await mount(<Probe daemon={failing} />);
    await mounted.unmount();
    go();
    await settle();
    expect(failing.reads).toBe(1);
  });

  it('a client with no event feed still reads once', async () => {
    const daemon = listDaemon([ferretSummary('a')]);
    const quiet = { call: daemon.client.call };
    function Quiet() {
      const { read } = useFerretList(quiet);
      return <p>{read.kind === 'ready' ? read.ferrets.length : read.kind}</p>;
    }
    mounted = await mount(<Quiet />);
    await settle();
    expect(mounted.container.textContent).toBe('1');
  });
});
