import { describe, expect, test } from 'bun:test';

import { browserTerminalDeckDependencies, SessionTerminalDeck } from '../../src/components/session-terminal-deck.tsx';
import { RECONNECTING_GRACE_MS } from '../../src/lib/connection-health.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { grantRefusalNotice } from '../../src/lib/grants.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import { TERMINAL_REOPEN_BASE_MS } from '../../src/lib/terminal-co-control.ts';
import { TerminalStreamRefused } from '../../src/lib/web-terminals.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { fakeDeck, terminalListing, terminalView, xtermSpy } from '../support/terminal-deck.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'beta-token',
});
const scopeAlpha = daemonSessionScope(alpha, 'shared');
const scopeBeta = daemonSessionScope(beta, 'shared');

const FIRST = 'a1b2c3d4e5f6';
const SECOND = '0f0e0d0c0b0a';

/** Lets the listing promise, the ticket promise and their state writes settle. */
const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};

/** Waits past the lamp's quiet window, so a drop that is still out is now said. */
const outlastGrace = async (): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, RECONNECTING_GRACE_MS + 100));
  });
  await settle();
};

type Rendered = ReturnType<typeof render>;

const buttonNamed = (page: Rendered, label: string) => {
  const found = page.root
    .findAll(node => node.type === 'button')
    .find(node => {
      const props = node.props as Record<string, unknown>;
      const name = typeof props['aria-label'] === 'string' ? props['aria-label'] : '';
      return name.includes(label);
    });
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  return found;
};

const clickNamed = (page: Rendered, label: string): void => {
  run(() => (buttonNamed(page, label).props as { onClick: () => void }).onClick());
};

const json = (page: Rendered): string => JSON.stringify(page.toJSON());

/**
 * A measurable host node for the canvas ref.
 *
 * react-test-renderer creates no DOM, so a `ref` on a host element is null and
 * the canvas effect would bail before it ever loaded the emulator — meaning no
 * socket, and none of the link behaviour under test. `createNodeMock` is the
 * renderer's own seam for exactly this, and the two measurements are all the
 * effect reads.
 */
const mount = (element: Parameters<typeof render>[0]): Rendered =>
  render(element, { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400 }) });

