import { beforeAll, describe, expect, it } from 'bun:test';
import { TerminalSnapshotView } from '../../../app/components/terminal-snapshot.tsx';
import { interact, mount, must } from '@ferretry/app/testing';
import { refusal, scriptedClient } from '../../support/app/client.ts';

// The harness registers its DOM on the first mount; these cases touch `document` before they mount.
beforeAll(async () => {
  await (await mount(<div />)).unmount();
});

const { client } = scriptedClient('');
const scope = { sessionId: 'pane-session' };
const { client: second } = scriptedClient('');

/** Lets a test say what `document.hidden` is; happy-dom leaves it read-only. */
const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
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
  it('polls the daemon, prints the pane and states the snapshot is cached', async () => {
    setHidden(false);
    const asked: string[] = [];
    const view = await mount(
      <TerminalSnapshotView
        client={client}
        scope={scope}
        tmuxSession="ms9u6kfu-16918932"
        now={() => 0}
        readSnapshot={async target => {
          asked.push(target.sessionId);
          return '$ bun test\nok';
        }}
      />,
    );
    try {
      expect(asked).toEqual(['pane-session']);
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
        client={client}
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
        client={client}
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

  it('drops the previous daemon’s pane the moment the client changes', async () => {
    setHidden(false);
    const view = await mount(
      <TerminalSnapshotView
        client={client}
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
          client={second}
          scope={scope}
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

  it('follows the tail until the reader scrolls up, and comes back down with the jump pill', async () => {
    setHidden(false);
    let frame = 0;
    let height = 500;
    const view = await mount(
      <TerminalSnapshotView
        client={client}
        scope={scope}
        tmuxSession="pane"
        now={() => 0}
        readSnapshot={async () => {
          frame += 1;
          return `frame ${frame}`;
        }}
      />,
    );
    const pill = (): HTMLButtonElement | null => view.container.querySelector('.fy-jump-latest');
    try {
      const element = scroller(view.container);
      Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height });
      Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 100 });
      element.scrollLeft = 24;
      await repoll();
      expect(element.scrollTop).toBe(500);
      // THE HORIZONTAL OFFSET IS THE READER'S, and a poll must not take it.
      // Terminal lines are routinely wider than this pane, so the previous
      // `scrollLeft = 0` yanked anyone reading the right-hand end of a line back
      // to column 0 every three seconds. Only the tail is tracked.
      expect(element.scrollLeft).toBe(24);

      // Layout moving the pane is not the reader: no input, no detach.
      element.scrollTop = 300;
      await interact(() => element.dispatchEvent(new Event('scroll')));
      expect(pill()).toBeNull();

      // A reader's scroll-up (a wheel tick proves it was them) stops following:
      // the next capture must not yank them back down.
      await interact(() => element.dispatchEvent(new Event('wheel')));
      element.scrollTop = 40;
      await interact(() => element.dispatchEvent(new Event('scroll')));
      height = 600;
      await repoll();
      expect(element.scrollTop).toBe(40);
      expect(must(pill(), 'the jump pill').textContent).toBe('Jump to latest');

      // The pill returns them to the tail and follows again.
      await interact(() => must(pill(), 'the jump pill').click());
      expect(element.scrollTop).toBe(600);
      expect(pill()).toBeNull();

      // Scrolling back down into reach of the bottom re-engages follow by itself.
      await interact(() => element.dispatchEvent(new Event('wheel')));
      element.scrollTop = 100;
      await interact(() => element.dispatchEvent(new Event('scroll')));
      expect(pill()).not.toBeNull();
      element.scrollTop = 450;
      await interact(() => element.dispatchEvent(new Event('scroll')));
      expect(pill()).toBeNull();
      height = 700;
      await repoll();
      expect(element.scrollTop).toBe(700);
    } finally {
      await view.unmount();
    }
  });

  it('re-reads the age once a second without touching the daemon', async () => {
    setHidden(false);
    let clock = 0;
    const view = await mount(
      <TerminalSnapshotView
        client={client}
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

  it('reads through the shell client by default', async () => {
    setHidden(false);
    const { calls, client: reading } = scriptedClient('default reader frame');
    const view = await mount(<TerminalSnapshotView client={reading} scope={scope} tmuxSession="pane" now={() => 0} />);
    try {
      expect(calls).toEqual([
        {
          route: 'GET /v1/ferrets/:ferretId/snapshot',
          init: { params: { ferretId: 'pane-session' }, query: { live: 'false' } },
        },
      ]);
      expect(view.container.textContent).toContain('default reader frame');
    } finally {
      await view.unmount();
    }
  });

  it('keeps the last good pane when the shell refuses a read', async () => {
    setHidden(false);
    const { client: refused } = scriptedClient(refusal(503, 'daemon unreachable'));
    const view = await mount(<TerminalSnapshotView client={refused} scope={scope} tmuxSession="pane" now={() => 0} />);
    try {
      expect(view.container.textContent).toContain('stale');
      expect(view.container.textContent).toContain('daemon unreachable');
    } finally {
      await view.unmount();
    }
  });

  describe('on a phone', () => {
    const PANE = `${'x'.repeat(80)}\nshort`;
    let width: PropertyDescriptor | undefined;
    let clientWidth: PropertyDescriptor | undefined;
    beforeAll(() => {
      width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
      clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    });
    const asPhone = (): void => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 366 });
    };
    const restore = (): void => {
      if (width) Object.defineProperty(window, 'innerWidth', width);
      else Reflect.deleteProperty(window, 'innerWidth');
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    };
    const pre = (container: HTMLElement): HTMLElement => must(container.querySelector('pre'), 'the pane text');
    const toggle = (container: HTMLElement): HTMLButtonElement =>
      must(container.querySelector<HTMLButtonElement>('[data-terminal-fit]'), 'the Fit / Scroll toggle');

    it('fits the widest line to the pane by default, and scrolls at full size after one tap', async () => {
      setHidden(false);
      asPhone();
      try {
        const view = await mount(
          <TerminalSnapshotView client={client} scope={scope} live now={() => 0} readSnapshot={async () => PANE} />,
        );
        try {
          // 366px less the pre's 24px of padding, over 80 columns.
          expect(pre(view.container).style.fontSize).toBe('7px');
          expect(toggle(view.container).getAttribute('aria-pressed')).toBe('true');
          expect(toggle(view.container).textContent).toBe('Fit');
          expect(view.container.querySelector('[data-terminal-live-dot]')).not.toBeNull();

          await interact(() => toggle(view.container).click());

          expect(pre(view.container).style.fontSize).toBe('');
          expect(toggle(view.container).getAttribute('aria-pressed')).toBe('false');
          expect(toggle(view.container).textContent).toBe('Scroll');
        } finally {
          await view.unmount();
        }
      } finally {
        restore();
      }
    });

    it('keeps its first measurement where the browser has no ResizeObserver', async () => {
      setHidden(false);
      asPhone();
      const observer = globalThis.ResizeObserver;
      Reflect.deleteProperty(globalThis, 'ResizeObserver');
      try {
        const view = await mount(
          <TerminalSnapshotView client={client} scope={scope} now={() => 0} readSnapshot={async () => PANE} />,
        );
        try {
          expect(pre(view.container).style.fontSize).toBe('7px');
        } finally {
          await view.unmount();
        }
      } finally {
        globalThis.ResizeObserver = observer;
        restore();
      }
    });

    it('opens at full size on a desktop, where the toggle can still fit it', async () => {
      setHidden(false);
      const view = await mount(
        <TerminalSnapshotView client={client} scope={scope} now={() => 0} readSnapshot={async () => PANE} />,
      );
      try {
        expect(pre(view.container).style.fontSize).toBe('');
        await interact(() => toggle(view.container).click());
        expect(pre(view.container).style.fontSize).not.toBe('');
      } finally {
        await view.unmount();
      }
    });
  });
});
