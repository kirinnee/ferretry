# Cloudflare Pages deployment

The PWA is a public, static Cloudflare Pages site. It has no Pages Functions, origin backend, or
server-held secrets. Each browser receives a daemon address and device token only through the
runtime pairing flow.

## One-time setup

**You do not create the Pages project by hand.** The workflow creates `ferretry` on its first run
if it is missing. Cloudflare has merged Workers and Pages into a single "Ship something new" flow
whose direct-upload path asks for files before it will create a project — a chicken-and-egg for a
repository that deploys its own build. Two secrets are the whole setup.

1. **Account ID.** It is the hex string in your dashboard URL, right after `dash.cloudflare.com/`
   (also shown as _Account ID_ in the Workers & Pages sidebar). In GitHub, open **Settings** →
   **Secrets and variables** → **Actions** → **New repository secret** and create
   `CLOUDFLARE_ACCOUNT_ID` with that value.
2. **API token.** In Cloudflare, open your profile icon → **My Profile** → **API Tokens** →
   **Create Token**, then scroll to **Custom token** → **Get started**. Grant **Account** →
   **Cloudflare Pages** → **Edit**, and under _Account Resources_ include the account that will own
   `ferretry`. Cloudflare shows the token once; store it in the same GitHub Secrets page as
   `CLOUDFLARE_API_TOKEN`. That permission covers creating the project as well as deploying to it,
   which is why there is no separate project-creation step.
3. Push to `main` or run **Actions** → **Deploy PWA to Pages** → **Run workflow**. The workflow
   builds `packages/pwa/dist` and directly uploads that directory to the `ferretry` project.

## Deliberate deployment policy

- Pull requests receive no Pages preview URL. This keeps unreviewed branches from becoming public
  deployment surfaces; CI still validates pull requests.
- `_redirects` makes client-side routes serve `index.html`. `_headers` keeps `index.html` and the
  future generated manifests and service worker fresh so an installed PWA can discover a new
  release. Hashed Vite assets stay immutable.
- The CSP permits daemon connections to any secure HTTPS/WSS origin because pairing chooses that
  origin at runtime. It permits HTTP/WS only for localhost and `127.0.0.1`, which supports local
  pairing without granting arbitrary insecure-network access. Scripts remain restricted to this
  site; `'unsafe-inline'` is limited to styles because React's runtime style attributes need it.
