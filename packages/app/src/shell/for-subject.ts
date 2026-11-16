import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';

/**
 * A panel that draws ONLY for its own subject. A slot like `onboarding.step` mounts every panel placed there once per
 * subject (a step, `<plugin>.<stepId>`), so each contributor must stay silent for the others: this wraps a view so any
 * other subject draws nothing — and, for a lazily loaded view, loads nothing. It holds no React, so a half's
 * `index.ts` stays loadable by the registry generator before the shell is in place.
 */
export function forSubject(subject: string, view: AppComponent<PanelProps>): AppComponent<PanelProps> {
  return props => (props.subject === subject ? view(props) : null);
}
