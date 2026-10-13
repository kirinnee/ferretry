import { describe, it } from 'bun:test';
import should from 'should';
import { resolveDevice } from '../../../src/lib/passkey/resolve';
import { device, LAPTOP, LAPTOP_ID, OTHER_LAPTOP, PIXEL, PIXEL_ID } from './fixtures';

describe('resolving the device the owner typed', () => {
  it('should find a device by its id', () => {
    // Act
    const actual = resolveDevice([PIXEL, LAPTOP], PIXEL_ID);

    // Assert
    should(actual).eql({ kind: 'found', device: PIXEL });
  });

  it('should find a device by a name only it carries', () => {
    // Act
    const actual = resolveDevice([PIXEL, LAPTOP], 'Pixel 8');

    // Assert
    should(actual).eql({ kind: 'found', device: PIXEL });
  });

  it('should refuse to guess between two devices with one name', () => {
    // Act
    const actual = resolveDevice([PIXEL, LAPTOP, OTHER_LAPTOP], 'Chrome');

    // Assert
    should(actual).eql({ kind: 'ambiguous', candidates: [LAPTOP, OTHER_LAPTOP] });
  });

  it('should still resolve one of two same-named devices by id', () => {
    // Act
    const actual = resolveDevice([LAPTOP, OTHER_LAPTOP], LAPTOP_ID);

    // Assert
    should(actual).eql({ kind: 'found', device: LAPTOP });
  });

  it('should let an id beat a device that names itself after another device id', () => {
    // Arrange — a device chooses its own name, so it can choose somebody else's id.
    const impostor = device(LAPTOP_ID.replace('b', 'd') as typeof LAPTOP_ID, PIXEL_ID);

    // Act
    const actual = resolveDevice([impostor, PIXEL], PIXEL_ID);

    // Assert
    should(actual).eql({ kind: 'found', device: PIXEL });
  });

  it('should match a name exactly, not by prefix or case', () => {
    // Act + Assert
    should(resolveDevice([PIXEL], 'pixel 8').kind).equal('none');
    should(resolveDevice([PIXEL], 'Pixel').kind).equal('none');
  });

  it('should report every known device when nothing matches', () => {
    // Act
    const actual = resolveDevice([PIXEL, LAPTOP], 'Tablet');

    // Assert
    should(actual).eql({ kind: 'none', known: [PIXEL, LAPTOP] });
  });
});
