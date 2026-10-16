import { afterEach, describe, expect, it } from 'bun:test';
import type { TerminalInputPort } from '../../../src/components/session-terminal-deck.tsx';
import { consoleKeyInput } from '../../../src/features/workspace/console-keys.ts';
import { ConsoleSurface, type ConsoleTyper } from '../../../src/features/workspace/console-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'console-daemon', baseUrl: 'https://console.example.test', deviceId: 'd' });
const scope = daemonSessionScope(daemon, 'agent-session');

const press = (key: string, modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  consoleKeyInput({ key, ctrlKey: false, altKey: false, metaKey: false, ...modifiers });

describe('what a Console key press sends', () => {
  it('translates the keys a text field would keep, as a terminal sends them', () => {
    expect(['Enter', 'Backspace', 'Tab', 'Escape'].map(key => press(key))).toEqual(['\r', '\x7f', '\t', '\x1b']);
    expect(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft'].map(key => press(key))).toEqual([
      '\x1b[A',
      '\x1b[B',
      '\x1b[C',
      '\x1b[D',
    ]);
    expect(['Home', 'End', 'Delete', 'PageUp', 'PageDown'].map(key => press(key))).toEqual([
      '\x1b[H',
      '\x1b[F',
      '\x1b[3~',
      '\x1b[5~',
      '\x1b[6~',
    ]);
  });

  it('sends Ctrl+letter as its control character and Alt+key as ESC then the key', () => {
    expect(press('c', { ctrlKey: true })).toBe('\x03');
    expect(press('D', { ctrlKey: true })).toBe('\x04');
    expect(press('1', { ctrlKey: true })).toBeNull();
    expect(press('b', { altKey: true })).toBe('\x1bb');
    expect(press('Enter', { altKey: true })).toBe('\x1b\r');
  });

  it('leaves printable text, paste and the browser’s own shortcuts to the field', () => {
    expect(press('a')).toBeNull();
    expect(press('v', { ctrlKey: true })).toBeNull();
    expect(press('c', { metaKey: true })).toBeNull();
    expect(press('Shift')).toBeNull();
  });
});