describe('SessionTerminalDeck', () => {
  test('lists the daemon own shells as tabs and opens the first one', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST), terminalView(SECOND)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    const output = json(page);
    expect(output).toContain('Terminal a');
    expect(output).toContain('Terminal 0');
    expect(output).toContain('2/6 in this session');
    run(() => page.unmount());
  });

  test('says plainly when the session holds no shell rather than showing an empty deck', async () => {
    const deck = fakeDeck(async () => terminalListing([]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(json(page)).toContain('No shell terminals open');
    run(() => page.unmount());
  });

  test('puts the surface status in the one toolbar row, beside the actions, not in a bar of its own', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(
      <SessionTerminalDeck
        connection={alpha}
        dependencies={deck.dependencies}
        scope={scopeAlpha}
        surfaceStatus={<i data-status-slot="" />}
      />,
    );
    await settle();

    const toolbar = page.root.findAll(node => node.props.className === 'kt-webterm__toolbar')[0];
    expect(toolbar?.findAllByProps({ 'data-status-slot': '' })).toHaveLength(1);
    expect(page.root.findAllByProps({ 'data-status-slot': '' })).toHaveLength(1);
    run(() => page.unmount());
  });

  test('keeps the surface status reachable when the shell is gone, so an ask can still be dismissed', async () => {
    const deck = fakeDeck(async () => terminalListing([]));
    const page = mount(
      <SessionTerminalDeck
        connection={alpha}
        dependencies={deck.dependencies}
        scope={scopeAlpha}
        focusTerminalId={FIRST}
        surfaceStatus={<i data-status-slot="" />}
        solo
      />,
    );
    await settle();

    const fallback = page.root.findAll(node => node.props.className === 'kt-webterm__status-fallback');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.findAllByProps({ 'data-status-slot': '' })).toHaveLength(1);
    run(() => page.unmount());
  });

  test('refuses a listing about another session instead of showing its shells', async () => {
    // Damaged evidence, not an empty session: rendering it would put another
    // session's shells under this one's tabs, and every reference on them would
    // address a terminal this deck is not showing.
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST, {}, 'other')], 'other'));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    const output = json(page);
    expect(output).toContain('answered about a different session');
    expect(output).not.toContain('Terminal a');
    run(() => page.unmount());
  });

  test('warns that an agent may be driving the shell before the reader types into it', async () => {
    const deck = fakeDeck(async () =>
      terminalListing([terminalView(FIRST, { openedBy: { by: 'agent', sessionId: 'mse7wwti' } })]),
    );
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    const output = json(page);
    expect(output).toContain('An agent opened this shell and may be driving it');
    expect(output).toContain('You can type at the same time.');
    run(() => page.unmount());
  });

  test('never tells a reader they are alone in a shell the daemon cannot attribute', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(json(page)).toContain('did not record who opened this shell');
    run(() => page.unmount());
  });

  test('opens a stream bound to this daemon and this session, never a bare session id', async () => {
    // Two daemons routinely know a session by the same id. A stream URL built
    // from the id alone would attach one daemon's viewer to another's shell.
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(deck.urls).toEqual([`wss://alpha/v1/sessions/shared/terminals/${FIRST}/stream?ticket=t`]);
    run(() => page.unmount());
  });

  test('detaches the socket when the deck goes away, with the normal close code', async () => {
    // 1000 is what tells the daemon this viewer left on purpose — and what stops
    // the deck reconnecting to a pane nobody is looking at.
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    run(() => page.unmount());

    expect(deck.sockets[0]?.closes[0]?.code).toBe(1000);
  });

  test('goes live and sizes the pane once the socket opens', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const socket = deck.sockets[0];
    if (socket === undefined) throw new Error('the deck opened no socket');
    await runAsync(async () => {
      socket.emit('open');
      await Promise.resolve();
    });

    expect(json(page)).toContain('live');
    run(() => page.unmount());
  });

  test('reports a daemon refusal as refused rather than promising a reconnect', async () => {
    // 1008 is the daemon judging this client's frames. Saying "reconnecting"
    // would promise a retry that will never be attempted.
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const socket = deck.sockets[0];
    if (socket === undefined) throw new Error('the deck opened no socket');
    await runAsync(async () => {
      socket.emit('open');
      socket.emit('close', { code: 1008 });
      await Promise.resolve();
    });

    expect(json(page)).toContain('refused');
    run(() => page.unmount());
  });

  /*
   * A refusal that arrives BEFORE the stream ever opens, which is what a relayed carrier does.
   * `docs/relay-protocol.md` §14 gives `stream-refused` a status so "it is gone" can be told from
   * "the daemon broke" — a 403 the capability guard decided, a 404 for a terminal that was never
   * opened — and it is final for that attempt. Retrying would ask a permanent refusal the same
   * question at fifteen-second intervals forever, so the deck says refused and stops.
   */
  test('reports a stream the daemon refused outright, and does not retry it', async () => {
    let attempts = 0;
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      attach: async (_daemon, _scope, _id, handlers) => {
        attempts += 1;
        handlers.onRefused(403, 'the operator refused this capability');
        throw new TerminalStreamRefused(403, 'the operator refused this capability');
      },
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(attempts).toBe(1);
    expect(json(page)).toContain('refused');
    expect(json(page)).not.toContain('reconnecting');
    run(() => page.unmount());
  });

  /*
   * A tab switched away from mid-attach must not leave a stream nobody is watching. The attach is
   * asynchronous on both carriers — a ticket purchase, or a rendezvous handshake — so the pane can
   * be gone by the time it resolves, and what resolves then has to be closed rather than held.
   */
  test('closes a stream that finishes attaching after its pane is gone', async () => {
    const closes: { code: number; reason: string }[] = [];
    let release = (): void => undefined;
    const attached = new Promise<void>(resolve => {
      release = resolve;
    });
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      attach: async () => {
        await attached;
        return {
          write: () => undefined,
          control: () => undefined,
          close: (code: number, reason: string) => closes.push({ code, reason }),
        };
      },
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    run(() => page.unmount());
    await runAsync(async () => {
      release();
      await settle();
    });

    expect(closes).toEqual([{ code: 1000, reason: 'terminal tab detached' }]);
  });

  test('creates, renames and closes a shell through the daemon that owns it', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    clickNamed(page, 'Create terminal');
    await settle();
    expect(json(page)).toContain('Terminal 1');

    clickNamed(page, 'Rename terminal');
    const input = page.root.findAll(node => node.type === 'input')[0];
    if (input === undefined) throw new Error('the rename form did not open');
    run(() => (input.props as { onChange: (event: unknown) => void }).onChange({ target: { value: 'watch' } }));
    const form = page.root.findAll(node => node.type === 'form')[0];
    if (form === undefined) throw new Error('the rename form did not open');
    await runAsync(async () => {
      (form.props as { onSubmit: (event: unknown) => void }).onSubmit({ preventDefault: () => {} });
      await Promise.resolve();
    });
    expect(deck.renamed).toEqual([{ id: '100000000000', title: 'watch' }]);

    clickNamed(page, 'Close terminal process');
    await settle();
    expect(deck.closed).toEqual(['100000000000']);
    run(() => page.unmount());
  });

  test('does not kill a shell the reader declined to close', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    deck.confirm = false;
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    clickNamed(page, 'Close terminal process');
    await settle();

    expect(deck.closed).toEqual([]);
    run(() => page.unmount());
  });

  test('expands to fill the viewport and comes back, for handover #41', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(json(page)).not.toContain('"data-expanded"');
    clickNamed(page, 'Full screen');
    expect(json(page)).toContain('"data-expanded"');
    clickNamed(page, 'Exit full screen');
    expect(json(page)).not.toContain('"data-expanded"');
    run(() => page.unmount());
  });

  test('reports a listing failure without claiming the session has no shells', async () => {
    const deck = fakeDeck(async () => {
      throw new Error('daemon unreachable');
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(json(page)).toContain('daemon unreachable');
    run(() => page.unmount());
  });

  test('words a refused listing as the grant refusal it is, not as a bare HTTP status', async () => {
    const refusal = new DaemonResponseError(403, '', 'grant_not_granted');
    const explanation = grantRefusalNotice(refusal)?.guidance.explanation ?? '';
    expect(explanation).not.toBe('');
    const deck = fakeDeck(async () => {
      throw refusal;
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(json(page)).toContain(explanation);
    run(() => page.unmount());
  });

  test('keeps the shell the reader is on when a fresh listing still holds it', async () => {
    const listing = async () =>
      terminalListing([terminalView(FIRST, { title: 'first' }), terminalView(SECOND, { title: 'second' })]);
    const first = fakeDeck(listing);
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={first.dependencies} scope={scopeAlpha} />);
    await settle();
    const tab = page.root.findAll(
      node => node.type === 'button' && String(node.props.title ?? '').startsWith('second'),
    )[0];
    if (tab === undefined) throw new Error('no second tab');
    run(() => (tab.props as { onClick: () => void }).onClick());
    await settle();

    const second = fakeDeck(listing);
    run(() =>
      page.update(<SessionTerminalDeck connection={alpha} dependencies={second.dependencies} scope={scopeAlpha} />),
    );
    await settle();

    expect(second.urls.every(url => url.includes(SECOND))).toBe(true);
    expect(second.urls).not.toHaveLength(0);
    run(() => page.unmount());
  });

  test('opens the first shell from the empty state even when the listing has not arrived', async () => {
    const deck = fakeDeck(async () => {
      throw new Error('daemon unreachable');
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    const start = page.root.findAll(
      node => node.props.variant === 'primary' && typeof node.props.onClick === 'function',
    )[0];
    if (start === undefined) throw new Error('no New terminal button');
    await runAsync(async () => {
      (start.props as { onClick: () => void }).onClick();
      await Promise.resolve();
    });
    await settle();

    expect(json(page)).not.toContain('daemon unreachable');
    run(() => page.unmount());
  });

  test('never carries one daemon shells into another daemon deck', async () => {
    // The deck is keyed by (daemon, session) at its call site; what this proves
    // is that it asks the NEW daemon rather than reusing the previous answer.
    const alphaDeck = fakeDeck(async () => terminalListing([terminalView(FIRST, { title: 'alpha shell' })]));
    const betaDeck = fakeDeck(async () => terminalListing([terminalView(SECOND, { title: 'beta shell' })]));
    const page = mount(
      <SessionTerminalDeck connection={alpha} dependencies={alphaDeck.dependencies} scope={scopeAlpha} />,
    );
    await settle();
    expect(json(page)).toContain('alpha shell');

    run(() =>
      page.update(<SessionTerminalDeck connection={beta} dependencies={betaDeck.dependencies} scope={scopeBeta} />),
    );
    await settle();

    const output = json(page);
    expect(output).toContain('beta shell');
    expect(output).not.toContain('alpha shell');
    run(() => page.unmount());
  });
});

describe('SessionTerminalDeck co-control', () => {
  test('sends the reader keystrokes into a shell an agent opened, with no turn to wait for', async () => {
    // THE CENTRAL PROPERTY OF #64. The daemon writes whatever any attached
    // socket sends, so the reader typing while an agent is working is not a
    // conflict to be resolved — it is the feature. A deck that buffered, warned
    // or refused here would have turned co-control into "one of you at a time".
    const spy = xtermSpy();
    const deck = fakeDeck(
      async () => terminalListing([terminalView(FIRST, { openedBy: { by: 'agent', sessionId: 'mse7wwti' } })]),
      { loadXterm: async () => spy.modules },
    );
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const socket = deck.sockets[0];
    const pane = spy.instances[0];
    if (socket === undefined || pane === undefined) throw new Error('the deck did not attach a pane');
    await runAsync(async () => {
      socket.emit('open');
      await Promise.resolve();
    });

    run(() => pane.type('ls\r'));

    const typed = socket.sent.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
    expect(typed).toHaveLength(1);
    expect(new TextDecoder().decode(typed[0])).toBe('ls\r');
    run(() => page.unmount());
  });

  test('paints the daemon output the agent produced, so the reader watches it live', async () => {
    const spy = xtermSpy();
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), { loadXterm: async () => spy.modules });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const socket = deck.sockets[0];
    const pane = spy.instances[0];
    if (socket === undefined || pane === undefined) throw new Error('the deck did not attach a pane');

    await runAsync(async () => {
      socket.emit('open');
      socket.emit('message', { data: new TextEncoder().encode('built ok\r\n').buffer });
      await Promise.resolve();
    });

    expect(pane.written.map(bytes => new TextDecoder().decode(bytes))).toEqual(['built ok\r\n']);
    run(() => page.unmount());
  });

  test('drops nothing but says so when the emulator itself cannot be loaded', async () => {
    // There is nothing to retry into, so this is a refusal rather than a
    // reconnect — and an empty black box with no explanation is not an option.
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      loadXterm: () => Promise.reject(new Error('chunk failed')),
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(json(page)).toContain('refused');
    expect(deck.sockets).toHaveLength(0);
    run(() => page.unmount());
  });

  test('retries a stream the ticket exchange refused, because a token survives a network change', async () => {
    let attempts = 0;
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      attach: async () => {
        attempts += 1;
        throw new Error('ticket unavailable');
      },
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(attempts).toBe(1);
    // Said once the outage outlasts the grace, while the fast retries keep failing underneath.
    await outlastGrace();
    expect(attempts).toBeGreaterThan(1);
    expect(json(page)).toContain('reconnecting');
    run(() => page.unmount());
  });
});

describe('SessionTerminalDeck pane wiring', () => {
  test('lets the browser keep copy and paste while every other key reaches the shell', async () => {
    // A terminal that swallowed Ctrl/Cmd+C would make its own output
    // uncopyable, and one that swallowed Ctrl/Cmd+V would make a paste
    // impossible on a laptop. Everything else is shell input, including the
    // same letters without the modifier.
    const spy = xtermSpy({ selection: 'built ok' });
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), { loadXterm: async () => spy.modules });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const pane = spy.instances[0];
    if (pane === undefined) throw new Error('the deck did not attach a pane');

    expect(pane.key({ ctrlKey: true, code: 'KeyC' })).toBe(false);
    expect(pane.key({ metaKey: true, code: 'KeyV' })).toBe(false);
    expect(pane.key({ code: 'KeyC' })).toBe(true);
    expect(pane.key({ ctrlKey: true, altKey: true, code: 'KeyC' })).toBe(true);
    expect(pane.key({ ctrlKey: true, code: 'KeyD' })).toBe(true);
    run(() => page.unmount());
  });

  test('sends a binary-mode paste as the bytes it was, not as re-encoded text', async () => {
    // xterm hands binary input back as one character per byte. Re-encoding that
    // through TextEncoder would turn every byte above 0x7f into two.
    const spy = xtermSpy();
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), { loadXterm: async () => spy.modules });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const socket = deck.sockets[0];
    const pane = spy.instances[0];
    if (socket === undefined || pane === undefined) throw new Error('the deck did not attach a pane');
    await runAsync(async () => {
      socket.emit('open');
      await Promise.resolve();
    });

    run(() => pane.binary(String.fromCharCode(0xff, 0x01)));

    const sent = socket.sent.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
    expect([...(sent[0] ?? [])]).toEqual([0xff, 0x01]);
    run(() => page.unmount());
  });

  test('copies the pane selection the reader made', async () => {
    const spy = xtermSpy({ selection: 'built ok' });
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), { loadXterm: async () => spy.modules });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const pane = spy.instances[0];
    if (pane === undefined) throw new Error('the deck did not attach a pane');

    run(() => pane.select('built ok'));
    clickNamed(page, 'Copy selection');
    await settle();

    expect(deck.copied).toEqual(['built ok']);
    run(() => page.unmount());
  });

  test('says so when the browser refuses clipboard access instead of failing silently', async () => {
    const spy = xtermSpy({ selection: 'built ok' });
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      loadXterm: async () => spy.modules,
      writeClipboard: async () => {
        throw new Error('denied');
      },
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const pane = spy.instances[0];
    if (pane === undefined) throw new Error('the deck did not attach a pane');

    run(() => pane.select('built ok'));
    clickNamed(page, 'Copy selection');
    await settle();

    expect(json(page)).toContain('Clipboard access was denied');
    run(() => page.unmount());
  });

  test('copies nothing when there is no selection to copy', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    clickNamed(page, 'Copy selection');
    await settle();

    expect(deck.copied).toEqual([]);
    run(() => page.unmount());
  });

  test('survives a pane that cannot be measured yet, because a retained tab is exactly that', async () => {
    const spy = xtermSpy({ fitThrows: true });
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), { loadXterm: async () => spy.modules });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const socket = deck.sockets[0];
    if (socket === undefined) throw new Error('the deck opened no socket');

    await runAsync(async () => {
      socket.emit('open');
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    // No resize frame could be measured, and the deck is still attached.
    expect(socket.sent).toHaveLength(0);
    expect(json(page)).toContain('live');
    run(() => page.unmount());
  });

  test('switches tabs to the shell the reader picked', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST), terminalView(SECOND, { title: 'logs' })]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    const tab = page.root
      .findAll(node => node.type === 'button')
      .find(node => (node.props as { id?: string }).id === `web-terminal-tab-${SECOND}`);
    if (tab === undefined) throw new Error('the second tab is missing');
    run(() => (tab.props as { onClick: () => void }).onClick());
    await settle();

    expect(deck.urls.at(-1)).toContain(SECOND);
    run(() => page.unmount());
  });

  test('reconnects after a transport failure and says so while it waits', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    // The network stays down after the drop: every reopen fails, so the outage outlasts the grace.
    const firstAttach = deck.dependencies.attach;
    let attaches = 0;
    deck.dependencies.attach = async (...args) => {
      attaches += 1;
      if (attaches > 1) throw new Error('the address did not answer');
      return await firstAttach(...args);
    };
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    const socket = deck.sockets[0];
    if (socket === undefined) throw new Error('the deck opened no socket');

    await runAsync(async () => {
      socket.emit('open');
      socket.emit('error');
      socket.emit('close', { code: 1006 });
      await Promise.resolve();
    });

    // A drop is unsaid inside the grace — the lamp still says what it said — and said once it outlasts it.
    expect(json(page)).not.toContain('reconnecting');
    await outlastGrace();
    expect(json(page)).toContain('reconnecting');
    run(() => page.unmount());
  });

  test('never says reconnecting for a drop its first fast reopen recovers', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    await runAsync(async () => {
      deck.sockets[0]?.emit('open');
      await Promise.resolve();
    });

    // Act — the socket drops, and the reopen that follows inside 300 ms opens.
    await runAsync(async () => {
      deck.sockets[0]?.emit('close', { code: 1006 });
      await Promise.resolve();
    });
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, TERMINAL_REOPEN_BASE_MS + 50));
    });
    await settle();
    expect(deck.sockets).toHaveLength(2);
    await runAsync(async () => {
      deck.sockets[1]?.emit('open');
      await Promise.resolve();
    });
    await outlastGrace();

    // Assert
    expect(json(page)).toContain('live');
    expect(json(page)).not.toContain('reconnecting');
    run(() => page.unmount());
  });

  test('reopens at once when the daemon is reachable again, keeping the pane it already drew', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const listeners = new Set<() => void>();
    const recovered: string[] = [];
    const dependencies = {
      ...deck.dependencies,
      onRecovered: (daemon: typeof alpha, listener: () => void) => {
        recovered.push(daemon.daemonId);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={dependencies} scope={scopeAlpha} />);
    await settle();
    // Live: a recovery has nothing to do.
    await runAsync(async () => {
      deck.sockets[0]?.emit('open');
      for (const listener of [...listeners]) listener();
      await Promise.resolve();
    });
    expect(deck.sockets).toHaveLength(1);

    await runAsync(async () => {
      deck.sockets[0]?.emit('close', { code: 1006 });
      await Promise.resolve();
    });
    // Waiting out the backoff: no second stream yet.
    expect(deck.sockets).toHaveLength(1);

    // Act — the connection model says the daemon answered again.
    await runAsync(async () => {
      for (const listener of [...listeners]) listener();
      await Promise.resolve();
    });
    await settle();

    // Assert — a second stream, opened now rather than after the backoff, for this daemon.
    expect(deck.sockets).toHaveLength(2);
    expect(recovered.every(id => id === 'alpha')).toBe(true);
    run(() => page.unmount());
    expect(listeners.size).toBe(0);
  });

  test('carries a recovery port through the browser dependencies only when one is given', () => {
    const opener = async () => {
      throw new Error('unused');
    };
    const fetcher = async () => new Response(null);
    expect(browserTerminalDeckDependencies(fetcher, opener).onRecovered).toBeUndefined();
    const port = () => () => undefined;
    expect(browserTerminalDeckDependencies(fetcher, opener, port).onRecovered).toBe(port);
  });

  test('reports a create, rename or close the daemon refused', async () => {
    const refuse = async (): Promise<never> => {
      throw new Error('terminal capacity reached');
    };
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      create: refuse,
      rename: refuse,
      close: refuse,
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    clickNamed(page, 'Create terminal');
    await settle();
    expect(json(page)).toContain('terminal capacity reached');

    clickNamed(page, 'Close terminal process');
    await settle();
    expect(json(page)).toContain('terminal capacity reached');

    clickNamed(page, 'Rename terminal');
    const input = page.root.findAll(node => node.type === 'input')[0];
    const form = page.root.findAll(node => node.type === 'form')[0];
    if (input === undefined || form === undefined) throw new Error('the rename form did not open');
    run(() => (input.props as { onChange: (event: unknown) => void }).onChange({ target: { value: 'watch' } }));
    await runAsync(async () => {
      (form.props as { onSubmit: (event: unknown) => void }).onSubmit({ preventDefault: () => {} });
      await Promise.resolve();
    });
    expect(json(page)).toContain('terminal capacity reached');
    run(() => page.unmount());
  });

  test('leaves the expanded view when the reader presses Escape', async () => {
    // A fixed overlay with no keyboard exit traps whoever opened it by accident.
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    clickNamed(page, 'Full screen');
    expect(json(page)).toContain('"data-expanded"');
    run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(json(page)).not.toContain('"data-expanded"');

    // A key that is not Escape leaves it alone.
    clickNamed(page, 'Full screen');
    run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    expect(json(page)).toContain('"data-expanded"');
    run(() => page.unmount());
  });

  test('keeps plain Escape for the shell and leaves the expanded view on Shift+Escape', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    clickNamed(page, 'Full screen');
    const shell = document.createElement('div');
    shell.setAttribute('data-keyboard-capture', '');
    document.body.appendChild(shell);

    run(() => shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(json(page)).toContain('"data-expanded"');
    run(() => shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true })));
    expect(json(page)).not.toContain('"data-expanded"');
    shell.remove();
    run(() => page.unmount());
  });
});

