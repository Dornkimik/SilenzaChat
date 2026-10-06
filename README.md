# SilenzaChat

Anonymous chat with public rooms and end-to-end encrypted private conversations. No email, no real name, no install. → **https://silenzachat.cc**

## Features

- **Join instantly** – chat as a random guest alias, or create a username/password account (no email needed).
- **Public rooms** – open conversations anyone on the site can read.
- **Encrypted private chats** – messages and attachments are encrypted in your browser; the server only relays ciphertext.
- **Temporary group rooms** – create your own encrypted room (up to 20 people), discoverable or hidden. Nobody joins uninvited: people ask to join a discoverable room and the owner or a moderator approves them, while invited people and anyone with an active invite link join directly. Owners can share expiring invite links, appoint moderators, mute, kick or ban members, turn on slow mode or staff-only posting, lock the room, choose how long the room and its messages last, and let new members read messages sent while history sharing is on (verified by each author's signature).
- **Attachments** – photos, GIFs, videos, audio and files. Hidden metadata such as GPS location is stripped from media before it is encrypted and uploaded.
- **Edit, delete and reply** – edit or delete your own messages for everyone.
- **Read receipts** – ✓ when a private message is sent, ✓✓ once it was seen. You can stop sending your own receipts.
- **Optional profile** – show your age and gender next to your name, or leave them empty.
- **Images your way** – drag files onto the chat to attach them, click an image to view it larger, or keep images hidden until you click them.
- **Identity verification** – compare a safety code with your chat partner to confirm you are talking to the right key.
- **Blocking** – block someone to stop private messages in both directions.
- **Announcements & feedback** – read community updates from the admins and send anonymous feedback.
- **Works on phones** – responsive layout, light/dark theme and optional notification sounds.

## Good to know

- **Nothing is permanent.** Chat history lives in server memory, keeps only recent messages and disappears on restart or after 24 hours of inactivity. Attachments expire within 24 hours.
- **Public rooms are not encrypted.** Only private chats and temporary rooms are end-to-end encrypted.
- **Anonymous isn't untraceable.** The server can still see IP addresses, who talks to whom and when, and what you write may identify you.
- **Encryption has limits.** It can't protect a compromised device or a tampered website, there is no forward secrecy, and the code has not been independently audited. Don't share anything whose exposure could put you at risk.

More detail: [SECURITY.md](SECURITY.md).

## Run it yourself

See **[DEVELOPMENT.md](DEVELOPMENT.md)** for setup, configuration, deployment and testing.