describe('the Console surface', () => {
  const mounted: { unmount: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
  });

  const setup = async (typer: ConsoleTyper, extra: { onInputPort?: (port: TerminalInputPort | null) => void } = {}) => {
    const reads: number[] = [];
    const view = await mount(
      <ConsoleSurface
        connection={daemon}
        interceptInput={data => (data === 'x' ? '\x18' : data)}
        readSnapshot={async () => {
          reads.push(reads.length);
          return `pane read ${reads.length}`;
        }}
        scope={scope}
        typeInto={typer}
        {...extra}
      />,
    );
    mounted.push(view);
    const field = must(view.container.querySelector<HTMLInputElement>('[data-console-input]'), 'the Console field');
    const settle = async () => {
      await interact(async () => {
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      });
    };
    return { view, field, reads, settle };
  };

  const type = async (field: HTMLInputElement, text: string) => {
    await interact(() => {
      field.value = text;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    });
  };

  it('sends keys and typed text in order to the session’s own pane, then reads the pane again', async () => {
    const sent: [string, string, string][] = [];
    const { view, field, reads, settle } = await setup(async (connection, at, data) => {
      sent.push([connection.daemonId, at.sessionId, data]);
    });
    await settle();
    const before = reads.length;

    await type(field, 'ls');
    await interact(() => pressKey(field, 'Enter'));
    await interact(() => pressKey(field, 'a'));
    await type(field, 'x');
    await settle();

    expect(sent).toEqual([
      ['console-daemon', 'agent-session', 'ls'],
      ['console-daemon', 'agent-session', '\r'],
      // The phone key bar's sticky ctrl rewrites typed text before it is sent.
      ['console-daemon', 'agent-session', '\x18'],
    ]);
    // A field that is a keyboard, not a draft: it is empty after every write.
    expect(field.value).toBe('');
    expect(reads.length).toBeGreaterThan(before);
    expect(view.container.textContent).toContain('live · updated');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('waits for a composition to finish before it sends what was composed', async () => {
    const sent: string[] = [];
    const { field, settle } = await setup(async (_connection, _at, data) => {
      sent.push(data);
    });
    await interact(() => {
      field.value = 'に';
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'に', isComposing: true }));
    });
    expect(sent).toEqual([]);
    await interact(() => {
      field.value = '日本';
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    });
    await type(field, '');
    await settle();
    expect(sent).toEqual(['日本']);
  });

  it('shows a refusal in the grant’s own words, and clears it once a write lands', async () => {
    let refuse: unknown = new DaemonResponseError(403, 'Turn terminal on from this machine.', 'grant_not_granted');
    const { view, field, settle } = await setup(async () => {
      if (refuse !== null) throw refuse;
    });

    await type(field, 'y');
    await settle();
    const alert = () => view.container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert()).toContain('Turn terminal on from this machine.');

    refuse = new DaemonResponseError(403, '', 'grant_not_granted');
    await type(field, 'y');
    await settle();
    expect(alert()).not.toBe('');

    refuse = new Error('the pane is gone');
    await type(field, 'y');
    await settle();
    expect(alert()).toBe('the pane is gone');

    refuse = 'unexpected';
    await type(field, 'y');
    await settle();
    expect(alert()).toBe('unexpected');

    refuse = null;
    await type(field, 'y');
    await settle();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('hands the host a port that types and focuses, and withdraws it on unmount', async () => {
    const sent: string[] = [];
    const ports: (TerminalInputPort | null)[] = [];
    const { view, field, settle } = await setup(
      async (_connection, _at, data) => {
        sent.push(data);
      },
      { onInputPort: port => ports.push(port) },
    );
    const port = must(ports.at(-1), 'the input port');
    await interact(() => port.write('\x1b[A'));
    await interact(() => port.write(''));
    await interact(() => port.focus());
    await settle();
    expect(sent).toEqual(['\x1b[A']);
    expect(document.activeElement).toBe(field);
    await view.unmount();
    mounted.splice(0);
    expect(ports.at(-1)).toBeNull();
  });

  it('names the agent whose pane it is, and speaks of "the agent" when it has no name', async () => {
    const named = await mount(
      <ConsoleSurface
        agentName="Hadi"
        connection={daemon}
        readSnapshot={async () => ''}
        scope={scope}
        typeInto={async () => undefined}
      />,
    );
    mounted.push(named);
    expect(named.container.textContent).toContain('Hadi’s own CLI pane, live.');
    expect(named.container.textContent).toContain('send Hadi a turn');
    const field = must(named.container.querySelector<HTMLInputElement>('[data-console-input]'), 'the field');
    expect(field.getAttribute('aria-label')).toBe('Type into Hadi’s Console');
    expect(field.placeholder).toContain('keys go to Hadi’s pane');
    const unnamed = await mount(
      <ConsoleSurface
        connection={daemon}
        readSnapshot={async () => ''}
        scope={scope}
        typeInto={async () => undefined}
      />,
    );
    mounted.push(unnamed);
    expect(unnamed.container.textContent).toContain('The agent’s own CLI pane, live.');
    expect(unnamed.container.textContent).toContain('send the agent a turn');
  });

  it('reads and types through the daemon itself when nothing is injected', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return String(url).includes('/console/input') ? Response.json({ written: 1 }) : new Response('the pane');
    }) as typeof fetch;
    try {
      const view = await mount(<ConsoleSurface connection={daemon} scope={scope} />);
      mounted.push(view);
      const field = must(view.container.querySelector<HTMLInputElement>('[data-console-input]'), 'the field');
      await type(field, 'q');
      await interact(async () => {
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      });
      expect(calls).toContain('https://console.example.test/v1/sessions/agent-session/snapshot?live=true');
      expect(calls).toContain('https://console.example.test/v1/sessions/agent-session/console/input');
    } finally {
      globalThis.fetch = original;
    }
  });
});
