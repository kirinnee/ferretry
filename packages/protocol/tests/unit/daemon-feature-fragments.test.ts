import { describe, it } from 'bun:test';
import should from 'should';
import { DAEMON_FEATURES } from '../../src/lib/daemon-features/index.ts';
import { AGENDA_FEATURES } from '../../src/lib/daemon-features/agenda.ts';
import { BOARD_FEATURES } from '../../src/lib/daemon-features/board.ts';
import { CATALOG_FEATURES } from '../../src/lib/daemon-features/catalogs.ts';
import { PACK_FEATURES } from '../../src/lib/daemon-features/pack.ts';
import { PUSH_FEATURES } from '../../src/lib/daemon-features/push.ts';
import { SECRETS_FEATURES } from '../../src/lib/daemon-features/secrets.ts';
import { SESSION_FEATURES } from '../../src/lib/daemon-features/session.ts';
import { SHARED_DRAFT_FEATURES } from '../../src/lib/daemon-features/shared-draft.ts';
import { USAGE_FEATURES } from '../../src/lib/daemon-features/usage.ts';

/**
 * `DAEMON_FEATURES` is the spread of one fragment per area. A spread silently lets a later fragment overwrite an
 * earlier one's key, so the guard looks at the FRAGMENTS, not at the merged object.
 */
const FRAGMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  agenda: AGENDA_FEATURES,
  board: BOARD_FEATURES,
  catalogs: CATALOG_FEATURES,
  pack: PACK_FEATURES,
  push: PUSH_FEATURES,
  secrets: SECRETS_FEATURES,
  session: SESSION_FEATURES,
  'shared-draft': SHARED_DRAFT_FEATURES,
  usage: USAGE_FEATURES,
};

/** Every `[area, key, wireValue]` the fragments declare. */
const declared = (): readonly (readonly [string, string, string])[] =>
  Object.entries(FRAGMENTS).flatMap(([area, fragment]) =>
    Object.entries(fragment).map(([key, value]) => [area, key, value] as const),
  );

/** The entries whose `pick` appears more than once, with where each came from. */
const duplicated = (pick: (entry: readonly [string, string, string]) => string): readonly string[] => {
  const seen = new Map<string, string[]>();
  for (const entry of declared()) seen.set(pick(entry), [...(seen.get(pick(entry)) ?? []), `${entry[0]}.${entry[1]}`]);
  return [...seen].filter(([, owners]) => owners.length > 1).map(([name, owners]) => `${name}: ${owners.join(', ')}`);
};

describe('the DAEMON_FEATURES fragments', () => {
  it('should never share a key between two areas', () => {
    should(duplicated(([, key]) => key)).eql([]);
  });

  it('should never share a wire value between two areas or two keys', () => {
    should(duplicated(([, , value]) => value)).eql([]);
  });

  it('should spread back into DAEMON_FEATURES with every key and value and nothing else', () => {
    const merged = Object.fromEntries(declared().map(([, key, value]) => [key, value]));
    should(DAEMON_FEATURES).eql(merged);
  });
});
