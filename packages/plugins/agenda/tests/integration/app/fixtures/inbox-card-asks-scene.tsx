/**
 * The browser entry for the Inbox of a mixed fleet: the harness page (the real `AgendaInboxPage` over the real
 * `useAgendaInboxModel` and wire directory) with a machine that advertises card asks or one that does not.
 *
 *   ?theme=<family>-<mode>&machine=modern|older
 */

import '../../../harness/inbox-card-asks-page.tsx';

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get('theme') ?? 'studio-light';
