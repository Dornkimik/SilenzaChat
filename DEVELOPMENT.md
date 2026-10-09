# SilenzaChat – Developer guide

How to run, configure, deploy and test your own SilenzaChat instance. For what the app does from a visitor's point of view, see [README.md](README.md); for the encryption and threat model, see [SECURITY.md](SECURITY.md).

## Architecture

SilenzaChat is a single Node.js process (`server.mjs`) serving a plain HTML/CSS/JS browser client — no build step, no framework. The only runtime dependency is a pinned, locally served [TweetNaCl](https://github.com/dchest/tweetnacl-js).

- **Browser** generates identity keys (kept in IndexedDB), encrypts private/group messages and attachments, strips media metadata, and verifies identity codes.
- **Server** manages sessions and accounts, relays ciphertext over Server-Sent Events (`/api/events`), keeps recent history in memory, and enforces rate limits, quotas and admin permissions.
- **Disk** holds only small JSON files: accounts, blocks, main rooms, bans, feedback and announcements. Messages, temporary rooms and attachments live in memory and vanish on restart.

### Project layout

| Path | Purpose |
| --- | --- |
| `server.mjs` | HTTP server, sessions, public rooms, admin controls, event stream |
| `lib/accounts.mjs` | Username/password accounts and roles |
| `lib/groups.mjs` | Temporary (user-owned) encrypted rooms |
| `lib/histories.mjs` | Private-chat history and storage budgets |
| `lib/attachments.mjs` | In-memory encrypted attachment storage and quotas |
| `lib/blocks.mjs` | Block lists |
| `lib/announcements.mjs` | Persistent admin announcements |
| `lib/security.mjs` | Rate limits, trusted-proxy handling, client address hashing |
| `lib/antispam.mjs` | Spam scoring for main rooms and the new-visitor trust ladder |
| `public/index.html`, `about.html` | Chat app (`/chat/`) and landing page (`/`) |
| `public/app.js`, `groups.js`, `auth.js`, `feedback.js`, `theme.js` | Browser UI logic |
| `public/crypto.js` | Keys, identity verification, authenticated encryption |
| `public/attachments.js` | Canvas-free metadata removal and format checks |
| `data/*.json` | Persistent state (created at runtime) |
| `test/` | Unit and integration tests (`node --test`) |
| `scripts/` | Playwright browser checks |

## Run locally

Requires **Node.js 22.9+** (24 LTS recommended).

```sh
npm ci
cp .env.example .env   # optional – set ADMIN_USERNAME / ADMIN_PASSWORD here
npm start
```

Open http://localhost:3000. Restart the server after changing `server.mjs`, `lib/` or `.env`; just refresh the page after frontend edits. Pages link their scripts and styles as `/app.js?v=<content hash>`, so browsers and CDNs never mix old and new files and can cache unchanged ones for a year. Open chat tabs notice a newer version after reconnecting or when shown again, and offer a reload. `SilenzaChat.sln` opens the project in Visual Studio (Node.js workload), but `npm start` is the reliable way to run it.

### Admin account

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (15–128 characters) **before the first account is created** and start the server — this creates a persistent admin account. Log in on the landing page, then remove the credentials from the environment; the hash and role are saved. Existing accounts are never promoted by a matching username.

Admins can manage main rooms, bans, feedback and announcements, and moderate temporary rooms. Admin access never decrypts private chats or grants room membership.

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)).

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` when hosting |
| `ORIGIN` | – | Exact public HTTPS origin, no trailing slash. Enables HSTS and origin checks |
| `SECURE_COOKIES` | – | `true` in production |
| `NODE_ENV` | – | `production` makes a valid HTTPS `ORIGIN` mandatory (automatic on Railway) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | – | One-time bootstrap of the admin account |
| `DATA_DIR` | `./data` | Persistent storage directory. On Railway, `RAILWAY_VOLUME_MOUNT_PATH` is used automatically |
| `TRUSTED_PROXY_ADDRESSES` | – | Comma-separated IPs/CIDRs of your actual ingress proxies |
| `TRUSTED_PROXY_PRESET` | – | `cloudflare` adds Cloudflare's published networks |
| `CLIENT_IP_HEADER` | `X-Forwarded-For` | Header a trusted proxy uses for the visitor address, e.g. `X-Real-IP` |
| `LOG_CLIENT_ADDRESS_ONCE` | – | `true` logs one request's addresses to help find your ingress network |
| `ATTACHMENT_MAX_MB` | `16` | Largest encrypted attachment (1–64) |
| `ATTACHMENT_TTL_SECONDS` | `86400` | Attachment lifetime (1–86400) |
| `ATTACHMENT_STORAGE_MB` | `256` | Total attachment memory |
| `NEW_VISITOR_PROBATION_SECONDS` | `180` | How long a new visitor is limited after first opening the chat (0–3600) |

### Persistent data

| File | Contents |
| --- | --- |
| `accounts.json` | Accounts, password hashes, roles, optional profile age/gender |
| `blocks.json` | Account-to-account blocks |
| `rooms.json` | Main/public rooms (three starter rooms are seeded if missing) |
| `bans.json` | Hashed session/account bans |
| `feedback.json` | Feedback inbox (max 1,000 entries, no sender identity) |
| `announcements.json` | Announcement posts |

Back up this directory. Everything else — message history, private chats, temporary rooms, attachments — is in memory only.

## Deploy

You need a host that runs a long-lived Node.js process (static hosting won't work). Run **exactly one process/replica**: sessions and history are held in memory.

1. Set `HOST=0.0.0.0`, `PORT`, `ORIGIN`, `SECURE_COOKIES=true` and the admin bootstrap credentials.
2. Put the `data` directory on persistent storage.
3. Install with `npm ci --omit=dev` and start with `npm start`.
4. Serve over HTTPS (required for private chats) and configure your reverse proxy to:
   - stream `/api/events` without buffering, with a timeout above the 20-second heartbeat;
   - accept request bodies up to `ATTACHMENT_MAX_MB` (uploads must finish within 3 minutes, so allow at least that long);
   - append or sanitize `X-Forwarded-For` (or your `CLIENT_IP_HEADER`) and block direct access to the app.
5. Set `TRUSTED_PROXY_ADDRESSES` to **only** your real ingress networks. Without it, forwarding headers are ignored and every visitor behind the proxy shares one rate-limit bucket. Never trust all addresses.

### Railway

- Attach a **Volume** mounted at `/data` and leave `DATA_DIR` unset. Redeploy after attaching. To keep rooms from an older ephemeral deployment, copy its `rooms.json` into the volume first.
- Set `TRUSTED_PROXY_ADDRESSES=100.64.0.0/10` and `CLIENT_IP_HEADER=X-Real-IP`.
- A valid HTTPS `ORIGIN` is enforced at startup.

### Cloudflare

Behind Cloudflare (not Railway), `TRUSTED_PROXY_PRESET=cloudflare` trusts Cloudflare's edge networks. Cloudflare injects its own `NEL`/`Report-To` headers; disable Network Error Logging in the zone settings if you don't want that telemetry. Make sure the HSTS header is forwarded.

### Search engines

The landing page is `/`, the chat is `/chat/`, and there is a `/sitemap.xml`. Canonical URLs and the sitemap point to `https://silenzachat.cc` — change them in `public/` if you use another domain, then submit the sitemap in Google Search Console.

