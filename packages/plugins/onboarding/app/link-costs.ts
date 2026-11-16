/**
 * The costs of linking a signed-in harness (§6.1), said in ONE line wherever a first-run step records `found` for a
 * sign-in that is the terminal's own. The same sentence is the CLI half's (`cli/lib/words.ts`); a test pins the two.
 */
export const LINK_COSTS =
  'This uses the sign-in your terminal already has, so ferrets share your quota and your provider account, signing out in your terminal signs them out too, and Usage cannot tell your spend from theirs; add a separate Ferretry login any time with `fy login add`.';
