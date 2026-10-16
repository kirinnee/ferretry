import { afterEach, describe, expect, it } from 'bun:test';
import {
  type StickyCtrl,
  TerminalKeyBar,
  useStickyCtrl,
} from '../../../../../src/features/workspace/phone/terminal-key-bar.tsx';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const Harness = ({ sent, keyboard }: { sent: string[]; keyboard: () => void }) => {
  const sticky = useStickyCtrl();
  return (
    <TerminalKeyBar
      onSend={data => sent.push(data)}
      ctrl={sticky.ctrl}
      onCtrlChange={sticky.setCtrl}
      onKeyboard={keyboard}
      keyboardOpen={false}
    />
  );
};

const key = (container: HTMLElement, name: string): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(`[data-terminal-key="${name}"]`), name);
const button = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text),
    text,
  );

describe('TerminalKeyBar', () => {
  it('is a toolbar of esc, tab, ctrl, four arrows and keyboard', async () => {
    mounted = await mount(<Harness sent={[]} keyboard={() => {}} />);
    const bar = must(mounted.container.querySelector('[role="toolbar"]'), 'toolbar');
    expect(bar.getAttribute('aria-label')).toBe('Terminal keys');
    expect(
      [...bar.querySelectorAll('button')].map(node => node.getAttribute('aria-label') ?? node.textContent),
    ).toEqual(['ctrl', 'esc', 'tab', 'Up arrow', 'Down arrow', 'Left arrow', 'Right arrow', 'keyboard']);
  });

  it('sends each key as its bytes', async () => {
    const sent: string[] = [];
    mounted = await mount(<Harness sent={sent} keyboard={() => {}} />);
    const { container } = mounted;
    for (const name of ['esc', 'tab', 'up', 'down', 'left', 'right'])
      await interact(() => key(container, name).click());
    expect(sent).toEqual(['\x1b', '\t', '\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
  });

  it('arms ctrl for exactly one key, and can be disarmed by tapping again', async () => {
    const sent: string[] = [];
    mounted = await mount(<Harness sent={sent} keyboard={() => {}} />);
    const { container } = mounted;
    const ctrl = button(container, 'ctrl');
    await interact(() => ctrl.click());
    expect(ctrl.getAttribute('aria-pressed')).toBe('true');
    await interact(() => key(container, 'left').click());
    expect(ctrl.getAttribute('aria-pressed')).toBe('false');
    await interact(() => key(container, 'left').click());
    await interact(() => ctrl.click());
    await interact(() => ctrl.click());
    await interact(() => key(container, 'up').click());
    expect(sent).toEqual(['\x1b[1;5D', '\x1b[D', '\x1b[A']);
  });

  it('opens the keyboard and keeps focus where it was on pointer-down', async () => {
    let opened = 0;
    mounted = await mount(<Harness sent={[]} keyboard={() => opened++} />);
    const keyboard = button(mounted.container, 'keyboard');
    await interact(() => keyboard.click());
    expect(opened).toBe(1);
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    await interact(() => keyboard.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
  });

  it('marks the keyboard key pressed while the keyboard is up', async () => {
    mounted = await mount(
      <TerminalKeyBar onSend={() => {}} ctrl={false} onCtrlChange={() => {}} onKeyboard={() => {}} keyboardOpen />,
    );
    expect(button(mounted.container, 'keyboard').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('useStickyCtrl', () => {
  const Probe = ({ out }: { out: StickyCtrl[] }) => {
    out.push(useStickyCtrl());
    return null;
  };

  it('passes typed input through until armed, then spends ctrl on one key', async () => {
    const out: StickyCtrl[] = [];
    mounted = await mount(<Probe out={out} />);
    const latest = () => must(out.at(-1), 'state');
    expect(latest().intercept('c')).toBe('c');
    await interact(() => latest().setCtrl(true));
    expect(latest().ctrl).toBe(true);
    let sent = '';
    await interact(() => {
      sent = latest().intercept('c');
    });
    expect(sent).toBe('\x03');
    expect(latest().ctrl).toBe(false);
  });
});
