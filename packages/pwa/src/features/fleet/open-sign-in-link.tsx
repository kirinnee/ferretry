/**
 * "Open sign-in page": the provider's sign-in link as a real link, beside Copy. Nothing opens on its own
 * (a pop-up blocker would eat it, and the link may be meant for another device), so the person taps this.
 * `noopener` keeps the provider's page from reaching back into this one.
 */

import { ExternalLink } from 'lucide-react';

export function OpenSignInLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      data-open-sign-in=""
      className="kt-btn kt-btn--sm shrink-0 no-underline"
    >
      <ExternalLink size={14} aria-hidden="true" />
      Open sign-in page
    </a>
  );
}
