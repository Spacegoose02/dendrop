# Safety: blocking, reports, sign-in limits and your data

## Blocking

Block someone from their profile card (click their name). Your blocked list is in
Settings → Blocked, with Unblock.

- Blocking ends any friendship or friend request between you.
- Neither of you can send a friend request to the other. The blocked person gets the same
  answer as for a username that doesn't exist, so they can't tell they're blocked.
- Your 1:1 DM stays readable, but neither of you can send in it or start a call. A call in
  progress between you ends.
- In group chats and server channels their messages are hidden from you, with a **Show**
  link if you want to see one. Everyone else still sees them.

## Reports

Every message from someone else has a ⚑ **Report** button, and every profile card has
**Report**. You pick a reason and can add details. The person isn't told who reported them.

- **Messages in a server's channels** go to that server's moderators: anyone with the
  **Delete messages** permission sees a **Reports** tab in Server settings. The report keeps a
  copy of the message's text, so deleting the message doesn't lose it. Moderators can delete
  the message from the report and mark it handled.
- **People, and messages in DMs and group chats,** go to super admins, in the Instance admin
  dialog. Encrypted chats can't be read by the server, so a report carries the message's text
  only if the reporter leaves **Share this message's text** on.
- Someone can keep up to 20 reports waiting at once, so one person can't flood moderators.

## Sign-in limits

Ten wrong passwords for one username within 15 minutes lock password sign-in for that
username until the oldest try is 15 minutes old. One address gets 50 wrong passwords in 15
minutes, across all usernames. A right password clears the username's count. The counts are
kept in memory, so restarting the server clears them. Single sign-on isn't affected, and the
authenticator-app step already had its own limit.

## Your data

Settings → Your data → **Download my data** saves one JSON file with your account, friends,
blocks, servers, conversations, the messages you wrote, your files' names and your reactions.
Messages from end-to-end encrypted chats are in the file as the server has them: encrypted.

## Deleting your account

Settings → Your data → **Delete my account**, confirmed with your password (or your username,
for accounts that only use single sign-on). It deletes your messages, files, reactions,
friendships, blocks and sign-ins straight away. Reports you made or that are about you stay,
without your name.

It refuses, and says why, while:
- you own a server: give it to someone else or delete it first;
- you look after kid accounts made under yours;
- you're the only super admin and other people use this Dendrop;
- it's a kid account: those are looked after by a parent.
