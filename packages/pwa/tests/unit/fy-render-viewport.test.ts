import { describe, test } from 'bun:test';
import should from 'should';
import {
  boxCentre,
  clampView,
  DOUBLE_TAP_ZOOM,
  fitScale,
  inlineMaxHeight,
  isAtRest,
  MERMAID_LEGIBLE_SCALE,
  moreBeyond,
  panBy,
  pinchOf,
  planViewport,
  restView,
  svgNaturalSize,
  toggleZoom,
  touchActionFor,
  viewBoxSize,
  wheelFactor,
  ZOOM_STEP,
  zoomBy,
  zoomTo,
} from '../../src/lib/fy-render-viewport.ts';

const PHONE = 358;
const SCREEN = 844;

const plan = (natural: { width: number; height: number }, over: Partial<Parameters<typeof planViewport>[0]> = {}) =>
  planViewport({
    columnWidth: PHONE,
    legibleScale: MERMAID_LEGIBLE_SCALE,
    maxHeight: inlineMaxHeight(SCREEN),
    natural,
    ...over,
  });

describe('fitScale', () => {
  test('should fit the tighter axis', () => {
    should(fitScale({ height: 400, width: 800 }, { height: 400, width: 400 })).equal(0.5);
    should(fitScale({ height: 800, width: 400 }, { height: 400, width: 400 })).equal(0.5);
  });

  test('should never enlarge past one', () => {
    should(fitScale({ height: 100, width: 100 }, { height: 900, width: 900 })).equal(1);
  });

  test('should enlarge up to a given ceiling', () => {
    should(fitScale({ height: 100, width: 100 }, { height: 900, width: 900 }, 2)).equal(2);
  });
});

describe('inlineMaxHeight', () => {
  test('should be 60% of the screen', () => {
    should(inlineMaxHeight(844)).be.approximately(506.4, 0.01);
  });

  test('should never pass the cap on a huge screen', () => {
    should(inlineMaxHeight(4000)).equal(800);
  });

  test('should keep a floor on a tiny screen and survive an unmeasured one', () => {
    should(inlineMaxHeight(100)).equal(120);
    should(inlineMaxHeight(0)).equal(800);
  });
});

describe('planViewport — fit by default', () => {
  test('should show a small diagram at its natural size, never upscaled', () => {
    // Arrange / Act
    const actual = plan({ height: 120, width: 240 });

    // Assert
    should(actual.fit).equal(1);
    should(actual.rest).equal(1);
    should(actual.box).deepEqual({ height: 120, width: PHONE });
    should(actual.pansAtRest).be.false();
  });

  test('should scale a wide diagram down to the column so nothing is clipped', () => {
    // Arrange — 600px wide in a 358px column: 0.597 is under the legible floor, but only a little.
    const actual = plan({ height: 300, width: 600 }, { columnWidth: 480 });

    // Assert
    should(actual.fit).be.approximately(0.8, 1e-9);
    should(actual.rest).equal(actual.fit);
    should(actual.box.width).equal(480);
    should(actual.box.height).equal(240);
    should(actual.pansAtRest).be.false();
  });

  test('should bound the box by the height ceiling, fitting the whole picture inside it', () => {
    // Arrange — a tall flowchart: 300 × 700 on a phone, ceiling 506px (fit 0.72, labels 11.6px: still legible).
    const actual = plan({ height: 700, width: 300 });

    // Assert — the height is the tight axis: 506.4 / 1800.
    should(actual.fit).be.approximately(inlineMaxHeight(SCREEN) / 700, 1e-9);
    should(actual.box.height).be.approximately(inlineMaxHeight(SCREEN), 1);
    should(actual.rest * 300).be.below(PHONE);
    should(actual.pansAtRest).be.false();
  });

  test('should cover the whole diagram at rest: the resting picture fits inside the box on both axes', () => {
    for (const natural of [
      { height: 900, width: 1_100 },
      { height: 2_400, width: 500 },
      { height: 300, width: 3_000 },
    ]) {
      const p = plan(natural, { legibleScale: 0 });
      should(natural.width * p.rest).be.belowOrEqual(p.box.width + 0.5);
      should(natural.height * p.rest).be.belowOrEqual(p.box.height + 0.5);
    }
  });
});

