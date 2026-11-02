import { beforeAll, describe, expect, it } from 'bun:test';
import type { UpdateSource } from '../../../../src/features/shared/shared-controller.ts';
import {
  actLabel,
  askAgainPrefs,
  busyLabel,
  confirmLabel,
  installedText,
  MOVE_BUTTON,
  moveLines,
  moveSubtitle,
  PREVIEW_UNRELATED,
  plainRefusal,
  type RowAct,
  rowStatus,
  stayLabel,
  UPDATE_BUTTON,
  updateDisagreement,
  updateRequest,
  updateVerb,
} from '../../../../src/features/shared/store-row-model.ts';
import { catalogChanges } from '../../../support/catalog-views.ts';
import { installedAtV1, machinePreview, type UpdateFixture, updateFixture } from '../../../support/shared-screens.ts';

let fx: UpdateFixture;
beforeAll(async () => {
  fx = await updateFixture();
});

const sourceAt = (version: 1 | 2, withList: boolean): UpdateSource => {
  const offered = fx.signedVersions.versions.offered.find(line => line.version === version);
  return {
    item: version === 1 ? fx.v1 : fx.v2,
    manifest: fx.opened.manifest,
    signedManifest: fx.view.signed as never,
    ...(withList ? { signedVersions: fx.signedVersions } : {}),
    expectedDigest: offered?.digest ?? '',
  };
};

describe('rowStatus', () => {
  const held = (change: Record<string, unknown>) => installedAtV1(fx, change);

  it('says only "Installed v1" and offers nothing when the machine holds the listed version', () => {
    expect(rowStatus(held({}), 1)).toEqual({ kind: 'current', text: 'Installed v1', acts: [] });
  });

  it('offers every act when the publisher lists a newer version and nothing was chosen', () => {
    expect(rowStatus(held({}), 2)).toEqual({
      kind: 'update',
      text: 'Installed v1 · Update available',
      acts: ['changes', 'update', 'stay', 'skip', 'move'],
    });
  });

  it('says it is staying when the person chose to stay, and offers to ask again', () => {
    expect(rowStatus(held({ hold: true }), 2)).toEqual({
      kind: 'held',
      text: 'Installed v1 · Staying on v1',
      acts: ['again', 'move'],
    });
  });

  it('says it was skipped only for the version that was skipped', () => {
    expect(rowStatus(held({ skippedVersion: 2 }), 2)).toEqual({
      kind: 'skipped',
      text: 'Installed v1 · Skipped v2',
      acts: ['again', 'changes', 'move'],
    });
    expect(rowStatus(held({ skippedVersion: 2 }), 3).kind).toBe('update');
  });

  it('offers only a move when the machine is ahead of the listed version', () => {
    expect(rowStatus(held({}), 0)).toEqual({ kind: 'ahead', text: 'Installed v1', acts: ['move'] });
  });
});

describe('words', () => {
  it('labels every act with a plain verb', () => {
    const labels = (['changes', 'update', 'stay', 'skip', 'move', 'again'] as const satisfies readonly RowAct[]).map(
      act => actLabel(act, 4),
    );
    expect(labels).toEqual([
      'See changes',
      'Update',
      'Stay on v4',
      'Skip this version',
      'Move to version…',
      'Ask again',
    ]);
    expect(stayLabel(4)).toBe('Stay on v4');
    expect(installedText(4)).toBe('Installed v4');
  });

  it('clears the stay choice, else the skip', () => {
    expect(askAgainPrefs({ hold: true })).toEqual({ hold: false });
    expect(askAgainPrefs({})).toEqual({ skippedVersion: null });
  });

  it('picks the confirm and busy words by verb', () => {
    expect(confirmLabel('Update')).toBe(UPDATE_BUTTON);
    expect(confirmLabel('Move')).toBe(MOVE_BUTTON);
    expect(busyLabel('Update')).toBe('Updating…');
    expect(busyLabel('Move')).toBe('Moving…');
  });

  it('says Update only for the listed version above the installed one, else Move', () => {
    expect(updateVerb(2, 2, 1)).toBe('Update');
    expect(updateVerb(1, 2, 2)).toBe('Move');
    expect(updateVerb(3, 2, 1)).toBe('Move');
    expect(updateVerb(2, 2, 2)).toBe('Move');
  });

  it('says the move and a refusal that came from this app', () => {
    expect(moveSubtitle(1, 2, 'kirin-box')).toBe('v1 to v2 on kirin-box');
    expect(plainRefusal('No.')).toEqual({
      sentence: 'No.',
      previewAgain: false,
      olderOffered: false,
      editedOffered: false,
    });
  });
});

