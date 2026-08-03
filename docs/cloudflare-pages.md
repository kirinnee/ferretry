# Cloudflare Pages deployment

The PWA is a public, static Cloudflare Pages site. It has no Pages Functions, origin backend, or
server-held secrets. Each browser receives a daemon address and device token only through the
runtime pairing flow.

## One-time setup

1. In Cloudflare, open **Workers & Pages** → **Create application** → **Pages** → **Direct Upload**.
   Create the public project named `ferretry`, with `main` as its production branch. Do not connect
   the Git repository: this repository deploys prebuilt assets with GitHub Actions.
2. In **Account Home** (or **Workers & Pages**), copy the **Account ID**. In GitHub, open
   **Settings** → **Secrets and variables** → **Actions** → **New repository secret** and create
   `CLOUDFLARE_ACCOUNT_ID` with that value.
3. In Cloudflare, open **My Profile** → **API Tokens** → **Create Token** → **Custom token**.
   Scope it to the account that owns `ferretry` and grant **Account** → **Cloudflare Pages** →
   **Edit**. Create the token once, then store it in the same GitHub Secrets page as
   `CLOUDFLARE_API_TOKEN`.
4. Push to `main` or run **Actions** → **Deploy PWA to Pages** → **Run workflow**. The workflow
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
