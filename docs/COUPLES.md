# Couples kit

A private corner of a 1:1 chat for two adults: things to do together that aren't ordinary
messages. Open it with the 💞 button in the chat header.

## What's in it

- **Yes / No / Maybe.** Add ideas (anything you like) and each vote on them privately. The other
  person never sees your vote: only ideas you *both* said yes to show up, under "You both said yes".
  If you both said yes or maybe (but not both yes), it shows under "Both curious". A no looks
  exactly like not having voted. "Add some starter ideas" adds a tasteful list to get going.
- **Questions and "would you rather".** Ask a question with 2 to 10 answers. Answers stay hidden
  until you've both answered, then you see each other's, and they can't be changed after that.
  🎲 asks a random built-in "would you rather".
- **Prompts.** Draw a card from a deck: three built-in decks (Getting closer, Flirty, Just for fun)
  plus your own decks and cards. Share a card into the chat if you like.
- **Spinner.** Make lists (Date night, Dinner…) and spin to pick one. Share the result into the chat.
- **View once.** Send a photo the other person can open one time. The server deletes it the
  moment it's opened, and the app shows it without a download button. Nothing can stop a
  screenshot or a second camera, and the app says so.
- **Love notes.** Send one now (it pops up for the other person wherever they are in the app) or
  schedule it up to a year ahead. A scheduled note stays hidden from the other person, and the
  server doesn't tell them it exists, until its time. You can cancel it until then.
- **Countdowns.** Anniversaries, trips, the next date: days to go, with an emoji. ↻ moves a past
  one to the same date next year.

The built-in content is deliberately tame. Anything more explicit is for the two of you to write,
and it's end-to-end encrypted when you do.

## Who can use it

- It's **hidden unless a super admin switches it on** for an account, in Admin → Accounts
  (💞 Couples kit on / off). Super admins always have it. Both people in a chat need it: until
  then there's no 💞 button, and `/api/couples` answers 404 to anyone without it. Switching it off
  for someone deletes every kit they're in. Accounts that were already using a kit when the switch
  was added keep it.
- **Kid accounts never get it.** A super admin can't switch it on for one (403), the switch is
  ignored for kid accounts even if it's set, and linking an account to a parent switches it off.
- Only a **1:1 chat**, only between **two adult accounts**. If either person is a kid account (see
  [KIDS.md](KIDS.md)), or a kid's parents are guardians of the chat, there's no kit: the button
  isn't shown, and every `/api/couples` route answers 404 to a kid account.
- Only once the chat is **end-to-end encrypted** (both of you have set up encryption and a message
  has been sent).
- **Both have to say yes.** One person asks, the other accepts. Either can turn it off at any time
  (Settings tab), which deletes everything in it for both of you, photos included.

## Privacy

- Everything in the kit (idea text, questions, cards, lists, photo details, notes, countdowns) is
  encrypted on your device with the conversation key, like messages. The additional data binds
  each item to the kit, its conversation, its author and its kind
  (`dendrop:couples:<conversation>:<author>:<kind>`), so the server can't turn one into a message
  or into another kind. View-once photos are encrypted like message files, with their own
  additional data, and their real type and size travel inside the encrypted item.
- Kit items live in their own tables (`couples_kits`, `couples_items`, `couples_votes`), never in
  the message history. Nothing a parent can open through a kid's alert (messages, kept deletions)
  can include them.
- **If either person is later linked to a parent**, every kit they're in is deleted straight away,
  in the same request that links them, before any new conversation key is made for the parent.
  Parents never get older key versions anyway (see [ENCRYPTION.md](ENCRYPTION.md)), so they
  couldn't open older kit items even if they were kept.
- What the server can see: that a kit exists in a chat; how many items of each kind there are and
  when they were added; when a scheduled note is due and when a photo was opened; and the votes on
  ideas (yes / no / maybe) and the answer number picked on a question, but never what the idea or
  question says. It needs the votes to work out matches, and only ever sends each person their own
  vote plus the match.
- Push notifications for love notes say only "message", like every other notification.

## API

All under `/api/couples/:conversationId`, for the two people in the chat:

| Method and path | What it does |
| --- | --- |
| `GET /` | Your view of the kit: state (`off`, `invited`, `on`), whether this chat could have one, why not, and its items |
| `POST /invite`, `POST /accept` | Ask, and say yes |
| `DELETE /` | Decline, cancel, or turn off (deletes everything) |
| `POST /items` | `{ kind, body, keyVersion, deliverAt? }`; a photo is multipart with one encrypted file |
| `PATCH /items/:id` | Change a card, spinner list or countdown you added |
| `DELETE /items/:id` | Delete an item (either of you) |
| `PUT /items/:id/vote` | `{ vote }`: `yes` / `no` / `maybe` for ideas, an answer number for questions, `null` to take it back |
| `GET /items/:id/photo` | A view-once photo's encrypted bytes: once, for the person it was sent to |

Changes are pushed as a `couples.updated` gateway event (with `noteFrom` when a love note just
arrived for you); apps fetch their own view again, since each person sees different votes.