describe('moveLines', () => {
  it('lists every offered version newest first, said against the installed one, with fixed dates', () => {
    const lines = moveLines(fx.signedVersions.versions, 1);
    expect(lines.map(line => [line.version, line.direction, line.text])).toEqual([
      [2, 'newer', 'v2 · Newer · Current · 2026-10-31'],
      [1, 'installed', 'v1 · Installed · 2026-10-31'],
    ]);
    expect(lines.map(line => line.summary)).toEqual([fx.v2.summary, fx.v1.summary]);
  });

  it('calls a version below the installed one older', () => {
    expect(moveLines(fx.signedVersions.versions, 2).map(line => line.direction)).toEqual(['installed', 'older']);
  });
});

describe('updateRequest', () => {
  const record = () => installedAtV1(fx).install;

  it('targets the install, carries no list for the listed version, and does not allow older', () => {
    const install = record();
    const request = updateRequest(sourceAt(2, false), install, { replaceEdited: false });
    expect(request.target).toEqual(install.target);
    expect(request.item).toEqual(fx.v2);
    expect('signedVersions' in request).toBe(false);
    expect('allowOlder' in request).toBe(false);
    expect('replaceEdited' in request).toBe(false);
  });

  it('carries the list and asks to replace edits when told', () => {
    const install = record();
    const request = updateRequest(sourceAt(2, true), install, { replaceEdited: true });
    expect(request.signedVersions).toEqual(fx.signedVersions);
    expect(request.replaceEdited).toBe(true);
  });

  it('allows older only when the version is below the installed one', () => {
    const install = record();
    const installedV2 = { ...install, provenance: { ...install.provenance, version: 2 } };
    expect(updateRequest(sourceAt(1, true), installedV2, { replaceEdited: false }).allowOlder).toBe(true);
  });
});

describe('updateDisagreement', () => {
  const agree = () => machinePreview(fx, 2, { changes: catalogChanges() });

  it('is null when the machine names the same publisher, catalog, item, version and digest and replaces this install', () => {
    expect(updateDisagreement(sourceAt(2, false), installedAtV1(fx).install, agree())).toBeNull();
  });

  it('refuses a review for another version, another digest, another item or another install', () => {
    const { install: record } = installedAtV1(fx);
    const source = sourceAt(2, false);
    const withProvenance = (change: Record<string, unknown>) => {
      const base = agree();
      return { ...base, provenance: { ...base.provenance, ...change } };
    };
    expect(updateDisagreement(source, record, withProvenance({ version: 1 }))).toBe(PREVIEW_UNRELATED);
    expect(updateDisagreement(source, record, withProvenance({ digest: `sha256:${'cd'.repeat(32)}` }))).toBe(
      PREVIEW_UNRELATED,
    );
    expect(updateDisagreement(source, record, withProvenance({ itemId: `itm_${'z'.repeat(22)}` }))).toBe(
      PREVIEW_UNRELATED,
    );
    expect(updateDisagreement(source, record, { ...agree(), replaces: undefined })).toBe(PREVIEW_UNRELATED);
    expect(
      updateDisagreement(source, record, { ...agree(), replaces: { installId: `cin_${'z'.repeat(22)}`, version: 1 } }),
    ).toBe(PREVIEW_UNRELATED);
  });
});
