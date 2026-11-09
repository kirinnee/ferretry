/**
 * THE SLOT ONBOARDING'S STEPS SCREEN OFFERS (§5.2). A plugin that declares a first-run step (`onboarding: [{ id }]` in
 * its manifest) contributes a panel to it with `panel('onboarding.step', { id })`; the steps screen mounts every panel
 * placed there once per declared step, with `subject = <plugin>.<stepId>`, and each panel draws only when the subject
 * is its own step. The shell draws no step itself, and Onboarding imports nothing of a contributor.
 *
 * Contributors write the slot name as this literal (a plugin's manifest may not import another plugin's contract for
 * a name); a test in this package pairs every declared step with a panel in this slot.
 */
export const ONBOARDING_STEP_SLOT = 'onboarding.step' as const;

/** The subject a step's panels are mounted with: `<plugin>.<stepId>`. */
export const stepSubject = (plugin: string, step: string): string => `${plugin}.${step}`;