describe('planViewport — legibility', () => {
  test('should rest at the smallest legible scale and pan, rather than shrink text under 10px', () => {
    // Arrange — 2000px wide into 358: a fit of 0.179 would make 16px text 2.9px.
    const actual = plan({ height: 600, width: 2_000 });

    // Assert
    should(actual.fit).be.approximately(358 / 2_000, 1e-9);
    should(actual.rest).equal(MERMAID_LEGIBLE_SCALE);
    should(16 * actual.rest).equal(10);
    should(actual.pansAtRest).be.true();
    should(actual.min).equal(actual.fit);
  });

  test('should still let a reader zoom out to see the whole thing', () => {
    // Arrange
    const natural = { height: 600, width: 2_000 };
    const p = plan(natural);
    const rest = restView(p, natural);

    // Act
    const out = zoomTo(rest, p, natural, 0.01, boxCentre(p));

    // Assert — the whole width is visible again, at the fit, text and all.
    should(out.scale).equal(p.fit);
    should(natural.width * out.scale).be.belowOrEqual(PHONE + 0.5);
  });

  test('should not apply a floor to a picture whose text size is unknown', () => {
    // Arrange / Act
    const actual = plan({ height: 600, width: 2_000 }, { legibleScale: 0 });

    // Assert
    should(actual.rest).equal(actual.fit);
    should(actual.pansAtRest).be.false();
  });

  test('should start a panning diagram at its top-left corner', () => {
    // Arrange
    const natural = { height: 600, width: 2_000 };
    const p = plan(natural);

    // Act
    const view = restView(p, natural);

    // Assert
    should(view.x).equal(0);
    should(view.y).equal(0);
  });
});

describe('planViewport — a tree that is wider than its column', () => {
  const natural = { height: 600, width: 2_000 };

  test('should start centred on the root when asked, and still at the top', () => {
    // Arrange
    const p = plan(natural, { anchor: 'centre' });

    // Act
    const view = restView(p, natural);

    // Assert — half of the overflow is hidden to each side.
    should(p.anchor).equal('centre');
    should(view.x).equal(-(natural.width * view.scale - p.box.width) / 2);
    should(view.y).equal(0);
  });

  test('should size the box to the scaled picture, with no empty area below it', () => {
    // Act
    const p = plan(natural, { anchor: 'centre' });

    // Assert
    should(p.box.height).equal(Math.round(natural.height * p.rest));
  });

  test('should name the sides that have more picture beyond them', () => {
    // Arrange
    const p = plan(natural, { anchor: 'centre' });
    const view = restView(p, natural);

    // Act
    const edges = moreBeyond(view, p, natural);

    // Assert
    should(edges).eql({ bottom: false, left: true, right: true, top: false });
  });

  test('should name no side for a picture that fits, and only the far side at the start', () => {
    // Arrange
    const small = { height: 100, width: 100 };
    const fits = plan(small);
    const p = plan(natural);

    // Assert
    should(moreBeyond(restView(fits, small), fits, small)).eql({
      bottom: false,
      left: false,
      right: false,
      top: false,
    });
    should(moreBeyond(restView(p, natural), p, natural)).eql({
      bottom: false,
      left: false,
      right: true,
      top: false,
    });
  });
});

describe('planViewport — fullscreen', () => {
  test('should fit the whole screen and may enlarge a small diagram up to twice', () => {
    // Arrange
    const natural = { height: 100, width: 200 };

    // Act
    const actual = plan(natural, { fullscreenBox: { height: 800, width: 1_200 } });

    // Assert
    should(actual.rest).equal(2);
    should(actual.box).deepEqual({ height: 800, width: 1_200 });
  });

  test('should still fit a huge diagram to the screen', () => {
    const actual = plan({ height: 2_400, width: 600 }, { fullscreenBox: { height: 800, width: 1_200 } });
    should(actual.fit).be.approximately(800 / 2_400, 1e-9);
    should(actual.pansAtRest).be.false();
  });
});

