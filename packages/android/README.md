# @dendrop/android

Dendrop for Android: a [Capacitor](https://capacitorjs.com) app that opens the Dendrop web client
from your own server, plus the native bits a phone needs (notifications now; the incoming call
screen and chat bubbles later).

## How it works

- **The chat is the web client your server already serves.** The app saves your server's address
  and loads it in its WebView, with Capacitor's native bridge added. Nothing in `packages/web` is
  forked or changed, the app always matches your server's version (update the server and the
  phone gets the new client on its next launch), and signing in uses the same session cookie a
  browser would, so the gateway's origin check passes unchanged.
- **A small setup page is built into the APK** (`www-src/`, built into `www/`). It shows on first
  launch, when the server can't be reached, and from the launcher shortcut (long-press the icon,
  then **Server settings**). It picks the server and turns notifications on or off. It's styled
  with the `--dd-*` tokens from `packages/theme`, which are inlined at build time.
- **Single sign-on stays in the app.** Redirects to your identity provider and back load in the
  WebView instead of the browser, so the app is the one that ends up signed in. Links people tap
  in chat still open in the browser.
- **Plain `http://` addresses are allowed** for servers on a home network (for example
  `http://192.168.1.20:8080`). Prefer HTTPS when the server is reachable from outside.
- **Back** goes back inside the app, and on the first screen sends the app to the background
  instead of closing it.

## Notifications, privately

Pushes go through [UnifiedPush](https://unifiedpush.org), not Google's Firebase. You install a
distributor app, normally [ntfy](https://ntfy.sh) (F-Droid or Play Store), which can use the
public ntfy.sh server or your own ntfy container next to Dendrop on Unraid.

**A push never carries what was said.** The server sends only a wake-up, at most
`{"type":"message"}` or `{"type":"call"}`, and the app shows "Dendrop: You have a new message" or
"Incoming call". No text, no sender name, no conversation. Pushes are also encrypted with Web Push
keys (RFC 8291) when the server supports it, so ntfy only ever sees ciphertext anyway. The message
notification is skipped while the app is open, and cleared when it's opened.

Channels: **Messages** and **Calls**, both changeable in Android's settings for the app.

### What the server does

The server side is in `packages/server` (PR #10). The app talks to:

| Request | Body | Meaning |
| --- | --- | --- |
| `GET /api/push/config` | none, public | Optional. `{"vapidPublicKey": "<base64url P-256 key>"}` if the server signs pushes with VAPID. A 404 is fine. |
| `POST /api/push/subscriptions` | `{"endpoint": "https://ntfy.sh/up…", "keys": {"p256dh": "…", "auth": "…"}, "provider": "unifiedpush", "deviceName": "Google Pixel 8"}` | Sent with the session cookie. Save or update the subscription for the signed-in user (keyed by `endpoint`). Return 2xx. 401 when signed out. |
| `DELETE /api/push/subscriptions` | `{"endpoint": "…"}` | Sent with the session cookie when notifications are turned off. |

To notify, the server POSTs to the endpoint: a Web Push message (RFC 8291 `aes128gcm`, using the
keys above) whose plaintext is `{"type":"message"}` or `{"type":"call"}`. Encryption is
recommended but optional; a plain POST with that JSON body also works. Send it when a user gets a
DM (or a mention) and has no gateway connection open, and drop subscriptions whose endpoint
answers 404 or 410. The server sends `{"type":"call"}` to every phone when a call starts (urgency
high, 45 second TTL), and `{"type":"message"}` only when the person has no gateway connection
open. Push endpoints must be `https://`; set `DENDROP_PUSH_ALLOW_HTTP=true` on the server to
allow a plain-HTTP ntfy server on your home network. On a server without these routes, the setup page says "your server doesn't
send phone notifications yet", and the app retries on its own once it's updated.

## Building the APK

GitHub Actions builds it on every change to this package: open the **Android** workflow run and
download the `dendrop-debug-apk` artifact. To build it yourself you need Node 22, JDK 21 and the
Android SDK (Android Studio installs it):

```sh
cd packages/android
npm ci
npm run apk          # builds www/, syncs Capacitor, runs ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Install it by opening the APK on the phone (allow installing from your browser or Files app
once). `npx cap open android` opens the project in Android Studio.

### Signing and updates

Android only installs an update over an app signed with the same key.

- **Debug builds** (`io.github.spacegoose02.dendrop.debug`, shown as "Dendrop (debug)") are signed
  with `android/app/debug.keystore`, committed on purpose so every debug APK, from any machine or
  CI run, installs over the last one. Anyone with that file can sign a debug build, which is fine
  for a private repo and family sideloading.
- **Release builds** (`io.github.spacegoose02.dendrop`) are signed with your own key. Make one
  once and keep it safe forever (losing it means uninstalling and reinstalling to update):

  ```sh
  keytool -genkeypair -keystore dendrop-release.keystore -alias dendrop -keyalg RSA -keysize 4096 -validity 36500
  ```

  Then add repository secrets `ANDROID_KEYSTORE_BASE64` (`base64 -w0 dendrop-release.keystore`),
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, and the workflow
  also produces `dendrop-release-apk`. Locally, set `DENDROP_KEYSTORE_FILE`,
  `DENDROP_KEYSTORE_PASSWORD`, `DENDROP_KEY_ALIAS` and `DENDROP_KEY_PASSWORD` and run
  `npm run apk:release`.

The two builds have different package names, so they can be installed side by side.

## Layout

```
capacitor.config.json   app id, bundled page, error page
www-src/                the setup page (HTML, CSS, JS), built into www/ by scripts/build-www.mjs
android/                the Android Studio project
  app/src/main/java/io/github/spacegoose02/dendrop/
    MainActivity.java       loads the saved server, keeps sign-in redirects in the app, back button
    ServerSettings.java     the saved server address
    DendropPlugin.java      the setup page's native calls (server check, notifications)
    push/DendropPushService.java  receives UnifiedPush messages
    push/PushRegistrar.java       tells the server where to push
    push/Notifier.java            the content-free notifications and their channels
```

The launcher icon, splash and notification icon are vectors drawn from the raccoon in
`packages/web/public/favicon.svg`; when the theme work replaces that mark, update
`res/drawable/ic_launcher_*.xml` and `ic_stat_dendrop.xml` to match.

## Next: incoming call screen and chat bubbles

Both wait on voice calls and DMs landing in the web client; the groundwork is here.

- **Incoming call screen.** A `{"type":"call"}` push already rings on the **Calls** channel as a
  heads-up notification. With calls built, it becomes a full-screen intent
  (`USE_FULL_SCREEN_INTENT`, `NotificationCompat.CallStyle.forIncomingCall`) that wakes the
  lock screen to a native Answer / Decline screen. Answering opens the app straight into the
  call; the push will also need a call id (still no names or text). The call itself stays WebRTC
  in the WebView, with a `phoneCall`/`microphone` foreground service so it keeps going with the
  screen off.
- **Chat bubbles for DMs.** Bubbles need a conversation shortcut per DM and a notification that
  names the conversation (so bubbles will be an opt-in setting), which a content-free push can't
  do on its own. Plan: on a push, the app
  asks the server (with its session cookie) which DM it was for, then posts a
  `MessagingStyle` notification with a `BubbleMetadata` whose bubble is an activity showing just
  that DM in a WebView. The message text still never travels through the push service. A small
  JS-to-native call from the web client ("open DM as bubble") is the only change `packages/web`
  will need.
