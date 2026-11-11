import { describe, expect, it } from 'bun:test';
import { PaneDirectory } from '../../daemon/adapters/tmux-pane.ts';

describe('PaneDirectory', () => {
  it('names the pane a ferret was last handed, and refuses with a sentence for a ferret it never saw', () => {
    const directory = new PaneDirectory();

    expect(() => directory.require('ferret-two')).toThrow(
      'this daemon does not know which pane ferret ferret-two is in, so nothing was read or sent',
    );

    directory.remember('ferret-two', '%3');
    expect(directory.require('ferret-two')).toBe('%3');

    directory.remember('ferret-two', '%4');
    expect(directory.require('ferret-two')).toBe('%4');

    directory.forget('ferret-two');
    expect(() => directory.require('ferret-two')).toThrow('ferret ferret-two');
  });
});
