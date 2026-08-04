/**
 * A coloured command must still be the command.
 *
 * The block is the one place on the setup screen where a rendering bug would be
 * invisible and expensive: a dropped character in a `sudo tee` line is a broken
 * machine, not a broken layout. So the render is asserted against the exact
 * string, and the copy is asserted to carry that same string rather than
 * whatever the DOM happened to reassemble.
 */

import { describe, expect, it } from 'bun:test';

import { CommandBlock } from '../../../src/features/onboarding/command-block.tsx';
import { INSTALL_CHANNELS } from '../../../src/features/onboarding/onboarding-model.ts';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('CommandBlock', () => {
  it('shows the command exactly and copies exactly that', async () => {
    const copied: string[] = [];
    const command = 'sudo apt update\nsudo apt install fy';
    const view = await mount(
      <CommandBlock
        command={command}
        copyLabel="Copy command"
        write={async text => {
          copied.push(text);
        }}
      />,
    );

    const code = must(view.container.querySelector('code'), 'the command text');
    expect(code.textContent).toBe(command);
    await click(must(view.container.querySelector('button'), 'the copy button'));
    expect(copied).toEqual([command]);

    // A horizontal scroller without this grows a phantom vertical scrollbar.
    const scroller = must(view.container.querySelector('pre'), 'the command scroller');
    expect(scroller.className).toContain('overflow-x-auto');
    expect(scroller.className).toContain('overflow-y-hidden');

    // THE COMMAND IS THE LARGEST TEXT IN THE BLOCK. It is the string a reader
    // has to check character by character before running it on their own
    // machine, and it used to be `text-meta` — the size of a timestamp.
    expect(scroller.className).toContain('text-title');
    expect(scroller.className).not.toContain('text-meta');
    // The copy control stayed small: the button was never the thing to read.
    expect(must(view.container.querySelector('button'), 'the copy button').className).toContain('h-8');
    await view.unmount();
  });

  it('gives the parts that differ different tones, from the theme ramp', async () => {
    const view = await mount(
      <CommandBlock command="fy daemon start --detach" copyLabel="Copy command" write={async () => {}} />,
    );
    const toneOf = (text: string): string =>
      must(
        [...view.container.querySelectorAll('code span')].find(span => span.textContent === text),
        `the token ${text}`,
      ).className;

    expect(toneOf('fy')).toContain('text-syn-keyword');
    expect(toneOf('daemon')).toContain('text-syn-type');
    expect(toneOf('--detach')).toContain('text-syn-meta');
    // Every tone resolves to a `--syn-*` variable the themes already define, so
    // no colour here is invented beside the one code fences already use.
    for (const span of view.container.querySelectorAll('code span')) {
      expect(span.className).toMatch(/text-(syn-\w+|code-fg|faint)/);
    }
    await view.unmount();
  });

  it('renders every shipped install route without losing a character', async () => {
    for (const channel of INSTALL_CHANNELS) {
      const view = await mount(
        <CommandBlock command={channel.command} copyLabel="Copy install command" write={async () => {}} />,
      );
      expect(must(view.container.querySelector('code'), 'the command text').textContent).toBe(channel.command);
      await view.unmount();
    }
  });
});
