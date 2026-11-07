# HTTPS

Browsers only let a page use encryption (WebCrypto) and the microphone and camera when it's
on a secure address: `https://`, or `localhost` on the machine itself. Opened as plain
`http://192.168.1.10:8080`, Dendrop works for chatting, but **end-to-end encryption can't be
turned on and calls can't use the mic or camera**. The app says so when that happens.

So give Dendrop an `https://` address. Pick one of these. On Unraid, the first is a minute's
work; the others give a proper certificate with no browser warning.

| Option | Browser warning | Works away from home | Android and desktop apps |
| --- | --- | --- | --- |
| [Built-in, self-signed](#1-built-in-https-self-signed) | Once per device | Only with port forwarding | No (they need a trusted certificate) |
| [Tailscale](#2-tailscale) | None | On devices with Tailscale | Yes |
| [Reverse proxy](#3-reverse-proxy-nginx-proxy-manager-or-swag) | None | Yes | Yes |
| [Cloudflare Tunnel](#4-cloudflare-tunnel) | None | Yes | Yes |

## 1. Built-in HTTPS (self-signed)

Quickest, for using Dendrop in a browser at home.

1. Unraid, Docker tab, click Dendrop, **Edit**.
2. Set **HTTPS** (`DENDROP_HTTPS`) to `self-signed`. If you set **Public address**, change it
   to `https://...` too, e.g. `https://192.168.1.10:8080`.
3. **Apply**. On first start Dendrop makes a certificate in `/data/tls`.
4. Open `https://<Unraid IP>:<port>/` (https, same port as before). The browser warns that
   the certificate isn't trusted: choose **Advanced**, then **Continue** (Chrome, Edge) or
   **Accept the risk** (Firefox). You do this once on each device.

The port now speaks only HTTPS, so `http://` links to it (like Unraid's WebUI button) stop
working. To go back, clear the setting.

Have a certificate of your own (for example from `tailscale cert` or Let's Encrypt)? Put the
files in the appdata folder and set `DENDROP_TLS_CERT=/data/tls/cert.pem` and
`DENDROP_TLS_KEY=/data/tls/key.pem` instead.

## 2. Tailscale

If your devices use [Tailscale](https://tailscale.com), it can give Dendrop a real
certificate at an address like `https://dendrop.your-tailnet.ts.net`, with nothing opened on
your router.

- **Unraid 7** has Tailscale built in: edit the Dendrop container, turn on **Use Tailscale**,
  and turn on **Tailscale Serve** for port 8080. Then open the `https://...ts.net` address it
  shows.
- **Or on any machine with Tailscale**: `tailscale serve --bg 8080` there, if Dendrop runs on
  it, gives the same.

Turn on HTTPS certificates for your tailnet once, in the Tailscale admin console under DNS.
Set **Public address** to the `https://...ts.net` address.

## 3. Reverse proxy (Nginx Proxy Manager or SWAG)

For a real domain, like `https://chat.example.com`, reachable from anywhere. You need a
domain name pointing at your home IP, and ports 80 and 443 forwarded to the proxy.

**Nginx Proxy Manager** (Unraid Apps tab):

1. **Hosts**, **Proxy Hosts**, **Add Proxy Host**.
2. Domain `chat.example.com`, scheme `http`, forward to your Unraid IP and Dendrop's port
   (8080). Turn on **Websockets Support**.
3. **SSL** tab: **Request a new SSL Certificate**, turn on **Force SSL**, save.

**SWAG**: copy `nginx/proxy-confs/` to a `dendrop.subdomain.conf` (start from any of the
samples), set `server_name chat.*;`, `$upstream_app` to your Unraid IP and `$upstream_port`
to 8080. SWAG's proxy settings already pass WebSockets through.

Then set Dendrop's **Public address** to `https://chat.example.com`. Calls go through the
same address; only the media ports, 7881/tcp and 7882/udp, are forwarded separately (see
the README).

## 4. Cloudflare Tunnel

No ports to open for the web app: in Cloudflare Zero Trust, add a public hostname such as
`chat.example.com` pointing at `http://<Unraid IP>:8080` (WebSockets work by default). Set
**Public address** to it. Call media doesn't go through the tunnel, so for calls away from
home still forward 7881/tcp and 7882/udp.
