import { describe, expect, it } from 'bun:test';
import should from 'should';
import { QrSymbol } from '../../src/components/qr-symbol.tsx';
import { encodeQr } from '../../src/lib/qr-code.ts';
import { render } from '../support/react.ts';

const matrix = encodeQr('https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fhost.test;code=7F3K-Q2ND;fp=fy');

describe('QrSymbol', () => {
  it('draws the symbol with the standard quiet zone inside its own viewBox', () => {
    // The four-module margin is part of the symbol, not padding: a QR flush against a panel edge is one a
    // scanner cannot find, and putting the margin in the viewBox means no parent layout can remove it.
    // Arrange, Act
    const renderer = render(<QrSymbol matrix={matrix} label="Pairing code" />);
    const svg = renderer.root.findByType('svg');

    // Assert
    const span = matrix.size + 8;
    should(svg.props.viewBox).equal(`0 0 ${String(span)} ${String(span)}`);
    should(svg.props['data-qr-version']).equal(String(matrix.version));
  });

  it('paints its own light background, so it stays readable in a dark theme', () => {
    // A scanner reads luminance and expects dark on light. A symbol that inverted itself in dark mode
    // would be unreadable on half the devices this runs on, and the person aiming the camera could not
    // tell why.
    // Arrange, Act
    const renderer = render(<QrSymbol matrix={matrix} label="Pairing code" />);

    // Assert
    should(renderer.root.findByType('rect').props.fill).equal('#ffffff');
    should(renderer.root.findByType('path').props.fill).equal('#000000');
  });

  it('names what it is without ever announcing the credential inside it', () => {
    // A screen reader reading a pairing URL aloud is a credential in the accessibility tree, and from
    // there in every tool that walks it.
    // Arrange, Act
    const renderer = render(<QrSymbol matrix={matrix} label="Pairing code for this machine" />);
    const svg = renderer.root.findByType('svg');

    // Assert
    should(svg.props.role).equal('img');
    should(svg.props['aria-label']).equal('Pairing code for this machine');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('7F3K-Q2ND');
  });

  it('draws every dark module and nothing else, as one path', () => {
    // One path rather than an element per module: a version-8 symbol has around 1,200 dark modules, and
    // the countdown beside this re-renders once a second.
    // Arrange
    const dark = matrix.modules.reduce((total, row) => total + row.filter(Boolean).length, 0);

    // Act
    const path = render(<QrSymbol matrix={matrix} label="Pairing code" />).root.findByType('path');

    // Assert
    should([...String(path.props.d).matchAll(/M/gu)]).have.length(dark);
  });

  it('passes its layout class through, because the parent decides how big it is', () => {
    const renderer = render(<QrSymbol matrix={matrix} label="Pairing code" className="w-full" />);

    should(renderer.root.findByType('svg').props.className).equal('w-full');
  });
});