describe('SessionTerminalDeck theming', () => {
  test('watches document theme attributes through the browser dependency', async () => {
    const priorTheme = document.documentElement.getAttribute('data-theme');
    let markRepainted: () => void = () => {};
    let repaints = 0;
    const repainted = new Promise<void>(resolve => {
      markRepainted = resolve;
    });
    const stopWatchingTheme = browserTerminalDeckDependencies(
      async () => new Response(),
      async () => {
        throw new Error('unused');
      },
    ).watchTheme(() => {
      repaints += 1;
      markRepainted();
    });

    document.documentElement.setAttribute('data-theme', 'terminal-deck-test-theme');
    await repainted;
    expect(repaints).toBe(1);
    stopWatchingTheme();
    if (priorTheme === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', priorTheme);
  });

  test('repaints the pane when the reader changes theme', async () => {
    // The pane is not a DOM node with classes — xterm holds its own colour
    // table, so a theme switch that only changed CSS variables would leave a
    // dark shell sitting in a light page.
    let markTerminalOpened: () => void = () => {};
    const terminalOpened = new Promise<void>(resolve => {
      markTerminalOpened = resolve;
    });
    const spy = xtermSpy({ onOpen: markTerminalOpened });
    let repaint: () => void = () => {};
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      loadXterm: async () => spy.modules,
      watchTheme: callback => {
        repaint = callback;
        return () => {
          repaint = () => {};
        };
      },
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    // A document mutation is observable only after xterm has opened and the
    // canvas has subscribed to it.
    await settle();
    await terminalOpened;

    document.documentElement.setAttribute('data-theme', 'studio-light');
    run(repaint);

    expect(spy.themes.length).toBeGreaterThan(0);
    run(() => page.unmount());
    document.documentElement.removeAttribute('data-theme');
  });

  test('draws in the theme’s monospace stack with the bundled face before the generic, and follows a theme', async () => {
    // `b u n  d e v`: with no installed monospace face the generic resolved to a proportional one, and
    // xterm padded every narrow glyph out to the width of a `W`. The bundled face must come first.
    let markTerminalOpened: () => void = () => {};
    const terminalOpened = new Promise<void>(resolve => {
      markTerminalOpened = resolve;
    });
    const spy = xtermSpy({ onOpen: markTerminalOpened });
    let repaint: () => void = () => {};
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      loadXterm: async () => spy.modules,
      watchTheme: callback => {
        repaint = callback;
        return () => undefined;
      },
    });
    const root = document.documentElement;
    root.style.setProperty('--font-mono', "'Geist Mono', monospace");
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    await terminalOpened;
    const instance = spy.instances[0];
    if (instance === undefined) throw new Error('no emulator was constructed');
    expect(instance.font().initial).toBe(`'Geist Mono', "Ferretry Terminal Mono", monospace`);

    // Another family brings another stack; an unchanged one is not reassigned.
    root.style.setProperty('--font-mono', "'IBM Plex Mono', monospace");
    run(repaint);
    expect(instance.font().current).toBe(`'IBM Plex Mono', "Ferretry Terminal Mono", monospace`);
    run(repaint);
    expect(instance.font().current).toBe(`'IBM Plex Mono', "Ferretry Terminal Mono", monospace`);
    run(() => page.unmount());
    root.style.removeProperty('--font-mono');
  });
});

