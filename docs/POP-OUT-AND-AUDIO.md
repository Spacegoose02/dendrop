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

## Android chat bubbles

In the Android app, the same ⧉ button on a DM or group opens it in an Android **bubble**, the
floating chat head that stays over other apps (Android 11 and newer).

- The bubble loads the pop-out view of that chat from your server, signed in like the app.
- Its name comes from the app itself when you pop the chat out. Pushes still never carry names or
  text, so bubbles don't pop up by themselves for new messages.
- If bubbles are off for Dendrop, the app tells you where to turn them on (Android settings, the
  app, Notifications, Bubbles).

## Android incoming call screen

A call now rings like a phone call: the **Calls** notification plays your ringtone and vibrates
until you open it, silence it, or 45 seconds pass. On a locked or idle phone it opens Dendrop
full screen over the lock screen, where the app's own ringer lets you answer or decline.

- It still never says who is calling, because pushes are content-free.
- **Silence** stops this phone ringing. The call goes on for the caller and anyone else invited.
- Android 14 and newer can turn off full-screen alerts per app. Then the call shows as a
  heads-up notification instead (Android settings, the app, "Full screen notifications").
- The old **Calls** notification channel is replaced by a new one that rings. If you'd changed its
  settings, set them again.

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
