/**
 * G1 #2570 item 3: Add skills asks for the agent only when it cannot tell. An address that names none gets the ONLY harness
 * the machine runs; the picker offers what is installed; an address that names a harness a catalog cannot install into is
 * refused, never read as Claude.
 */
import { describe, expect, it } from 'bun:test';
import {
  installPlan,
  type RuntimeChoice,
  scopeLine,
  UNKNOWN_HARNESS,
} from '../../../../app/features/add-skills/add-skills-model.ts';
import { harnessChoices } from '../../../../app/features/catalogs/catalog-install-model.ts';
import { placeQuery, readPlace } from '../../../../app/lib/add-skills-address.ts';

const projects = [{ name: 'app', path: '/work/app' }];
const runtime = (harness: string, id = harness): RuntimeChoice => ({ id, wrapper: id, profile: 'default', harness });
const omitted = { cwd: '/work/app', harness: undefined, runtime: undefined };

describe('the agent an Add skills install is for, when the address names none', () => {
  it('should be Claude on a Claude-only machine, so the install is not left unset', () => {
    const plan = installPlan(omitted, projects, [runtime('claude-code'), runtime('claude-code', 'second')]);
    expect(plan.draft).toEqual({ scope: 'project', projectRoot: '/work/app', harness: 'claude' });
    expect(plan.harness).toBe('claude');
  });

  it('should be Codex on a Codex-only machine', () => {
    expect(installPlan(omitted, projects, [runtime('codex')]).draft).toMatchObject({ harness: 'codex' });
  });

  it('should be left to the person on a machine that runs both, or that could not say', () => {
    for (const runtimes of [[runtime('claude-code'), runtime('codex')], []]) {
      const plan = installPlan(omitted, projects, runtimes);
      expect(plan.draft).toEqual({ scope: 'project', projectRoot: '/work/app' });
      expect(plan.harness).toBeUndefined();
    }
  });

  it('should never be a harness that merely shares a word with Claude', () => {
    expect(installPlan(omitted, projects, [runtime('claude')]).draft).toEqual({
      scope: 'project',
      projectRoot: '/work/app',
    });
  });

  it('should keep the harness the address named', () => {
    const named = { ...omitted, harness: 'codex' as const };
    expect(installPlan(named, projects, [runtime('claude-code')]).draft).toMatchObject({ harness: 'codex' });
  });
});

describe('the agents the picker offers', () => {
  it('should be the harnesses the machine runs, by exact plugin key, in the table order', () => {
    expect(harnessChoices([runtime('claude-code')])).toEqual(['claude']);
    expect(harnessChoices([runtime('codex'), runtime('claude-code')])).toEqual(['claude', 'codex']);
    expect(harnessChoices([runtime('claude'), runtime('fake-third')])).toEqual([]);
  });

  it('should offer every harness when the machine could not say, and keep the one already chosen', () => {
    expect(harnessChoices([])).toEqual(['claude', 'codex']);
    expect(harnessChoices([{}])).toEqual(['claude', 'codex']);
    expect(harnessChoices([runtime('claude-code')], 'codex')).toEqual(['claude', 'codex']);
  });
});

describe('an address that names a harness a catalog cannot install into', () => {
  const props = { ferret: 'f', folder: '/work/app', scopes: [] as string[] };

  it('should be unknown, and carry the key it named', () => {
    expect(readPlace('?folder=/work/app&harness=fake-third')).toMatchObject({
      harness: UNKNOWN_HARNESS,
      unsupportedKey: 'fake-third',
    });
    expect(readPlace('?folder=/work/app&harness=claude')).toMatchObject({ harness: UNKNOWN_HARNESS });
    expect(readPlace(placeQuery({ ...props, harness: 'claude-code' })).harness).toBe('claude');
    expect(readPlace('?folder=/work/app').harness).toBeUndefined();
  });

  it('should be refused: no place offered, whatever the machine runs, and the sentence names the key', () => {
    const place = readPlace('?folder=/work/app&harness=fake-third&runtime=box');
    const plan = installPlan(place, projects, [runtime('claude-code', 'box')]);
    expect(plan).toMatchObject({ scope: 'none', draft: {}, refused: true });
    expect(scopeLine(plan)).toBe('fake-third is not a harness a catalog can install into yet.');
  });
});
