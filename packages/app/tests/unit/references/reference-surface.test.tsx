import { describe, test } from 'bun:test';
import should from 'should';
import { ReferenceSurfaceProvider, useReferenceSurface } from '../../../src/references/reference-surface.tsx';
import { render } from '../../../src/testing/react.ts';

/** Reads the surface exactly the way a transcript row does. */
function Reader({ onSurface }: { readonly onSurface: (surface: ReturnType<typeof useReferenceSurface>) => void }) {
  onSurface(useReferenceSurface());
  return null;
}

describe('useReferenceSurface', () => {
  test('should offer nothing at all outside a ferret', () => {
    // Arrange
    let seen: unknown;

    // Act
    render(<Reader onSurface={surface => (seen = surface)} />);

    // Assert — no resolver and no opener, so reference-shaped text stays prose.
    should(seen).deepEqual({});
  });

  test('should hand every reader in the ferret the same surface object', () => {
    // Arrange
    const surface = { onNavigate: () => undefined };
    const seen: unknown[] = [];

    // Act
    render(
      <ReferenceSurfaceProvider surface={surface}>
        <Reader onSurface={value => seen.push(value)} />
        <Reader onSurface={value => seen.push(value)} />
      </ReferenceSurfaceProvider>,
    );

    // Assert
    should(seen).have.length(2);
    should(seen[0]).equal(surface);
    should(seen[1]).equal(surface);
  });
});
