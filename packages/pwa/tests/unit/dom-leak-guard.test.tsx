import { describe, expect, test } from 'bun:test';
import { useEffect } from 'react';
import { mount } from '../support/dom.ts';
import { render } from '../support/react.ts';

let unmounts = 0;
let rendererUnmounts = 0;

function Probe({ onUnmount }: { readonly onUnmount: () => void }) {
  useEffect(() => onUnmount, [onUnmount]);
  return <p>left mounted</p>;
}

describe('the leak guard', () => {
  test('a test forgets to unmount a DOM root and a test renderer', async () => {
    await mount(<Probe onUnmount={() => (unmounts += 1)} />);
    render(<Probe onUnmount={() => (rendererUnmounts += 1)} />);
    expect(document.body.children.length).toBe(1);
  });

  test('unmounted both after that test, so the next one starts on an empty page', () => {
    expect(unmounts).toBe(1);
    expect(rendererUnmounts).toBe(1);
    expect(document.body.children.length).toBe(0);
  });

  test('leaves a root the test unmounted itself alone', async () => {
    const before = unmounts;
    const view = await mount(<Probe onUnmount={() => (unmounts += 1)} />);
    await view.unmount();
    await view.unmount();
    expect(unmounts).toBe(before + 1);
  });
});
