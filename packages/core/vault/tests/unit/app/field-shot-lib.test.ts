/** The boxes drawn on the page picture: pure arithmetic over the facts the daemon observed, by field id. */
import { describe, expect, it } from 'bun:test';
import { shotBoxes } from '../../../app/lib/field-shot.ts';
import { fieldsOf } from '../../../app/lib/input-card.ts';
import type { InputRequest, InputShot } from '../../../contract/index.ts';
import { pageRequest, terminalRequest } from '../../support/app/input-fixtures.ts';

const SHOT: InputShot = { pngBase64: 'AAAA', clip: { x: 100, y: 200, w: 400, h: 200 } };

type Box = { x: number; y: number; w: number; h: number };

/** A page request whose two fields sit where the test says. */
function twoFields(user: Box, password: Box): InputRequest {
  const base = pageRequest();
  const seen = base.observed;
  if (seen?.kind !== 'page') throw new Error('fixture is a page');
  const template = must(seen.fields[0]);
  return {
    ...base,
    fields: [
      { id: 'user', label: 'Username', sensitivity: 'plain' },
      { id: 'pass', label: 'Password', sensitivity: 'secret' },
    ],
    observed: {
      ...seen,
      fields: [
        { ...template, fieldId: 'user', box: user },
        { ...template, fieldId: 'pass', box: password },
      ],
    },
  } as InputRequest;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

describe('shotBoxes', () => {
  it('scales each field box to the part of the page the picture shows, in percent', () => {
    const request = twoFields({ x: 200, y: 250, w: 200, h: 50 }, { x: 200, y: 300, w: 100, h: 100 });
    expect(shotBoxes(request, fieldsOf(request), SHOT)).toEqual([
      { key: 'user', label: 'Username', left: 25, top: 25, width: 50, height: 25 },
      { key: 'pass', label: 'Password', left: 25, top: 50, width: 25, height: 50 },
    ]);
  });

  it('clamps a box that spills over the picture to its edges', () => {
    const request = twoFields({ x: 50, y: 150, w: 600, h: 100 }, { x: 0, y: 0, w: 1, h: 1 });
    const [first] = shotBoxes(request, fieldsOf(request), SHOT);
    expect(first).toEqual({ key: 'user', label: 'Username', left: 0, top: 0, width: 100, height: 25 });
  });

  it('skips a field with no size, one wholly off the picture, and one the daemon did not find', () => {
    const request = twoFields({ x: 200, y: 250, w: 0, h: 50 }, { x: 900, y: 900, w: 10, h: 10 });
    expect(shotBoxes(request, fieldsOf(request), SHOT)).toEqual([]);
    const lone = pageRequest();
    const extra = [...fieldsOf(lone), { key: 'ghost', sensitivity: 'plain' as const, label: 'Ghost' }];
    expect(
      shotBoxes(lone, extra, { pngBase64: 'AAAA', clip: { x: -5, y: -5, w: 100, h: 100 } }).map(b => b.key),
    ).toEqual(['value']);
  });

  it('draws no box when the picture has no area', () => {
    const request = twoFields({ x: 200, y: 250, w: 20, h: 20 }, { x: 200, y: 300, w: 20, h: 20 });
    expect(shotBoxes(request, fieldsOf(request), { pngBase64: 'AAAA', clip: { x: 0, y: 0, w: 0, h: 10 } })).toEqual([]);
  });

  it('draws nothing for a terminal card, or one the daemon is still re-observing', () => {
    const terminal = terminalRequest();
    expect(shotBoxes(terminal, fieldsOf(terminal), SHOT)).toEqual([]);
    const looking = pageRequest({ observed: undefined, observedDigest: undefined });
    expect(shotBoxes(looking, fieldsOf(looking), SHOT)).toEqual([]);
  });
});