describe('zoom and pan', () => {
  const natural = { height: 600, width: 1_000 };
  const p = plan(natural, { columnWidth: 600, legibleScale: 0 });

  test('should centre a picture smaller than its box', () => {
    const roomy = plan({ height: 100, width: 200 });
    const view = restView(roomy, { height: 100, width: 200 });
    should(view.x).equal((PHONE - 200) / 2);
  });

  test('should keep the point under the cursor fixed while zooming', () => {
    // Arrange — rest, then zoom in about a point a third across.
    const rest = restView(p, natural);
    const focal = { x: 200, y: 100 };
    const before = { x: (focal.x - rest.x) / rest.scale, y: (focal.y - rest.y) / rest.scale };

    // Act
    const zoomed = zoomBy(rest, p, natural, 2, focal);

    // Assert — the natural-space point under the cursor did not move.
    should(zoomed.scale).be.approximately(rest.scale * 2, 1e-9);
    should((focal.x - zoomed.x) / zoomed.scale).be.approximately(before.x, 1e-6);
    should((focal.y - zoomed.y) / zoomed.scale).be.approximately(before.y, 1e-6);
  });

  test('should stop at the fit and at the ceiling', () => {
    const rest = restView(p, natural);
    should(zoomTo(rest, p, natural, 0.0001, boxCentre(p)).scale).equal(p.min);
    should(zoomTo(rest, p, natural, 1_000, boxCentre(p)).scale).equal(p.max);
  });

  test('should step by the zoom step', () => {
    const rest = restView(p, natural);
    should(zoomBy(rest, p, natural, ZOOM_STEP, boxCentre(p)).scale).be.approximately(rest.scale * ZOOM_STEP, 1e-9);
  });

  test('should never let the picture be dragged out of the box', () => {
    // Arrange
    const zoomed = zoomTo(restView(p, natural), p, natural, 2, { x: 0, y: 0 });

    // Act
    const far = panBy(zoomed, p, natural, 99_999, 99_999);
    const farOther = panBy(zoomed, p, natural, -99_999, -99_999);

    // Assert
    should(far.x).equal(0);
    should(far.y).equal(0);
    should(farOther.x).equal(p.box.width - natural.width * zoomed.scale);
    should(farOther.y).equal(p.box.height - natural.height * zoomed.scale);
  });

  test('should clamp a view that no longer fits after a resize', () => {
    const wild = clampView({ scale: 2, x: 5_000, y: -5_000 }, p, natural);
    should(wild.x).equal(0);
    should(wild.y).equal(p.box.height - natural.height * wild.scale);
  });

  test('should report rest only at rest', () => {
    const rest = restView(p, natural);
    should(isAtRest(rest, p, natural)).be.true();
    should(isAtRest(zoomBy(rest, p, natural, 2, boxCentre(p)), p, natural)).be.false();
  });

  test('should zoom in on a double tap and come back on the next', () => {
    // Arrange
    const rest = restView(p, natural);

    // Act
    const zoomed = toggleZoom(rest, p, natural, { x: 100, y: 100 });
    const back = toggleZoom(zoomed, p, natural, { x: 100, y: 100 });

    // Assert
    should(zoomed.scale).be.approximately(Math.min(p.max, p.rest * DOUBLE_TAP_ZOOM), 1e-9);
    should(isAtRest(back, p, natural)).be.true();
  });

  test('should turn a wheel delta into a smooth factor either way', () => {
    should(wheelFactor(-100)).be.above(1);
    should(wheelFactor(100)).be.below(1);
    should(wheelFactor(0)).equal(1);
    should(wheelFactor(-100_000)).equal(wheelFactor(-120));
  });

  test('should read a pinch', () => {
    const { centre, distance } = pinchOf({ x: 0, y: 0 }, { x: 30, y: 40 });
    should(distance).equal(50);
    should(centre).deepEqual({ x: 15, y: 20 });
  });
});

