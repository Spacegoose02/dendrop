# Dendrop

Private, self-hosted chat for family and friends: direct messages, calls and chat servers,
with a raccoon at heart. Runs in one Docker container (made for Unraid) and signs in with
[TinyAuth](https://github.com/steveiliop56/tinyauth) or any OpenID Connect provider.

See [the roadmap](docs/ROADMAP.md) for what's planned and in what order.

## Running it

```sh
cp .env.example .env    # set DENDROP_PUBLIC_URL and the TinyAuth client
docker compose up -d --build
```

Open the address in `DENDROP_PUBLIC_URL`. The first account made (with a password, or the
first person to sign in through TinyAuth) becomes the super admin. Data lives in `/data`
(`/mnt/user/appdata/dendrop` by default).

### TinyAuth

Add an OIDC client in TinyAuth with the redirect URL
`https://<your Dendrop address>/api/auth/oidc/callback`, then set `DENDROP_OIDC_ISSUER`,
`DENDROP_OIDC_CLIENT_ID` and `DENDROP_OIDC_CLIENT_SECRET`. Accounts are made the first time
someone signs in. Once everyone uses TinyAuth you can set `DENDROP_LOCAL_LOGIN=false`.

## Developing

Node 22 or newer.

```sh
npm install
npm run dev:server   # API and gateway on :8080, data in ./data
npm run dev:web      # web client on :5173, proxied to the API
npm test
```

`npm run dev:server` keeps its data in `./data`.

| Package | What it is |
| --- | --- |
| `packages/shared` | Types and limits shared by the server and every client |
| `packages/theme` | Design tokens and theme ids; every client styles itself with these only |
| `packages/server` | Fastify API, WebSocket gateway at `/api/gateway`, SQLite, OIDC |
| `packages/web` | React client |
| `packages/desktop` | Electron app for Windows and Linux (Phase 2) |
| `packages/android` | Capacitor Android app (Phase 2) |
