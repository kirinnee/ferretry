/**
 * HOW TO TEACH FERRETRY A SCREEN: the sentence the dialog notice adds, in fixed words.
 *
 * It names the way out (a button in the app, and a command) and says what happens: nothing is saved until the owner reads
 * the proposed rule and says yes. It carries no pane text — only the ferret's id, which is not pane text.
 */

/** Dialog kinds the owner is never asked to teach: a tool prompt is theirs to answer, a spent login is the auto-move's. */
const NOT_TAUGHT = ['permission', 'usage-limit'] as const;

/** The notice's `context` line says the kind: `Harness dialog (<kind>) seen on <ferret>.` */
export function isTeachable(context: string): boolean {
  return !NOT_TAUGHT.some(kind => context.startsWith(`Harness dialog (${kind})`));
}

/** What to do to have Ferretry clear this screen itself next time. */
export const teachSentence = (ferret: string): string =>
  `To have Ferretry clear this screen by itself next time: leave the ferret on it, then press “Look at its screen” in Settings › Warden, or run fy warden dialog learn ${ferret}. You read the rule it proposes before anything is saved.`;
