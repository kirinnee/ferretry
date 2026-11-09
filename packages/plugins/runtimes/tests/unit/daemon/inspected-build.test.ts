/**
 * The daemon half is built against an inert kernel to compare it with its manifest (`fy check` manifest-match). Its
 * build must touch no path: the fleet folder is opened and spelled on first use of a service, never while building.
 */
import { describe, expect, it } from 'bun:test';
import { implementedSections } from '../../../../../../scripts/gen/lib/halves.ts';
import daemon from '../../../daemon/index.ts';

describe('the daemon half built against an inert kernel', () => {
  it('builds without spelling any path, so the manifest comparison can inspect it', () => {
    const inspected = implementedSections(daemon as unknown as Parameters<typeof implementedSections>[0]);

    expect(inspected).not.toHaveProperty('error');
    expect(Object.keys((inspected as { sections: Record<string, unknown> }).sections)).toContain('routes');
  });
});
