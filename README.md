# Dendrop

Private, self-hosted chat for family and friends: direct messages, calls and chat servers,
with a raccoon at heart. Runs in one Docker container (made for Unraid) and signs in with
[TinyAuth](https://github.com/steveiliop56/tinyauth) or any OpenID Connect provider.

See [the roadmap](docs/ROADMAP.md) for what's planned and in what order, and
[docs/LOOTDEN.md](docs/LOOTDEN.md) for linking LootDen and posting into channels with webhooks,
[docs/DENDUTY.md](docs/DENDUTY.md) for linking Den Duty, the family chore tracker,
[docs/BOTS.md](docs/BOTS.md) for bots that post with buttons and answer clicks,
[docs/EXPRESSIONS.md](docs/EXPRESSIONS.md) for custom emoji, stickers, reactions and GIFs, and
[docs/COUPLES.md](docs/COUPLES.md) for the couples kit, a private corner of a chat between two adults.

## Running it

Everything is in one image, `ghcr.io/spacegoose02/dendrop`: the web app, the API and a
[LiveKit](https://livekit.io) server for calls, which Dendrop starts itself. Sign-in goes
through your TinyAuth (or any OpenID Connect provider), which stays its own container.

The first account made (with a password, or the first person to sign in through TinyAuth)
becomes the super admin. Data lives in `/data` (`/mnt/user/appdata/dendrop` by default).

### Unraid

1. Install the template, from the Unraid terminal:

   ```sh
   wget -O /boot/config/plugins/dockerMan/templates-user/my-dendrop.xml \
     https://raw.githubusercontent.com/Spacegoose02/dendrop/main/deploy/unraid/dendrop.xml
   ```

2. Docker tab, **Add Container**, pick **dendrop** from the Template list.
3. Fill in **Public address** and the three **TinyAuth** fields (see below), then **Apply**.

Or, by hand, Docker tab, Add Container:

| Field | Value |
| --- | --- |
| Repository | `ghcr.io/spacegoose02/dendrop:latest` |
| Network | Bridge |
| WebUI | `http://[IP]:[PORT:8080]/` |
| Port | container `8080`, host any free port |
| Port | container `7881` TCP, host `7881` (calls) |
| Port | container `7882` UDP, host `7882` (calls) |
| Path | container `/data`, host `/mnt/user/appdata/dendrop` |
| Variable | `DENDROP_PUBLIC_URL`, e.g. `https://chat.example.com` |
| Variable | `DENDROP_HTTPS`, `self-signed` for built-in HTTPS without a proxy (optional) |

The call ports must use the **same number** on the host as in the container, because that
number is what callers are told to send audio and video to.

**Use an `https://` address.** Browsers only allow encryption and the mic and camera on
HTTPS, so on plain `http://192.168.x.x:8080` you can chat but not turn on encryption or
make calls. For a quick start at home set **HTTPS** to `self-signed` and open
`https://<Unraid IP>:8080`; [docs/HTTPS.md](docs/HTTPS.md) has that and the proper options
(Tailscale, Nginx Proxy Manager or SWAG, Cloudflare Tunnel).

Then, outside Unraid:

- **Reverse proxy**: point `chat.example.com` at port 8080 with WebSockets on. Calls use the
  same address (Dendrop passes LiveKit's `/rtc` through), so there's no second site.
- **Router**: forward 7881/tcp and 7882/udp to the Unraid box so calls work away from home.

The container starts as root, sets the owner of `/data` to `PUID:PGID` (99:100,
nobody:users) and then runs as that user.

### docker compose

```sh
cp .env.example .env    # set DENDROP_PUBLIC_URL and the TinyAuth client
docker compose up -d    # or --build to build from this folder
```

### TinyAuth

Add an OIDC client in TinyAuth with the redirect URL
`https://<your Dendrop address>/api/auth/oidc/callback`, then set `DENDROP_OIDC_ISSUER`,
`DENDROP_OIDC_CLIENT_ID` and `DENDROP_OIDC_CLIENT_SECRET`. Accounts are made the first time
someone signs in. Once everyone uses TinyAuth you can set `DENDROP_LOCAL_LOGIN=false`.

### Google, account linking and who can sign up

People can link Google and TinyAuth to their account in Settings and sign in any way they
like. A super admin switches sign-up, each sign-in method and kid accounts on and off under
**Instance admin → Sign-in**. Setting up Google takes a few minutes in Google Cloud; see
[docs/SIGN-IN.md](docs/SIGN-IN.md).

### Calls

On by default, with nothing to set up beyond the two ports above. LiveKit finds your public
IP when it starts; if it can't (no internet yet, or a STUN block), it keeps retrying, and you
can set `DENDROP_CALLS_IP` to the public IP instead. `DENDROP_CALLS=off` turns calls off.

Already run your own LiveKit server? Set `DENDROP_LIVEKIT_URL`, `DENDROP_LIVEKIT_API_KEY` and
`DENDROP_LIVEKIT_API_SECRET` and Dendrop uses that one instead of its own.

### Phone notifications

The Android app sends notifications through [ntfy](https://ntfy.sh). Install the ntfy app on
the phone and pick it in Dendrop; it uses ntfy.sh unless you point it at your own ntfy server,
so there's nothing to run on Unraid. Notifications say only "new message" or "incoming call".
If your own ntfy server is on the home network over plain `http://`, set
`DENDROP_PUSH_ALLOW_HTTP=true`.

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
| `packages/desktop` | Electron app for Windows 11 and Linux, wrapping the web client ([README](packages/desktop/README.md)) |
| `packages/android` | Capacitor Android app (Phase 2) |