/**
 * Handover #35 — a `terminal:<id>` side-pane tab is ADDRESSABLE: it selects its
 * own shell rather than dropping the reader on whichever one happens to be
 * first. Damaged evidence (an id this session does not have) changes nothing.
 */
describe('SessionTerminalDeck focused by a side-pane tab', () => {
  const selectedId = (page: Rendered): string | null => {
    const tab = page.root
      .findAll(node => node.type === 'button')
      .find(node => (node.props as Record<string, unknown>)['aria-selected'] === true);
    const controls = tab === undefined ? null : ((tab.props as Record<string, unknown>)['aria-controls'] as string);
    return controls === null ? null : controls.replace('web-terminal-panel-', '');
  };

  test('selects the terminal its tab was opened for, not the first in the listing', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST), terminalView(SECOND)]));
    const page = mount(
      <SessionTerminalDeck
        connection={alpha}
        dependencies={deck.dependencies}
        focusTerminalId={SECOND}
        scope={scopeAlpha}
      />,
    );
    await settle();

    expect(selectedId(page)).toBe(SECOND);
    run(() => page.unmount());
  });

  test('leaves the selection alone when the requested terminal is not in the listing', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST), terminalView(SECOND)]));
    const page = mount(
      <SessionTerminalDeck
        connection={alpha}
        dependencies={deck.dependencies}
        focusTerminalId="ffffffffffff"
        scope={scopeAlpha}
      />,
    );
    await settle();

    // The deck's own default stands; nothing invents a shell to focus.
    expect(selectedId(page)).toBe(FIRST);
    run(() => page.unmount());
  });
});

