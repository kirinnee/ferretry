import { describe, expect, it } from 'bun:test';

import {
  resolvePointerKind,
  textContextMenuAllowed,
  textContextMenuEventAllowed,
} from '../../src/lib/context-menu-policy.ts';

describe('resolvePointerKind', () => {
  it('uses the event provenance before the remembered press', () => {
    expect(resolvePointerKind('mouse', 'touch')).toBe('mouse');
  });

  it('uses a remembered press when WebKit supplies a plain MouseEvent', () => {
    expect(resolvePointerKind(undefined, 'pen')).toBe('pen');
  });

  it('does not mistake an absent or unrecognised provenance for a mouse', () => {
    expect(resolvePointerKind('', 'trackpad')).toBe('unknown');
  });
});

describe('textContextMenuAllowed', () => {
  it('does not replace a native menu without an owned text selection', () => {
    expect(textContextMenuAllowed({ pointerKind: 'mouse', touchAffected: false, hasSelection: false })).toBeFalse();
  });

  it('always preserves touch and pen selection handles', () => {
    expect(textContextMenuAllowed({ pointerKind: 'touch', touchAffected: false, hasSelection: true })).toBeFalse();
    expect(textContextMenuAllowed({ pointerKind: 'pen', touchAffected: false, hasSelection: true })).toBeFalse();
  });

  it('keeps an unknown event native on touch-capable devices but allows desktop keyboard menus', () => {
    expect(textContextMenuAllowed({ pointerKind: 'unknown', touchAffected: true, hasSelection: true })).toBeFalse();
    expect(textContextMenuAllowed({ pointerKind: 'unknown', touchAffected: false, hasSelection: true })).toBeTrue();
  });

  it('allows an unambiguous mouse selection', () => {
    expect(textContextMenuAllowed({ pointerKind: 'mouse', touchAffected: true, hasSelection: true })).toBeTrue();
  });
});

describe('textContextMenuEventAllowed', () => {
  it('composes the handler decision with remembered provenance', () => {
    expect(
      textContextMenuEventAllowed(undefined, { lastPointerType: 'touch', touchAffected: false, hasSelection: true }),
    ).toBeFalse();
    expect(
      textContextMenuEventAllowed(
        { pointerType: 'mouse' },
        {
          lastPointerType: 'touch',
          touchAffected: true,
          hasSelection: true,
        },
      ),
    ).toBeTrue();
  });
});
