import { afterEach, describe, expect, it } from 'bun:test';
import type { PhoneTab } from '../../../../../src/features/workspace/phone/phone-tab.ts';
import {
  type PhoneTabRenderContext,
  PhoneWorkspace,
  type PhoneWorkspaceProps,
} from '../../../../../src/features/workspace/phone/phone-workspace.tsx';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';

const tabs: readonly PhoneTab[] = [
  { id: 't1', kind: 'terminal', label: 'dev', driver: { name: 'hadi' } },
  { id: 'b1', kind: 'browser', label: 'app' },
];

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.documentElement.removeAttribute('data-keyboard');
});

const contexts = new Map<string, PhoneTabRenderContext>();
const workspace = (props: Partial<PhoneWorkspaceProps> = {}) => (
  <PhoneWorkspace
    header={<header data-header="">Hadi</header>}
    tabs={tabs}
    activeId="chat"
    onSelect={() => {}}
    renderTab={(tab, context) => {
      contexts.set(tab.id, context);
      return <p data-content={tab.id}>{tab.label}</p>;
    }}
    onTerminalInput={() => {}}
    onFocusTerminal={() => {}}
    {...props}
  />
);

const touch = (type: string, x: number, at: number): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 300 }] });
  Object.defineProperty(event, 'timeStamp', { value: at });
  return event;
};

const swipe = async (target: Element, dx: number): Promise<void> => {
  await interact(() => target.dispatchEvent(touch('touchstart', 200, 0)));
  await interact(() => target.dispatchEvent(touch('touchmove', 200 + dx / 4, 100)));
  await interact(() => target.dispatchEvent(touch('touchmove', 200 + dx, 400)));
  await interact(() => target.dispatchEvent(touch('touchend', 0, 400)));
};

describe('PhoneWorkspace', () => {
  it('stacks the header, the chip row and one panel per tab, showing only the active one', async () => {
    mounted = await mount(workspace({ activeId: 'b1' }));
    const root = must(mounted.container.querySelector('[data-phone-workspace]'), 'workspace');
    expect(root.firstElementChild?.getAttribute('data-header')).toBe('');
    const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels.map(panel => panel.textContent)).toEqual(['Chat', 'Console', 'Processes', 'dev', 'app']);
    expect(panels.filter(panel => !panel.hidden).map(panel => panel.textContent)).toEqual(['app']);
    const selected = must(root.querySelector('[role="tab"][aria-selected="true"]'), 'selected chip');
    expect(panels[4]?.getAttribute('aria-labelledby')).toBe(selected.id);
    expect(contexts.get('b1')?.active).toBe(true);
    expect(contexts.get('chat')?.active).toBe(false);
  });

  it('falls back to Chat when the active tab is gone', async () => {
    mounted = await mount(workspace({ activeId: 'closed' }));
    const visible = [...mounted.container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(p => !p.hidden);
    expect(visible.map(panel => panel.textContent)).toEqual(['Chat']);
  });

  it('shows the key bar only on terminal-like tabs', async () => {
    mounted = await mount(workspace());
    expect(mounted.container.querySelector('[role="toolbar"]')).toBeNull();
    await mounted.render(workspace({ activeId: 'console' }));
    expect(mounted.container.querySelector('[role="toolbar"]')).not.toBeNull();
    await mounted.render(workspace({ activeId: 't1' }));
    expect(mounted.container.querySelector('[role="toolbar"]')).not.toBeNull();
  });

  it('routes key-bar bytes and the keyboard key to the active tab', async () => {
    const input: string[] = [];
    const focused: string[] = [];
    document.documentElement.setAttribute('data-keyboard', 'open');
    mounted = await mount(
      workspace({
        activeId: 't1',
        onTerminalInput: (id, data) => input.push(`${id}:${data}`),
        onFocusTerminal: id => focused.push(id),
      }),
    );
    const { container } = mounted;
    await interact(() => must(container.querySelector<HTMLButtonElement>('[data-terminal-key="esc"]'), 'esc').click());
    const keyboard = must(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'keyboard'),
      'keyboard',
    );
    expect(keyboard.getAttribute('aria-pressed')).toBe('true');
    await interact(() => keyboard.click());
    expect(input).toEqual(['t1:\x1b']);
    expect(focused).toEqual(['t1']);
  });

  it('lets ctrl armed on the bar modify the next typed key', async () => {
    mounted = await mount(workspace({ activeId: 't1' }));
    const { container } = mounted;
    const ctrl = must(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'ctrl'),
      'ctrl',
    );
    await interact(() => ctrl.click());
    let typed = '';
    await interact(() => {
      typed = must(contexts.get('t1'), 't1 context').interceptInput('c');
    });
    expect(typed).toBe('\x03');
    expect(ctrl.getAttribute('aria-pressed')).toBe('false');
  });

  it('swipes the content to the neighbouring tabs and stops at the ends', async () => {
    const picked: string[] = [];
    mounted = await mount(workspace({ activeId: 'console', onSelect: id => picked.push(id) }));
    const content = must(mounted.container.querySelector('[data-content="console"]'), 'content');
    await swipe(content, -120);
    await swipe(content, 120);
    await mounted.render(workspace({ activeId: 'chat', onSelect: id => picked.push(id) }));
    await swipe(must(mounted.container.querySelector('[data-content="chat"]'), 'chat'), 120);
    expect(picked).toEqual(['processes', 'chat']);
  });
});
