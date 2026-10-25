# CenTex Homeschool Hub — monthly newsletter framework

One issue a month, sent at the start of the month after Benjamin approves the draft on the owner page (/admin.html#newsletter).
Draft is written by the 25th of the prior month. Reading time: about 4 minutes.

## Sections, in this order

1. **Header + one-line intro** — month, a sentence on what's inside.
2. **Coming up** — 3–6 public events and deadlines for the month ahead, pulled from the site calendar
   (`events` table, approved, next ~45 days): date, title, place/town, link. Close with a link to /calendar.
3. **Law & policy watch** — what changed or is coming in Texas homeschool law, TEFA, UIL access, college
   admissions or local district policy. Plain language, neutral tone, dates and a source link for each item.
   If nothing changed, say so in one line and link /resources#law. Never give legal advice.
4. **Tip of the month** — one practical best practice (record keeping, routines, curriculum choices,
   teaching multiple ages, using the library, field trips, high school transcripts). 3–5 short steps.
5. **Tackling a challenge** — one common struggle (burnout, the mid-year slump, socialization worries,
   a reluctant learner, working parents, special needs, skeptical relatives) with honest, practical ideas
   and where to find support locally.
6. **Seasonal corner** — something tied to the time of year: holidays (Thanksgiving, Christmas, spring
   break), back-to-school and planning the new year (Jul–Aug), spring registration season (Jan–Mar),
   end-of-year wrap-up and portfolios (May), summer break ideas and camps (Jun), Texas history and
   independence (Mar), testing/evaluation season if families choose it. Ideas families can use that month.
7. **Featured spotlight** (only when one is waiting) — Featured listings get a spotlight twice a year with their
   own photo and words. Check D1: `SELECT id, listing, text FROM spotlights WHERE status='pending' ORDER BY id`.
   Use their text lightly edited for length (keep their meaning), with the photo from
   `https://centexhomeschool.org/api/photo/spotlight/<id>` (img width 100%, max 552px, alt = listing name). Mark it used
   after the draft is saved: `UPDATE spotlights SET status='used', used_at=datetime('now') WHERE id=<id>`. Up to 2 per issue.
8. **Groups to know** — 2–3 listings from the directory, rotating towns (always include north: Liberty Hill,
   Leander, Cedar Park, Georgetown). One line each, from the listing. Link /directory.
9. **Share with a friend** — a short dashed box: "Know a family thinking about homeschooling? Forward this email,
   or send them your personal link" with `{{referral_url}}` as the link (filled in per subscriber; signups through it
   are credited to them).
10. **For schools & teachers** — a short note inviting groups to claim their free listing (/leaders.html).
11. **Sign-off** — Benjamin, plus "hit reply and tell me about a group we're missing."

## Rules
- Original writing only; no copied paragraphs. Facts and dates must come from a source checked that month.
- No prices for paid plans (paid plans are off for launch).
- Keep `{{referral_url}}` in the share box and `{{unsubscribe_url}}` and `{{mailing_address}}` in the footer; the site fills them in per subscriber.
- Use the HTML layout in `2026-11.html` (inline styles, 600px table) as the template.
