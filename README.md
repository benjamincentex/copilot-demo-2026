# CenTex Homeschool Hub

Central Texas homeschool directory at **centexhomeschool.org**. Runs on Cloudflare Workers with a D1 database.

## What's in here

| Path | What it is |
| --- | --- |
| `public/index.html` | The whole website: directory, quiz, alerts, leader updates, owner tools |
| `src/worker.js` | The server: saves forms, alerts and leader updates; owner-only review tools |
| `schema.sql` | Database tables (already created in the `centexhomeschool` D1 database) |
| `wrangler.jsonc` | Cloudflare settings: Worker name, database link, site address, owner email |

## How the alert loop works

1. A parent taps **Notify me when spots open** on a listing. Their email is saved as an alert (and a newsletter subscriber).
2. A group leader submits an update in **For group leaders** (availability, registration date, details).
3. The owner approves it in the **Review listing updates** panel (only visible to the owner).
4. If the update opens spots or posts a registration date, an alert email is queued for every parent waiting on that group.
5. Queued emails go out once email sending is connected (next phase).

## Owner tools

The review panel and unmet-demand panel only appear for the email set in `ADMIN_EMAIL`, and only when you sign in through Cloudflare Access. Set `ADMIN_EMAIL` to your own email in `wrangler.jsonc` or in the Cloudflare dashboard under the Worker's variables.

## Deploying

Cloudflare deploys automatically every time code is pushed to the `main` branch of this repository (Workers Builds). The Worker name in Cloudflare must be `centexhomeschool`, matching `wrangler.jsonc`.

## Private launch

- Every page carries `noindex`, and `robots.txt` blocks search engines.
- Cloudflare Access protects the site so only approved emails can view it.
- To go public: remove the Access application, delete the `robots` meta line in `public/index.html`, and change `robots.txt` to allow crawling.

## Still to do before public launch

- Connect email sending (queued alerts, leader verification codes, the Friday newsletter).
- Verify group leaders by a code sent to the group's own contact email.
- Add spam protection (Cloudflare Turnstile) to the public forms.
- Add a privacy policy page.
