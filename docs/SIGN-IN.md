# Accounts and signing in

There are three ways to sign in: a **username and password**, **TinyAuth** (or any OpenID
Connect provider), and **Google**. Someone can have all three on one account and use any of
them.

## Staying signed in

A sign-in lasts **90 days from the last time it was used**: every day you open Dendrop (in a
browser, the phone apps or the PC app), its end moves forward again, so a device you use stays
signed in for good. One left unused for 90 days signs in again. Signing out, changing your
password, or a parent ending a kid's sign-ins (Family) still signs those devices out at once.

## Making accounts

- **The first account** is made on the sign-in page with a password and becomes the super
  admin. (Or, if password sign-in is off, the first person to sign in through TinyAuth.)
- **Open sign-up:** with it on, the sign-in page has "Make an account" and anyone who can reach
  your server can make a password account.
- **TinyAuth:** with "New accounts from TinyAuth" on, anyone you've added to TinyAuth gets an
  account the first time they sign in.
- **Google:** with "New accounts from Google" on, any Google account gets one the first time it
  signs in. It's off by default, so Google only works for people who've linked it (below).
- **Kids:** see [KIDS.md](KIDS.md). A parent can make a kid account under theirs, or a kid
  with their own account links to a parent with a code.

## Linking sign-ins

In **Settings → Sign-in**, people can link Google and TinyAuth to the account they have, set or
change their password, and unlink a sign-in. Dendrop won't unlink the last way someone can get
in. Changing a password signs out their other devices.

A Google or TinyAuth account can only be linked to one Dendrop account. Google sign-ins are
never matched to accounts by email: they have to be linked first, from inside the account.

Kid accounts under a parent can't change their own sign-in; their parents set the password.

## Two-step sign-in

In **Settings → Sign-in → Two-step sign-in → Set up**, scan the QR code with an authenticator
app (Google Authenticator, Microsoft Authenticator, Aegis, 1Password, Bitwarden and so on) and
type the code it shows. From then on, signing in with a password also asks for a code from the
app. Setting it up signs out your other devices.

You get **ten recovery codes** once, when you turn it on: download or copy them somewhere safe.
Each gets you in once if you lose your phone. **New recovery codes** makes a fresh set (the old
ones stop working); **Turn off** needs a code from the app.

Five wrong codes in a row and you start again from the password. A code works only once.

Two-step sign-in protects the password. TinyAuth and Google have their own (turn it on there),
so signing in through them doesn't ask for a Dendrop code.

## Passkeys

A passkey signs you in with your fingerprint, face, phone, Windows Hello or a security key,
with no password to type or steal. **Settings → Sign-in → Add a passkey**, then **Sign in with
a passkey** on the sign-in page. With two-step sign-in on, a passkey also works instead of the
code.

Passkeys need Dendrop on an `https://` address with a name (like `chat.example.com` or a
Tailscale `*.ts.net` name). Browsers don't allow them on `http://` or on a bare IP address such
as `https://192.168.1.10:8080`. A passkey belongs to the address it was made on: if
`DENDROP_PUBLIC_URL` changes, add them again.

Kid accounts under a parent can't add either; their parent looks after their sign-in.

## The admin's master control

Super admins have a **Sign-in** section in **Instance admin** (Find a server → Instance admin):

| Switch | What it does |
| --- | --- |
| Password sign-in | Usernames and passwords work at all. |
| Open sign-up | "Make an account" on the sign-in page. |
| TinyAuth sign-in | The "Sign in with TinyAuth" button. Needs the `DENDROP_OIDC_*` settings. |
| New accounts from TinyAuth | A first TinyAuth sign-in makes an account. |
| Google sign-in | The "Sign in with Google" button. Needs the `DENDROP_GOOGLE_*` settings. |
| New accounts from Google | A first Google sign-in makes an account. |
| Linking sign-ins | People can link Google or TinyAuth in Settings. |
| Parents can make kid accounts | The "Make a kid account" form for parents. |

The switches start from `DENDROP_LOCAL_LOGIN`, `DENDROP_SIGNUP` and `DENDROP_OIDC_AUTO_CREATE`;
once you change one in the app, the app's setting wins. Dendrop won't let you switch off the
only way *you* can sign in.

Below the switches is every account with how it signs in. You can unlink someone's Google or
TinyAuth (a lost or shared account), set a new password for someone who's locked out, and
**Reset two-step** for someone who lost their phone (it turns off their authenticator app and
removes their passkeys). Each signs them out everywhere, and shows in the instance's
[audit log](AUDIT-LOG.md).

## Setting up Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/), make a project (any name,
   e.g. "Dendrop"), and open **APIs & Services → OAuth consent screen**. Pick **External**,
   fill in the app name and your email, and add yourself as a test user. While the app is in
   "Testing", only test users can sign in, so add your family there too, or **Publish** it.
   Dendrop only asks for the basic `openid`, `email` and `profile` scopes, which don't need
   Google's review.
2. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Pick **Web
   application**, and under **Authorized redirect URIs** add
   `https://<your Dendrop address>/api/auth/google/callback` (the same address as
   `DENDROP_PUBLIC_URL`).
3. Copy the client ID and secret into `DENDROP_GOOGLE_CLIENT_ID` and
   `DENDROP_GOOGLE_CLIENT_SECRET` (on Unraid, the "Google client ID" and "Google client
   secret" fields), and restart the container.
4. "Sign in with Google" now shows on the sign-in page. Everyone links Google once from
   Settings → Sign-in, or you switch on "New accounts from Google".

Google needs Dendrop on a real `https://` address it can send people back to.