describe('touchActionFor — a thumb that is not needed stays the page’s', () => {
  const natural = { height: 600, width: 2_000 };

  test('should leave both axes to the page when the whole picture is visible', () => {
    const small = { height: 100, width: 200 };
    const p = plan(small);
    should(touchActionFor(restView(p, small), p, small)).equal('pan-x pan-y');
  });

  test('should take only the sideways axis for a picture wider than its box, leaving vertical scroll to the page', () => {
    const p = planViewport({ columnWidth: 358, legibleScale: MERMAID_LEGIBLE_SCALE, maxHeight: 800, natural });
    should(touchActionFor(restView(p, natural), p, natural)).equal('pan-y');
  });

  test('should take everything once it is zoomed in and overflows both ways', () => {
    const p = plan(natural);
    const zoomed = zoomTo(restView(p, natural), p, natural, 3, boxCentre(p));
    should(touchActionFor(zoomed, p, natural)).equal('none');
  });

  test('should leave a vertical drag to the page at rest even when the resting picture is taller than its box', () => {
    const tall = { height: 3_000, width: 600 };
    const p = plan(tall);
    should(p.pansAtRest).be.true();
    should(touchActionFor(restView(p, tall), p, tall)).equal('pan-y');
    const narrow = { height: 3_000, width: 300 };
    const q = plan(narrow);
    should(touchActionFor(restView(q, narrow), q, narrow)).equal('pan-x pan-y');
  });

  test('should keep a vertical drag the page’s for a picture panned sideways at rest', () => {
    const p = plan(natural);
    const panned = panBy(restView(p, natural), p, natural, -200, 0);
    should(touchActionFor(panned, p, natural)).equal('pan-y');
  });

  test('should take everything in fullscreen, where no page is behind it', () => {
    const p = planViewport({
      columnWidth: 0,
      fullscreenBox: { height: 800, width: 400 },
      legibleScale: 0,
      maxHeight: 800,
      natural: { height: 1_600, width: 800 },
    });
    const zoomed = zoomTo(
      restView(p, { height: 1_600, width: 800 }),
      p,
      { height: 1_600, width: 800 },
      2,
      boxCentre(p),
    );
    should(touchActionFor(zoomed, p, { height: 1_600, width: 800 }, true)).equal('none');
  });
});

describe('natural size', () => {
  test('should read a compiled diagram’s viewBox', () => {
    should(viewBoxSize('<svg xmlns="x" width="100%" viewBox="0 0 320.5 480"><g/></svg>')).deepEqual({
      height: 480,
      width: 320.5,
    });
    should(viewBoxSize('<svg viewBox="-8, -8, 200, 100">')).deepEqual({ height: 100, width: 200 });
  });

  test('should be null without a usable viewBox', () => {
    should(viewBoxSize('<svg width="10" height="10"></svg>')).be.null();
    should(viewBoxSize('<svg viewBox="0 0 0 10"></svg>')).be.null();
    should(viewBoxSize('<svg><g viewBox="0 0 10 10"/></svg>')).be.null();
  });

  test('should prefer the pixel size an authored svg declares', () => {
    should(svgNaturalSize('<svg xmlns="x" width="800" height="400px" viewBox="0 0 10 5"/>')).deepEqual({
      height: 400,
      width: 800,
    });
  });

  test('should fall back to the viewBox when a length is a percentage or missing', () => {
    should(svgNaturalSize('<svg width="100%" height="50%" viewBox="0 0 640 320"/>')).deepEqual({
      height: 320,
      width: 640,
    });
    should(svgNaturalSize('<svg viewBox="0 0 640 320"/>')).deepEqual({ height: 320, width: 640 });
  });

  test('should be null when the svg declares no size at all', () => {
    should(svgNaturalSize('<svg xmlns="x"><rect/></svg>')).be.null();
  });
});

describe('planViewport — a very tall flowchart', () => {
  test('should rest at the legible scale and pan, rather than shrink its labels to nothing', () => {
    // Arrange — 300 × 1800: whole-fit would be 0.28 (4.5px labels).
    const actual = plan({ height: 1_800, width: 300 });

    // Assert
    should(actual.rest).equal(MERMAID_LEGIBLE_SCALE);
    should(actual.box.height).be.approximately(inlineMaxHeight(SCREEN), 1);
    should(actual.pansAtRest).be.true();
    should(actual.min).be.approximately(inlineMaxHeight(SCREEN) / 1_800, 1e-9);
  });
});
