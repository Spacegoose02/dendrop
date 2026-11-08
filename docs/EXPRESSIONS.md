# Emoji, stickers, reactions and GIFs

The fun stuff, Discord style: each server can have its own emoji and stickers, anyone can react
to a message, and GIF search can be turned on for the whole Dendrop.

## Custom emoji

- **Who adds them:** the owner, admins, and anyone with a custom role that has **Manage emoji &
  stickers** (Server settings → Roles). They upload, rename and delete them in Server settings →
  **Emoji**. Everyone in the server can see that tab.
- **Pictures:** PNG, GIF, WebP or JPEG, up to 256 KB. GIFs with more than one frame, animated
  PNGs and animated WebPs count as animated. A server can have 50 still and 50 animated emoji.
  The picture's type comes from its bytes, never from what the upload says, so an SVG (which
  could run script) can't sneak in.
- **Names:** 2 to 32 letters, numbers or `_`, unique in the server (any case). Names go through
  the built-in word filter, since kids see them too.
- **Using them:** pick one from the 🙂 picker (your current server's emoji come first), or type
  `:name:`. Typing `:rac` suggests matching emoji; Tab or Enter picks one. Everyone in a server
  can use its emoji anywhere: in other servers, DMs and group chats.
- **In messages** a custom emoji is a token, `<:name:id>` (`<a:name:id>` when animated), which
  works inside end-to-end encrypted messages too. Clients draw it from `/api/emojis/:id`, which
  anyone signed in can load. A deleted emoji shows as `:name:`.
- A message that's only emoji (up to 27) shows them big.

## Stickers

Bigger pictures (up to 512 KB; PNG, GIF or WebP, ideally 320×320 and see-through), added in
Server settings → **Stickers** by the same people as emoji, up to 30 per server, each with an
optional description and an emoji that goes with it. They're sent from the **Stickers** tab of
the 🙂 picker as a message of their own: its whole text is `<sticker:name:id>`, so stickers work
in encrypted chats too.

## Reactions

Hover a message (or tap it on a phone) and pick ☺+, or click a reaction that's already there to
add yours; click it again to take it back. Custom emoji work as reactions for people in the
emoji's server. A message can have up to 20 different reactions. Reactions go away when the
message is deleted.

- People timed out in a server can't react there, and kids can't react outside their chat time.
- Reactions are stored on the server in the clear, even in end-to-end encrypted chats (like
  read receipts): the server can see who reacted with which emoji, never what the message said.

API: `PUT /api/messages/:id/reactions/:emoji` adds one, `DELETE` takes it back, where `:emoji` is
the URL-encoded emoji (`%F0%9F%91%8D`) or custom emoji token. Both answer with the message's
reactions, and everyone in the chat gets a `message.reactions` event.

## GIFs

GIF search uses [GIPHY](https://developers.giphy.com), an outside service, so it's **off until a
super admin turns it on**: Instance admin → **GIFs**, paste a GIPHY API key (free from
developers.giphy.com), pick the strongest rating anyone gets (G, PG, PG-13 or R; PG to start),
and Turn GIFs on.

- **Private by design:** searches go through Dendrop, and so do the GIFs themselves (cached in
  `/data/gif-cache` for 30 days after they were last looked at). People's phones and PCs never
  talk to GIPHY, so GIPHY doesn't see who searched or looked.
- **Sending:** the **GIF** button (or the GIFs tab of the 🙂 picker) searches, or shows what's
  trending. Picking one sends a message with the GIF's link, which shows as the GIF.
- **Ratings:** search results above the server's rating are dropped, and so is showing a GIF
  someone sent that's rated higher than you may see.
- **Automod:** while GIFs are on, GIF links pass the link rule.
- **Kids:** off until a parent turns on **GIFs** in the family dashboard. Even then they only get
  GIFs rated G, both in search and when a friend sends one, and a search with a word their
  family filter blocks finds nothing. While GIFs are off for them, GIF links show as plain links.