describe('SessionTerminalDeck as one workspace tab', () => {
  test('shows only its own shell, with no strip of its own, and says so once that shell is gone', async () => {
    let listing = terminalListing([terminalView(FIRST), terminalView(SECOND)]);
    const deck = fakeDeck(async () => listing);
    const page = mount(
      <SessionTerminalDeck
        connection={alpha}
        dependencies={deck.dependencies}
        focusTerminalId={SECOND}
        scope={scopeAlpha}
        solo
      />,
    );
    // Before the listing lands there is nothing to prove the shell against.
    expect(json(page)).toContain('Asking the daemon for this terminal');
    await settle();
    expect(page.root.findAll(node => node.props.role === 'tablist')).toHaveLength(0);
    const canvases = page.root.findAll(node => node.props['data-terminal-canvas'] !== undefined && node.type === 'div');
    expect(canvases.map(node => node.props['data-terminal-canvas'])).toEqual([SECOND]);

    listing = terminalListing([terminalView(FIRST)]);
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_050));
    });
    await settle();
    expect(json(page)).toContain('This terminal is no longer open on the daemon');
    run(() => page.unmount());
  }, 10_000);

  test('rewrites typed keys through the host and hands it a port to type into and focus', async () => {
    const spy = xtermSpy();
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), { loadXterm: async () => spy.modules });
    const ports: Array<{ write: (data: string) => void; focus: () => void } | null> = [];
    const page = mount(
      <SessionTerminalDeck
        connection={alpha}
        dependencies={deck.dependencies}
        focusTerminalId={FIRST}
        interceptInput={data => data.toUpperCase()}
        onInputPort={port => ports.push(port)}
        scope={scopeAlpha}
        solo
      />,
    );
    await settle();
    const socket = deck.sockets[0];
    const pane = spy.instances[0];
    if (socket === undefined || pane === undefined) throw new Error('the deck did not attach a pane');
    await runAsync(async () => {
      socket.emit('open');
      await Promise.resolve();
    });

    run(() => pane.type('ls'));
    const port = ports.at(-1);
    if (port === undefined || port === null) throw new Error('no input port was published');
    run(() => port.write('\u001b'));
    run(() => port.focus());

    const typed = socket.sent
      .filter((frame): frame is Uint8Array => frame instanceof Uint8Array)
      .map(frame => new TextDecoder().decode(frame));
    expect(typed).toEqual(['LS', '\u001b']);
    expect(pane.focused()).toBe(1);
    run(() => page.unmount());
    expect(ports.at(-1)).toBeNull();
  });
});

