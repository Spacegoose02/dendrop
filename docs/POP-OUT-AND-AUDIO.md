# Pop-out chats, Android bubbles and call screen, ducking and quality of service

## Pop-out chats (PC app and browsers)

The ⧉ button in a chat's header opens that DM, group or channel in a small window of its own.
You can keep it beside a game or on another screen while the main window does something else.

- The window loads the app at `/?popout=c<conversationId>` or `/?popout=s<serverId>.<channelId>`
  and shows just that chat, titled after it ("bob · Dendrop"). Popping out the same chat again
  brings its window to the front.
- The main window keeps ringing for calls and asking to set up encryption. A pop-out only asks
  to unlock encryption, when it needs that to read the chat.
- In the PC app, only those exact addresses on your own server open an app window. Every other
  link still opens in your browser, from the pop-out too.
- Threads aren't popped out on their own. Pop out their channel.
- The chat page comes from your server, but the PC app is installed on each PC. A PC app from
  before pop-outs (0.7.0 and older) sends every new window to the system browser, so a newer
  server's pop-out would open there. The page checks for that and asks you to update the PC app
  instead. In a browser, if pop-ups are blocked, it says so.

## Android chat bubbles

In the Android app, the same ⧉ button on a DM or group opens it in an Android **bubble**, the
floating chat head that stays over other apps (Android 11 and newer).

- The bubble loads the pop-out view of that chat from your server, signed in like the app.
- Its name comes from the app itself when you pop the chat out. Pushes still never carry names or
  text, so bubbles don't pop up by themselves for new messages.
- If bubbles are off for Dendrop, the app tells you where to turn them on (Android settings, the
  app, Notifications, Bubbles).

## Android incoming call screen

A call rings like a phone call: the **Calls** notification plays your ringtone and vibrates
until you answer, decline, or 45 seconds pass. It has **Answer** and **Decline** buttons, on the
lock screen too, and on a locked or idle phone it opens Dendrop full screen over the lock screen,
where the app's own ringer lets you answer or decline as well.

- **Answer** opens Dendrop over the lock screen (no unlocking first) and joins the call, with
  your camera off. Turn it on in the call if you want video.
- **Decline** tells the server without opening the app, so the caller sees you declined. The
  call goes on for anyone else invited.
- The push itself still never says who is calling (it's content-free). When it arrives, the
  app asks your own server, with your sign-in, which call it is and puts the caller's name on
  the notification ("Sam", or "Sam in Book club"). If the server can't be reached it still rings,
  as "Someone".
- The phone stops ringing by itself when the caller hangs up or you answer on another device
  (the app checks every few seconds while it rings).
- Android 14 and newer can turn off full-screen alerts per app. Then the call shows as a
  heads-up notification instead (Android settings, the app, "Full screen notifications"). Answer
  and Decline still work.

### Calls with the screen off

While you're in a call, Dendrop shows a quiet **Call in progress** notification (with **Hang
up**). It keeps the call going when the screen turns off or you switch to another app: Android
lets an app with that notification keep using the microphone, and the app keeps the phone and
Wi-Fi awake for the call. It goes away when the call ends. Swiping Dendrop away from recent
apps ends it too.

The app now asks for the microphone (and the camera, for video) the first time you join a call.
Earlier versions of the Android app didn't declare these permissions, so calls there had no
microphone.
## Ducking

Voice settings, **Ducking**: watch-together videos play quieter while people talk, then go back
to their volume.

- **When others speak** (on by default) and **When I speak** (off by default).
- **Volume while ducked**: 35% of the usual volume by default.
- It covers watch-together videos (uploaded and YouTube). It doesn't turn down other apps on your
  computer.

## Quality of service

Voice settings, Advanced, **Put voice first on the network** (on by default) marks your voice
packets as urgent (DSCP), so routers and systems that honor it send voice ahead of downloads. It
never hurts where they don't. Turn it off if your network misbehaves with it.
