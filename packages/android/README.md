# @dendrop/android

Dendrop for Android: a [Capacitor](https://capacitorjs.com) app that opens the Dendrop web client
from your own server, plus the native bits a phone needs: notifications, the incoming call screen and chat bubbles
(see [POP-OUT-AND-AUDIO.md](../../docs/POP-OUT-AND-AUDIO.md)).

## How it works

- **The chat is the web client your server already serves.** The app saves your server's address
  and loads it in its WebView, with Capacitor's native bridge added. Nothing in `packages/web` is
  forked or changed, the app always matches your server's version (update the server and the
  phone gets the new client on its next launch), and signing in uses the same session cookie a
  browser would, so the gateway's origin check passes unchanged.
- **A small setup page is built into the APK** (`www-src/`, built into `www/`). It shows on first
  launch, when the server can't be reached, and from the launcher shortcut (long-press the icon,
  then **Server settings**). It picks the server and turns notifications on or off. It's styled
  with the `--dd-*` tokens from `packages/theme`, which are inlined at build time. The
  [iPhone app](../ios/README.md) builds the same page, so keep `setup.js` working for both.
- **Single sign-on stays in the app.** Redirects to your identity provider and back load in the
  WebView instead of the browser, so the app is the one that ends up signed in. Links people tap
  in chat still open in the browser.
- **Plain `http://` addresses are allowed** for servers on a home network (for example
  `http://192.168.1.20:8080`). Prefer HTTPS when the server is reachable from outside.
- **Back** goes back inside the app, and on the first screen sends the app to the background
  instead of closing it.

- **New app versions.** When the app comes to the front it looks at the latest
  [GitHub release](https://github.com/Spacegoose02/dendrop/releases/latest) (at most twice a day)
  and, if it's newer, offers to download the APK of the same kind (debug or release). Android asks
  before installing it. *Not now* waits a day; *Skip this version* waits for the next one. The
  release workflow sets the app's version from the tag (`DENDROP_VERSION`), so each release
  installs over the last; local builds stay `0.1.0`.

## Notifications, privately

Pushes go through [UnifiedPush](https://unifiedpush.org), not Google's Firebase. You install a
distributor app, normally [ntfy](https://ntfy.sh) (F-Droid or Play Store), which can use the
public ntfy.sh server or your own ntfy container next to Dendrop on Unraid.

**A push never carries what was said.** The server sends only a wake-up, at most
`{"type":"message"}`, `{"type":"mention"}` or `{"type":"call"}`, and the app shows "Dendrop: You
have a new message", "Someone mentioned you" or "Incoming call". No text, no sender name, no conversation. Pushes are also encrypted with Web Push
keys (RFC 8291) when the server supports it, so ntfy only ever sees ciphertext anyway. The message
notification is skipped while the app is open, and cleared when it's opened.

Channels: **Messages**, **Calls** (rings like a phone call and opens the full-screen call screen) and
**Chat bubbles** (only chats you popped out yourself), all changeable in Android's settings for the app.

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
high, 45 second TTL), and `{"type":"message"}` (or `"mention"`) only when none of the person's apps is in front of
them: no gateway connection open, or every one says `{"type":"active","active":false}`. Push endpoints must be `https://`; set `DENDROP_PUSH_ALLOW_HTTP=true` on the server to
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

## Incoming call screen and chat bubbles

Details for users are in [POP-OUT-AND-AUDIO.md](../../docs/POP-OUT-AND-AUDIO.md).

- **Incoming call screen.** A `{"type":"call"}` push posts an insistent notification on the
  `calls_ringing` channel (ringtone, vibration) with a full-screen intent
  (`USE_FULL_SCREEN_INTENT`) to `MainActivity` (action `…CALL`). That activity shows over the lock
  screen and turns the screen on while it's in front, and the web client's own ringer does
  Answer / Decline. **Silence** (`push/CallActionReceiver`) only stops this phone. The push still
  carries no call id, names or text.
  Still to come: a native Answer / Decline screen (`CallStyle.forIncomingCall`), which needs the
  call id in the push, and a `phoneCall` foreground service so a call keeps going with the screen
  off.
- **Chat bubbles.** The web client calls the plugin's `bubble({ conversationId, title })` when
  someone pops a DM or group out. That pushes a long-lived conversation shortcut and a
  `MessagingStyle` notification on the `bubbles` channel with `BubbleMetadata`, whose bubble is
  `BubbleActivity`: a WebView on `<server>/?popout=c<id>`, sharing the app's cookies. Names
  come from the page, never from a push, so bubbles don't appear for new messages by themselves.
