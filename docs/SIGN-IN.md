# Accounts and signing in

There are three ways to sign in: a **username and password**, **TinyAuth** (or any OpenID
Connect provider), and **Google**. Someone can have all three on one account and use any of
them.

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
TinyAuth (a lost or shared account) and set a new password for someone who's locked out, which
signs them out everywhere.

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
