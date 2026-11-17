import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { loadManifests, loadWorkspace } from '../../../../../../../scripts/gen/lib/workspace.ts';
import { RestartStatusSchema } from '../../../../contract/session-restart.ts';
import { LaunchInstructionSectionIdSchema, SessionOutdatedSchema } from '../../../../contract/view/ferret-view.ts';
import { outdatedSectionIds, sectionDigests } from '../../../../daemon/lib/ferrets/launch-sections.ts';

/**
 * E1: a launch records every instruction entry a plugin manifest declares as a section id (`sectionDigests`), and the
 * ferret view and `GET /v1/restarts` parse those ids. An id the schema does not list is dropped from `outdated` (a
 * reworded `claude-code/rm-targets` never marked a Claude ferret out of date) and refused by the view schemas.
 */

const ROOT = resolve(import.meta.dir, '../../../../../../..');
const { loaded } = await loadManifests(loadWorkspace(ROOT));
const declared = loaded.flatMap(subsystem =>
  (subsystem.manifest.instructions ?? []).map(entry => ({ plugin: subsystem.id, id: entry.id })),
);

describe('launch instruction section ids against the shipped manifests', () => {
  test('the workspace declares instruction entries', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  test('every instruction id a manifest declares parses as a launch section id', () => {
    const refused = declared.filter(entry => !LaunchInstructionSectionIdSchema.safeParse(entry.id).success);
    expect(refused).toEqual([]);
  });

  test('every declared id is accepted by the outdated lists the view and the restart status carry', () => {
    for (const entry of declared) {
      expect(SessionOutdatedSchema.safeParse({ sections: [entry.id] }).success).toBe(true);
      expect(
        RestartStatusSchema.safeParse({ outdated: [{ id: 'aa', name: 'aa', sections: [entry.id] }], queued: [] })
          .success,
      ).toBe(true);
    }
  });

  test('a reworded declared section is reported outdated, whichever plugin declares it', () => {
    for (const entry of declared) {
      const told = sectionDigests([
        { plugin: entry.plugin, id: entry.id, text: 'before', when: { role: 'any' } } as never,
      ]);
      const now = sectionDigests([
        { plugin: entry.plugin, id: entry.id, text: 'after', when: { role: 'any' } } as never,
      ]);
      expect(outdatedSectionIds(told, now)).toEqual([entry.id as never]);
    }
  });
});