/** Hides or shows the page the way a backgrounded tab does, and says so to every listener. */
const setPageVisibility = (state: 'hidden' | 'visible'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  run(() => document.dispatchEvent(new Event('visibilitychange')));
};

describe('SessionTerminalDeck on screen', () => {
  const frames = (socket: { readonly sent: unknown[] }): string[] =>
    socket.sent.filter((frame): frame is string => typeof frame === 'string');

  test('holds no stream while its workspace tab is not the one shown, and attaches once it is', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const element = (active: boolean) => (
      <SessionTerminalDeck
        active={active}
        connection={alpha}
        dependencies={deck.dependencies}
        focusTerminalId={FIRST}
        scope={scopeAlpha}
        solo
      />
    );
    const page = mount(element(false));
    await settle();
    // Mounted and listed, but unseen: nothing is attached, so a relay meters nothing for it.
    expect(deck.sockets).toHaveLength(0);

    run(() => page.update(element(true)));
    await settle();
    expect(deck.sockets).toHaveLength(1);

    run(() => page.update(element(false)));
    expect(deck.sockets[0]?.closes).toEqual([{ code: 1000, reason: 'terminal tab detached' }]);
    run(() => page.unmount());
  });

  test('detaches while the page is hidden and attaches a fresh stream when it is shown again', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    expect(deck.sockets).toHaveLength(1);

    try {
      setPageVisibility('hidden');
      expect(deck.sockets[0]?.closes[0]?.code).toBe(1000);
      await settle();
      expect(deck.sockets).toHaveLength(1);

      setPageVisibility('visible');
      await settle();
      expect(deck.sockets).toHaveLength(2);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    run(() => page.unmount());
  });

  test('sizes the stream once however many times the observer reports the same size, and again when it changes', async () => {
    const observers: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      const spy = xtermSpy();
      const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), { loadXterm: async () => spy.modules });
      const page = mount(
        <SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />,
      );
      await settle();
      const socket = deck.sockets[0];
      if (socket === undefined) throw new Error('the deck opened no socket');
      await runAsync(async () => {
        socket.emit('open');
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      expect(frames(socket)).toEqual(['{"type":"resize","cols":80,"rows":24}']);

      // The keyboard coming and going, or a divider drag, reports the size it already was.
      run(() => {
        for (const notify of observers) notify();
        for (const notify of observers) notify();
      });
      expect(frames(socket)).toHaveLength(1);
      run(() => page.unmount());
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  test('tells a reattached stream the size even though the previous stream was told the same', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    const openLatest = async (): Promise<void> => {
      await settle();
      const socket = deck.sockets.at(-1);
      if (socket === undefined) throw new Error('the deck opened no socket');
      await runAsync(async () => {
        socket.emit('open');
        await new Promise(resolve => setTimeout(resolve, 20));
      });
    };
    await openLatest();
    try {
      setPageVisibility('hidden');
      setPageVisibility('visible');
      await openLatest();
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }

    expect(deck.sockets).toHaveLength(2);
    expect(deck.sockets.map(socket => frames(socket))).toEqual([
      ['{"type":"resize","cols":80,"rows":24}'],
      ['{"type":"resize","cols":80,"rows":24}'],
    ]);
    run(() => page.unmount());
  });

  test('sends no size for a pane that cannot be measured, because 80x24 would resize the shell for every viewer', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]));
    const page = render(
      <SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />,
      { createNodeMock: () => ({ clientWidth: 0, clientHeight: 0 }) },
    );
    await settle();
    const socket = deck.sockets[0];
    if (socket === undefined) throw new Error('the deck opened no socket');
    await runAsync(async () => {
      socket.emit('open');
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(frames(socket)).toEqual([]);
    expect(json(page)).toContain('live');
    run(() => page.unmount());
  });
});