## Built-in limits

| Area | Limit |
| --- | --- |
| Sessions | 5,000 total (1,000 reserved for accounts); 30 new guests per address and 500 globally per 10 min; 10 sessions per account |
| Passwords | 15–128 characters, no recovery |
| Message history | Latest 100 messages per room, in memory |
| Private chats | 50 conversations per participant; 4 MiB per participant / 32 MiB total; expire after 24 h idle |
| Temporary rooms | 20 members; own 3 / join 20 per visitor; 100 messages, 4 MiB per room / 32 MiB total; deleted after 24 h idle, restart or when empty |
| Attachments | 16 MB each, 256 MB total, 3× max per session/address, 9× per IPv6 /48; expire within 24 h |
| Feedback | Title 120 / message 5,000 chars; 3 per session per 10 min; inbox of 1,000 |
| New visitors | For 3 minutes after first opening the chat (longer on recently flagged networks): no links or contact details in main rooms, and at most 3 new private conversations per 10 min. Ends early when an established person on another network replies to or mentions them. Accounts older than a day skip it. Established visitors may start 20 new private conversations per 10 min |
| Spam in main rooms | Messages are scored for disguised text (look-alike letters, leetspeak, hidden characters, spaced-out letters, symbols glued inside words), links and contact details in disguised forms (including Telegram and TeleGuard handles and IDs, and random-looking codes), links split across messages, offers of explicit content, and near-identical messages from several people. An offer together with a way to reach the seller mutes anyone. Account usernames cannot mention messaging apps. High scores are muted silently: the sender still sees them, nobody else does. Mutes last for the session and flag its network for an hour. Muted senders' new private conversations reach only themselves. Temporary rooms are not scored |

These are basic in-app protections. Larger public deployments still need host-level abuse/DDoS protection and load testing.

## Testing

```sh
npm test                                # unit + integration tests
npx playwright install chromium         # once, for browser checks
npm run test:browser                    # main browser flow
```

Additional browser checks:

| Command | Covers |
| --- | --- |
| `npm run test:groups:browser` | Temporary rooms: access, encryption, ownership, kicks, mobile layout |
| `npm run test:room-controls:browser` | Temporary room controls: settings, invite links, moderators, mute, slow mode, bans, lock |
| `npm run test:slow-network:browser` | Temporary rooms on a slow connection (like Tor): concurrent sends during membership changes, message order, reconnect catch-up |
| `npm run test:private-controls:browser` | Blocking, unblocking, removing chats from the sidebar |
| `npm run test:editing:browser` | Editing messages |
| `npm run test:social:browser` | Profile gender/age, read receipts, drag-and-drop attachments, image viewer, click-to-show images |
| `npm run test:accounts:browser` | Registration, login, account settings |
| `npm run test:announcements:browser` | Announcements |
| `npm run test:feedback:browser` | Feedback submission and admin inbox |
| `npm run test:security:browser` | Tamper rejection, key cleanup, admin boundaries |

Browser checks use temporary data and isolated profiles. To use an existing Chromium, set `CHROMIUM_PATH` (e.g. `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`).
