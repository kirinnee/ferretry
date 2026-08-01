import { describe, expect, it } from 'bun:test';
import { TerminalSnapshotView } from '../../src/components/terminal-snapshot.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { interact, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'pane-daemon',
  baseUrl: 'https://pane.example.test',
  deviceToken: 'pane-token',
});
const scope = daemonSessionScope(daemon, 'pane-session');

const second = daemonConnection({
  daemonId: 'second-daemon',
  baseUrl: 'https://second.example.test',
  deviceToken: 'second-token',
});
const secondScope = daemonSessionScope(second, 'pane-session');

/** Lets a test say what `document.hidden` is; happy-dom leaves it read-only. */
const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
};

/** happy-dom has no layout, so the scroller's metrics are stated outright. */
const sizeScroller = (element: HTMLElement, scrollHeight: number, clientHeight: number): void => {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight });
};

/**
 * Forces the next poll without waiting out the 3s interval: backgrounding
 * clears the timer and returning re-arms it, and re-arming reads immediately.
 */
const repoll = async (): Promise<void> => {
  setHidden(true);
  await interact(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  setHidden(false);
  await interact(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

const scroller = (container: HTMLElement): HTMLElement =>
  must(container.querySelector<HTMLElement>('[data-testid="terminal-snapshot-scroller"]'), 'the snapshot scroller');

describe('terminal snapshot view', () => {
  it('polls the paired daemon, prints the pane and states the snapshot is cached', async () => {
    setHidden(false);
    const asked: string[] = [];
    const view = await mount(
      <TerminalSnapshotView
        daemon={daemon}
        scope={scope}
        tmuxSession="ms9u6kfu-16918932"
        now={() => 0}
        readSnapshot={async (connection, target) => {
          asked.push(`${connection.daemonId}:${target.sessionId}`);
          return '$ bun test\nok';
        }}
      />,
    );
    try {
      expect(asked).toEqual(['pane-daemon:pane-session']);
      expect(view.container.textContent).toContain('$ bun test');
      expect(view.container.textContent).toContain('tmux: ms9u6kfu-16918932');
      expect(view.container.textContent).toContain('cached · updated <1s ago');
    } finally {
      await view.unmount();
    }
  });

  it('keeps the last good pane and says the daemon went quiet instead of blanking', async () => {
    setHidden(false);
    let fail = false;
    const view = await mount(
      <TerminalSnapshotView
        daemon={daemon}
        scope={scope}
        tmuxSession="pane"
        now={() => 0}
        readSnapshot={async () => {
          if (fail) throw new Error('daemon unreachable');
          return 'first frame';
        }}
      />,
    );
    try {
      expect(view.container.textContent).toContain('first frame');
      fail = true;
      await repoll();
      expect(view.container.textContent).toContain('first frame');
      expect(view.container.textContent).toContain('stale · last update <1s ago · daemon unreachable');
    } finally {
      await view.unmount();
    }
  });

  it('does not poll a backgrounded tab, and resumes when it comes back', async () => {
    setHidden(true);
    let reads = 0;
    const view = await mount(
      <TerminalSnapshotView
        daemon={daemon}
        scope={scope}
        tmuxSession="pane"
        now={() => 0}
        readSnapshot={async () => {
          reads += 1;
          return `frame ${reads}`;
        }}
      />,
    );
    try {
      expect(reads).toBe(0);
      expect(view.container.textContent).toContain('(no snapshot yet)');
      expect(view.container.textContent).toContain('updated — ago');
      setHidden(false);
      await interact(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(reads).toBe(1);
      // Backgrounding again stops the interval rather than leaving it armed.
      setHidden(true);
      await interact(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(reads).toBe(1);
    } finally {
      setHidden(false);
      await view.unmount();
    }
  });

  it('drops the previous daemon’s pane the moment the scope changes', async () => {
    setHidden(false);
    const view = await mount(
      <TerminalSnapshotView
        daemon={daemon}
        scope={scope}
        tmuxSession="pane"
        now={() => 0}
        readSnapshot={async () => 'daemon one output'}
      />,
    );
    try {
      expect(view.container.textContent).toContain('daemon one output');
      await view.render(
        <TerminalSnapshotView
          daemon={second}
          scope={secondScope}
          tmuxSession="pane"
          now={() => 0}
          readSnapshot={async () => new Promise<string>(() => undefined)}
        />,
      );
      expect(view.container.textContent).toContain('(no snapshot yet)');
      expect(view.container.textContent).not.toContain('daemon one output');
    } finally {
      await view.unmount();
    }
  });

  it('sticks to the bottom only while the reader is already there', async () => {
    setHidden(false);
    let frame = 0;
    const view = await mount(
      <TerminalSnapshotView
        daemon={daemon}
        scope={scope}
        tmuxSession="pane"
        now={() => 0}
        readSnapshot={async () => {
          frame += 1;
          return `frame ${frame}`;
        }}
      />,
    );
    try {
      const element = scroller(view.container);
      sizeScroller(element, 500, 100);
      element.scrollLeft = 24;
      await repoll();
      expect(element.scrollTop).toBe(500);
      expect(element.scrollLeft).toBe(0);

      // Scrolling away from the tail unpins: the next frame must not yank the
      // reader back down.
      element.scrollTop = 40;
      await interact(() => {
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await repoll();
      expect(element.scrollTop).toBe(40);

      // Returning to the tail re-pins it.
      element.scrollTop = 400;
      await interact(() => {
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await repoll();
      expect(element.scrollTop).toBe(500);
    } finally {
      await view.unmount();
    }
  });

  it('re-reads the age once a second without touching the daemon', async () => {
    setHidden(false);
    let clock = 0;
    const view = await mount(
      <TerminalSnapshotView
        daemon={daemon}
        scope={scope}
        tmuxSession="pane"
        now={() => clock}
        readSnapshot={async () => 'aged frame'}
      />,
    );
    try {
      expect(view.container.textContent).toContain('updated <1s ago');
      clock = 12_000;
      await interact(async () => {
        await new Promise(resolve => setTimeout(resolve, 1_100));
      });
      expect(view.container.textContent).toContain('updated 12s ago');
    } finally {
      await view.unmount();
    }
  });

  it('reads through the paired daemon by default', async () => {
    setHidden(false);
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response('default reader frame');
    }) as unknown as typeof fetch;
    try {
      const view = await mount(<TerminalSnapshotView daemon={daemon} scope={scope} tmuxSession="pane" now={() => 0} />);
      expect(seen).toEqual(['https://pane.example.test/v1/sessions/pane-session/snapshot?live=false']);
      expect(view.container.textContent).toContain('default reader frame');
      await view.unmount();
    } finally {
      globalThis.fetch = original;
    }
  });
});
