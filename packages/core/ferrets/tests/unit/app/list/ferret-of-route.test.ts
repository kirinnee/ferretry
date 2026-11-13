import { describe, expect, it } from 'bun:test';
import { ferretOfRoute } from '../../../../app/features/header/header-paths.ts';

describe('the ferret a route is about', () => {
  it('is the `:ferret` of a screen under ferrets/, and nothing for a route about no ferret', () => {
    const screen = { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' };
    expect(ferretOfRoute({ kind: 'screen', screen, params: { ferret: 'f-1' } } as never)).toBe('f-1');
    expect(ferretOfRoute({ kind: 'screen', screen, params: {} } as never)).toBeUndefined();
    expect(ferretOfRoute({ kind: 'daemon-home', daemon: 'dm1' } as never)).toBeUndefined();
    expect(ferretOfRoute({ kind: 'home' })).toBeUndefined();
  });
});
