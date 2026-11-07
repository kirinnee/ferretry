import { describe, expect, it } from 'bun:test';
import { laneProposalProject } from '../../../app/lib/lane-edit.ts';

const UUID = '3f1c2b7e-8a4d-4e0b-9c55-0d6a1b2c3d4e';

describe('the project a lane proposal names', () => {
  it('is a project id: a uuid, or the unfiled project', () => {
    expect(laneProposalProject(`lanes:${UUID}:2`)).toBe(UUID);
    expect(laneProposalProject('lanes:unfiled:1')).toBe('unfiled');
  });

  it('is nothing for a reference that names no project Board could have', () => {
    expect(laneProposalProject('lanes:not-a-uuid:1')).toBeUndefined();
    expect(laneProposalProject(`lanes:${UUID}:0`)).toBeUndefined();
    expect(laneProposalProject('gate:F1:1')).toBeUndefined();
    expect(laneProposalProject(null)).toBeUndefined();
  });
});
