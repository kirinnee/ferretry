/**
 * zod's JIT OFF, for the whole page, before any schema is built (r12 H8).
 *
 * zod 4 compiles a schema into a function with `new Function(…)` when it may, and decides whether it may with a probe,
 * `new Function("")`, the first time a schema is made. The app's policy is `require-trusted-types-for 'script'`
 * (`public/_headers`): under it that probe throws a Trusted Types violation, which zod catches and swallows but the browser
 * REPORTS, once per page load, as a `securitypolicyviolation` of the sink `Function`. A page that is clean otherwise showed
 * one violation, and a violation counter that tolerates "the one known one" cannot tell a second one from it.
 *
 * `jitless: true` makes zod skip the probe and parse with its interpreter, which is what the policy asks of it anyway: no
 * code is built from text. The setting is global (`globalThis.__zod_globalConfig`), so it is held by ONE import, made FIRST
 * by `main.tsx` (an ES import runs before the code beside it, so a setting written in `main.tsx`'s body would come after every
 * schema its imports build) and by the scenes that stand in for the page (`@ferretry/app/zod-jitless`).
 */
import { z } from 'zod';

z.config({ jitless: true });
