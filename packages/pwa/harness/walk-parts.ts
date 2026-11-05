/**
 * The parts walked once per viewport, as independent tasks; the others are passes of their own. This is the
 * ONE list: `screenshot.ts` types its segments from it, so a segment added there and not here (or here and
 * not there) is a type error, and `partsOwedOver` cannot miss it.
 */
export const VIEWPORT_PARTS = ['gallery', 'settings', 'sessions', 'overlays'] as const;

/**
 * WHICH INDEPENDENT PARTS OF THE GALLERY WALK A RUN TAKES: all of them, unless `--parts a,b` names some.
 *
 * `screenshot.ts` already walks its parts as independent tasks in one Chrome (`ordered-pool.ts`), each in
 * its own context. CI used to run them all in one job per viewport, and the slowest leg took ~2.2 minutes of
 * walking on its own. `--parts` is how CI spreads the SAME tasks over more jobs: a leg walks only the parts
 * it names, and owes only the tallies those parts produce. The legs together must name every part for each
 * viewport, which `tests/unit/harness-walk-parts.test.ts` holds the CI matrix to — a part no leg names would
 * be a proof that quietly stopped running.
 *
 * The three tallies the Settings walk makes (sideways scroll, Machines geometry, terminal geometry) belong to
 * the `settings` part. The session layout, the safe-area and the sessions-page passes open their own
 * contexts and are parts of their own, still owned by one viewport each (`PASS_OWNER` in `screenshot.ts`).
 *
 * Every part `--parts` can name: the per-viewport parts and the passes that own one viewport each.
 */
export const WALK_PARTS = [...VIEWPORT_PARTS, 'layout', 'safe-area', 'sessions-page'] as const;

export type WalkPartName = (typeof WALK_PARTS)[number];

/**
 * WHICH VIEWPORT'S RUN OWES EACH PASS THAT OPENS ITS OWN CONTEXTS after the viewport loop. They pick
 * their own widths, so they are not split; each is owed in full by exactly one viewport, so a split run
 * owes it once between its two legs and an unsplit run owes all three. The safe-area and sessions-page
 * passes measure phones only; the session layout is mostly 1100–1920px desktops, so it is the desktop's.
 */
export const PASS_OWNER_OF_PART = {
  layout: 'desktop',
  'safe-area': 'mobile',
  'sessions-page': 'mobile',
} as const satisfies Partial<Record<WalkPartName, 'mobile' | 'desktop'>>;

/**
 * Every part a run over `viewports` owes in total: the gallery's four per viewport (only `settings` in the
 * settings scope) and the passes those viewports own. The CI legs for one scheme must name exactly these.
 */
export const partsOwedOver = (
  scope: 'settings' | 'full',
  viewports: readonly ('mobile' | 'desktop')[],
): ReadonlySet<WalkPartName> =>
  new Set<WalkPartName>([
    ...(scope === 'full' ? VIEWPORT_PARTS : (['settings'] as const)),
    ...(Object.keys(PASS_OWNER_OF_PART) as (keyof typeof PASS_OWNER_OF_PART)[]).filter(part =>
      viewports.includes(PASS_OWNER_OF_PART[part]),
    ),
  ]);

/**
 * The sentence that refuses a `--parts` set which leaves this run NOTHING to do, or `undefined`: no
 * per-viewport part among the selected viewports and no pass one of them owns. Such a leg would walk no
 * frame and owe no tally, and still pass — `--viewport mobile --parts layout`, since the layout pass is the
 * desktop's. `undefined` parts (all of them) always have something to do.
 */
export const refuseVacuousParts = (
  parts: ReadonlySet<WalkPartName> | undefined,
  scope: 'settings' | 'full',
  viewports: readonly ('mobile' | 'desktop')[],
): string | undefined => {
  if (parts === undefined) return undefined;
  const owed = partsOwedOver(scope, viewports);
  if ([...parts].some(part => owed.has(part))) return undefined;
  return `--parts ${[...parts].join(',')} leaves nothing to do on ${viewports.join(' + ')}: it owes ${[...owed].join(', ')} there`;
};

const isWalkPart = (candidate: string): candidate is WalkPartName =>
  (WALK_PARTS as readonly string[]).includes(candidate);

/** The parts `--parts` names, `undefined` for "all", or the sentence that refuses what it was given. */
export const parseWalkParts = (
  argv: readonly string[],
): { readonly parts: ReadonlySet<WalkPartName> | undefined } | { readonly refusal: string } => {
  const at = argv.indexOf('--parts');
  if (at === -1) return { parts: undefined };
  const wanted = (argv[at + 1] ?? '').split(',').filter(name => name !== '');
  const unknown = wanted.filter(name => !isWalkPart(name));
  if (wanted.length === 0 || unknown.length > 0)
    return {
      refusal: `--parts takes a comma-separated list of ${WALK_PARTS.join(', ')}, not ${unknown.join(', ') || 'nothing'}`,
    };
  return { parts: new Set(wanted as WalkPartName[]) };
};
