import { describe, expect, test } from 'bun:test';

import { SessionTerminalDeck } from '../../src/components/session-terminal-deck.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { fakeDeck, terminalListing, terminalView, xtermSpy } from '../support/terminal-deck.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
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
    clickNamed(page, 'Expand the terminal to fill the screen');
    expect(json(page)).toContain('"data-expanded"');
    clickNamed(page, 'Collapse the terminal back into the pane');
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
      streamUrl: async () => {
        attempts += 1;
        throw new Error('ticket unavailable');
      },
    });
    const page = mount(<SessionTerminalDeck connection={alpha} dependencies={deck.dependencies} scope={scopeAlpha} />);
    await settle();

    expect(attempts).toBe(1);
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

    expect(json(page)).toContain('reconnecting');
    run(() => page.unmount());
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

    clickNamed(page, 'Expand the terminal to fill the screen');
    expect(json(page)).toContain('"data-expanded"');
    run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(json(page)).not.toContain('"data-expanded"');

    // A key that is not Escape leaves it alone.
    clickNamed(page, 'Expand the terminal to fill the screen');
    run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    expect(json(page)).toContain('"data-expanded"');
    run(() => page.unmount());
  });
});

describe('SessionTerminalDeck theming', () => {
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