describe('SessionTerminalDeck quarantine', () => {
  const until = '2026-10-30T10:02:00.000Z';

  /** The button whose visible text is `label` — these two are worded, not icon buttons. */
  const textButton = (page: Rendered, label: string) =>
    page.root
      .findAll(node => node.type === 'button')
      .find(node => (node.props as { children?: unknown }).children === label);

  const pressText = (page: Rendered, label: string): void => {
    const button = textButton(page, label);
    if (button === undefined) throw new Error(`no "${label}" button`);
    (button.props as { onClick: () => void }).onClick();
  };

  const quarantinedDeck = (key: string) => {
    const ended: string[] = [];
    let held = [{ key, until }];
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST, { name: 'dev' })]), {
      quarantines: async () => ({ quarantines: held }),
      endQuarantine: async (_daemon, _scope, ended_key) => {
        ended.push(ended_key);
        held = [];
        return { ended: true };
      },
    });
    return { deck, ended };
  };

  test('offers both choices when the open terminal is quarantined, by its name or its id', async () => {
    for (const key of ['dev', FIRST]) {
      const { deck } = quarantinedDeck(key);
      const page = mount(
        <SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />,
      );
      await settle();
      expect(textButton(page, 'Show anyway')).toBeDefined();
      expect(textButton(page, 'End quarantine')).toBeDefined();
      expect(json(page)).toContain('hidden from the ferret');
      run(() => page.unmount());
    }
  });

  test('shows nothing about a quarantine on another terminal, or none at all', async () => {
    const { deck } = quarantinedDeck('someone-else');
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    expect(textButton(page, 'Show anyway')).toBeUndefined();
    expect(textButton(page, 'End quarantine')).toBeUndefined();
    run(() => page.unmount());
  });

  test('"Show anyway" reconnects only this viewer with reveal on, and offers it once', async () => {
    const { deck } = quarantinedDeck('dev');
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    expect(deck.reveals).toEqual([false]);

    run(() => pressText(page, 'Show anyway'));
    await settle();
    expect(deck.reveals).toEqual([false, true]);
    expect(deck.sockets[0]?.closes[0]?.code).toBe(1000);
    expect(textButton(page, 'Show anyway')).toBeUndefined();
    expect(textButton(page, 'End quarantine')).toBeDefined();
    run(() => page.unmount());
  });

  test('"End quarantine" posts the end route for the listed key, then reconnects without reveal', async () => {
    const { deck, ended } = quarantinedDeck('dev');
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    await runAsync(async () => {
      pressText(page, 'End quarantine');
      await Promise.resolve();
    });
    await settle();
    expect(ended).toEqual(['dev']);
    expect(deck.reveals).toEqual([false, false]);
    expect(deck.sockets).toHaveLength(2);
    expect(textButton(page, 'End quarantine')).toBeUndefined();
    run(() => page.unmount());
  });

  test('says so and keeps the quarantine when the daemon refuses to end it', async () => {
    const { deck } = quarantinedDeck('dev');
    deck.dependencies.endQuarantine = async () => {
      throw new DaemonResponseError(403, 'only the owner can end a quarantine');
    };
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    await runAsync(async () => {
      pressText(page, 'End quarantine');
      await Promise.resolve();
    });
    await settle();
    expect(json(page)).toContain('only the owner can end a quarantine');
    expect(textButton(page, 'End quarantine')).toBeDefined();
    expect(deck.sockets).toHaveLength(1);
    run(() => page.unmount());
  });

  test('stops reading quarantines when the deck goes away', async () => {
    let reads = 0;
    const deck = fakeDeck(async () => terminalListing([terminalView(FIRST)]), {
      quarantines: async () => {
        reads += 1;
        return { quarantines: [] };
      },
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();
    expect(reads).toBe(1);
    run(() => page.unmount());
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_200));
    });
    expect(reads).toBe(1);
  });
});
