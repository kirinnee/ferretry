/**
 * Runtimes' app half, parity with today's Runtimes, Profiles and Model sets surfaces (docs/design/rebuild-parity.tsv,
 * owner `runtimes`, kind S). One test per screen per state, its title naming every row it proves. The Runtimes tab and
 * the composer's runtime picker are drawn in `app-runtimes-screens.tsx`, the Profiles and Model sets tabs in
 * `app-profiles-screens.tsx`; this file is the one test file the rows name and it runs both.
 */
import './app-runtimes-screens.tsx';
import './app-profiles-screens.tsx';
