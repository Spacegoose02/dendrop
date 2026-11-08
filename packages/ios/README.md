# @dendrop/ios

Dendrop for iPhone: a [Capacitor](https://capacitorjs.com) app that opens the Dendrop web client
from your own server, like the [Android app](../android/README.md), plus what an iPhone needs to
feel like a real chat app: notifications through Apple, and calls that ring on iOS's own incoming
call screen (CallKit), on the lock screen too.

## How it works

- **The chat is the web client your server already serves.** The app saves your server's address
  and loads it in its WebView with Capacitor's bridge added. Update the server and the phone gets
  the new client on its next launch. Signing in uses the same session cookie a browser would.
- **The setup page is the Android app's** (`packages/android/www-src`, which knows both platforms),
  built into the app by `scripts/build-www.mjs`. It shows on first launch, when the server can't be
  reached, and from the home screen quick action (long-press the icon, then **Server settings**).
- **Single sign-on stays in the app.** Redirects to TinyAuth or Google and back load in the app, so
  the app is the one that ends up signed in. Links people tap in chat open in Safari.
- **Swipe from the left edge** goes back, like Safari.
- **The notch and home bar** are kept clear by the web client's own CSS (`env(safe-area-inset-*)`),
  which also helps Safari's Add to Home Screen.

### End-to-end encryption

Works exactly as in Safari, because it's the same code (`packages/web/src/e2ee.ts`) in the same
engine: WebCrypto, with your account key kept in the app's own storage (IndexedDB) as a key that
can't be exported. The first time you open an encrypted chat on the iPhone you type your chat
passphrase once. Apps aren't subject to Safari's 7-day storage limit, so the key stays.

Encrypted calls use LiveKit's end-to-end encryption, which WebKit supports from iOS 16.4; that's
why the app needs iOS 16.4 or newer (iPhone 8 and later).

**HTTPS is required** for encryption, the microphone and the camera, just like in a browser.
Plain `http://192.168…` works for chatting only. iOS doesn't accept `DENDROP_HTTPS=self-signed`
certificates unless you install and trust them (AirDrop the `.crt` from `/data/tls` to the phone,
install the profile, then Settings, General, About, Certificate Trust Settings). A real
certificate is much easier: Tailscale (`tailscale cert`), Nginx Proxy Manager or SWAG with
Let's Encrypt, or a Cloudflare Tunnel. See [docs/HTTPS.md](../../docs/HTTPS.md).

### Notifications

Through Apple Push Notification service (APNs). There's nothing to install on the phone; turn them
on in the setup page.

**A push never carries what was said.** The server sends Apple one of two fixed alerts, "You have
a new message" or "An event you're going to is starting soon", with no sender, text or conversation.
A message notification is skipped while the app is open, and cleared when it's opened. Messages
collapse into one notification, like on Android.

### Calls

A call push says only `{"type":"call"}`. The app then shows iOS's incoming call screen at once
(iOS requires that), and fetches who's calling from **your server** with the session cookie, so
the caller's name never goes through Apple. While it rings, the app checks every few seconds, so
the screen stops when the caller hangs up or you answer on another device.

- **Answer**: the app joins the call in the web client (WebRTC through your LiveKit, encrypted end
  to end in encrypted chats). If the phone was locked, tap the Dendrop button on the call screen or
  unlock to see the call.
- **Decline / hang up** on the call screen tells your server straight away, even if the app wasn't
  open.
- Calls you start or answer inside the app also show as calls in iOS (green pill, lock screen
  controls), so audio keeps going with the screen off.
- Mute and camera are in the app's call panel; the call screen's mute button isn't wired up yet.

## What you need on your side

Push notifications, the call screen and installing on iPhones all need a paid **Apple Developer
Program** membership ($99 a year, <https://developer.apple.com/programs/enroll/>). A free Apple ID
can put the app on your own phone from Xcode for 7 days at a time, but with no notifications or
call ringing.

**You don't need a Mac.** GitHub Actions builds the app on a Mac runner and sends it to
**TestFlight**, Apple's app for installing test builds; you and your family install Dendrop from
there. (With a Mac and Xcode you can also build and run it yourself, see below.)

### One-time setup (about 30 minutes, then wait for Apple)

1. **Join the Apple Developer Program.** Approval can take a day or two. Note your **Team ID**
   (developer.apple.com, Account, Membership details).
2. **Register the app id.** Certificates, Identifiers & Profiles, Identifiers, +, App IDs, App:
   bundle id `io.github.spacegoose02.dendrop` (explicit), and tick **Push Notifications**.
3. **Create the app in App Store Connect** (appstoreconnect.apple.com, Apps, +, New App): iOS, any
   name that's free on the store (for example "Dendrop Den"), the bundle id above, any SKU. It
   doesn't have to go on the App Store; TestFlight is enough.
4. **Make an App Store Connect API key for GitHub.** App Store Connect, Users and Access,
   Integrations, App Store Connect API, Team Keys, +, access **Admin** (Xcode's cloud signing needs
   it to make the signing certificate). Download the `.p8` (only possible once) and note the
   **Key ID** and the **Issuer ID**.
5. **Add four repository secrets** (GitHub, Settings, Secrets and variables, Actions):

   | Secret | Value |
   | --- | --- |
   | `APPSTORE_API_KEY_ID` | the Key ID from step 4 |
   | `APPSTORE_API_ISSUER_ID` | the Issuer ID from step 4 |
   | `APPSTORE_API_KEY_P8` | the whole text of the `.p8` file from step 4 |
   | `APPLE_TEAM_ID` | your Team ID from step 1 |

6. **Build.** Actions, **iOS**, Run workflow (it also runs on every push to `main` that touches the
   app). The build shows up in App Store Connect, TestFlight, after Apple processes it (10 to 30
   minutes). Answer the export compliance question there for each build: Dendrop's encryption is
   standard algorithms provided by iOS itself (WebCrypto).
7. **Install.** Add people under TestFlight: **internal testers** (up to 100, who must be added to
   your App Store Connect team under Users and Access) get builds straight away; **external
   testers** (anyone, by email or a public link) need a short Apple beta review of the first build.
   Each person installs the **TestFlight** app from the App Store and then Dendrop from it.
   TestFlight builds expire after 90 days; run the workflow again for a fresh one.

### On the server: the APNs key

So your Dendrop server can send pushes to iPhones:

1. developer.apple.com, Certificates, Identifiers & Profiles, **Keys**, +, tick **Apple Push
   Notifications service (APNs)**, Continue, Register, **Download** the `.p8` (only possible once)
   and note its **Key ID**.
2. Put the file in Dendrop's appdata folder, for example
   `/mnt/user/appdata/dendrop/AuthKey_ABCDE12345.p8`.
3. Set these on the container (in the Unraid template they're under "Show more settings"), then
   restart it:

   | Variable | Value |
   | --- | --- |
   | `DENDROP_APNS_KEY_FILE` | `/data/AuthKey_ABCDE12345.p8` |
   | `DENDROP_APNS_KEY_ID` | the key's Key ID |
   | `DENDROP_APNS_TEAM_ID` | your Team ID |

One key works for every build: TestFlight and App Store builds use Apple's production servers and
builds run from Xcode use the sandbox; the app tells the server which. Without the key, the setup
page says "your server doesn't have an Apple push key yet" and the app still works, just without
notifications or the call screen (calls then ring inside the app while it's open).

### With a Mac instead

Xcode 16 or newer, Node 22:

```sh
cd packages/ios
npm ci
npm run sync          # builds www/ and copies it into the Xcode project
open ios/App/App.xcodeproj
```

In Xcode pick the **App** target, Signing & Capabilities, your Team, then run it on your iPhone
(connected by cable, with Developer Mode on). Product, Archive uploads to TestFlight the same way
the workflow does.

## Server contract

On top of the Android app's (see [its README](../android/README.md#what-the-server-does)):

| Request | Body | Meaning |
| --- | --- | --- |
| `GET /api/push/config` | none, public | Also has `"apns": {"enabled": true, "bundleId": "…"}`, false when the server has no APNs key. |
| `POST /api/push/subscriptions` | `{"endpoint": "apns://production/<token>", "provider": "apns", "deviceName": "…"}` | The alert token, for messages and events. `sandbox` instead of `production` for Xcode builds. |
| `POST /api/push/subscriptions` | `{"endpoint": "apns-voip://production/<token>", "provider": "apns-voip", …}` | The PushKit token, which only gets calls. |
| `GET /api/me`, `GET /api/calls`, `GET /api/conversations/:id` | none | Read while a call rings, to name the caller and stop ringing when it's over. |
| `POST /api/conversations/:id/call/decline` and `/call/leave` | `{}` | Declining or hanging up on the call screen. |

The server sends alerts with `apns-push-type: alert` and `apns-collapse-id` set to the kind, and
calls with `apns-push-type: voip` to the `<bundle id>.voip` topic, both signed with an ES256 token
made from the `.p8` key (`packages/server/src/apns.ts`). Tokens Apple says are gone are dropped.

The web client talks to the app through `packages/web/src/native.ts`: it asks whether iOS rings
for calls (then it doesn't ring itself), joins a call answered on the call screen, and tells the
app when it joins or leaves a call.

## Layout

```
capacitor.config.json   app id, setup page, error page, Capacitor's notification handling off
scripts/build-www.mjs   builds www/ from packages/android/www-src
scripts/make-icons.mjs  draws the app icon and launch image from packages/web/public/favicon.svg
ios/App/App/
  AppDelegate.swift         notifications, and starting PushKit at every launch
  SceneDelegate.swift       the window, and the Server settings quick action
  MainViewController.swift  loads the saved server, or the setup page before there is one
  DendropPlugin.swift       native calls for the setup page and the web client; keeps sign-in in the app
  PushRegistrar.swift       tells the server this iPhone's APNs tokens
  CallManager.swift         PushKit and CallKit: the incoming call screen
  ServerAPI.swift           requests to your server with the WebView's session cookie
  ServerSettings.swift      the saved server address
  App.entitlements          Push Notifications
  Info.plist                mic, camera and local network wording, background modes (audio, voip, remote-notification)
```

## Not tested on a device yet

This was written without an iPhone or Mac at hand; GitHub Actions compiles it on every change.
Worth checking on a real phone first: that a call answered from the lock screen connects audio
once the app opens (CallKit and WebKit share the audio session), and that SSO sign-in comes back
into the app.
