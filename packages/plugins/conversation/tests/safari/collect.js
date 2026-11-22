// Installed as a CLASSIC script before the page's modules (Safari has no console or request endpoint to ask, and
// `safaridriver` cannot add an init script): the page keeps its own record of what went wrong, and the driver reads it.
(() => {
  const seen = (window.__h8 = { csp: [], errors: [], console: [] });
  const text = value => String(value).slice(0, 240);
  document.addEventListener('securitypolicyviolation', e =>
    seen.csp.push(
      text(
        `${e.effectiveDirective} ${e.blockedURI || ''} ${(e.sourceFile || '').split('/').pop()}:${e.lineNumber} ${e.sample || ''}`,
      ),
    ),
  );
  // Capture phase: a failed <img>, <script> or <link> reports on its element and does not bubble to the window.
  window.addEventListener(
    'error',
    e =>
      seen.errors.push(
        text(e.target && e.target !== window ? `failed to load ${e.target.src || e.target.href}` : e.message),
      ),
    true,
  );
  window.addEventListener('unhandledrejection', e => seen.errors.push(text(`rejection ${e.reason}`)));
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      seen.console.push(text(`${level} ${args.map(String).join(' ')}`));
      original(...args);
    };
  }
})();
