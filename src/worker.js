// CenTex Homeschool Hub — API for the directory site.
// Static pages are served from /public; everything under /api/ runs here.
//
// Who can do what:
// - Anyone: browse, take the quiz, sign up for the newsletter or alerts, suggest a listing.
// - Group leaders: sign in with a one-time code sent to their email. Once the site owner
//   approves their claim to a listing, they can update it themselves and changes go live.
// - Site owner: /api/admin/* only answers for ADMIN_EMAIL, as verified by Cloudflare Access
//   (the Cf-Access-Authenticated-User-Email header).

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
const bad = (message, status = 400) => json({ error: message }, status);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const AVAIL = new Set(["open", "waitlist", "full", "opens", "unknown"]);
const EVENT_CATS = new Set(["openhouse", "deadline", "public", "other"]);
const now = () => Date.now();
const SESSION_DAYS = 30, CODE_MINUTES = 10, MAX_CODE_ATTEMPTS = 5, MAX_CODES_PER_15_MIN = 3;

async function body(request) {
  try { return await request.json(); } catch { return null; }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sixDigitCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}

function adminEmail(request, env) {
  const who = (request.headers.get("cf-access-authenticated-user-email") || "").toLowerCase();
  const allowed = (env.ADMIN_EMAIL || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return who && allowed.includes(who) ? who : null;
}

function cookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
async function leaderEmail(request, env) {
  const token = cookie(request, "cth_session");
  if (!token) return null;
  const row = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE token_hash=?").bind(await sha256(token)).first();
  return row && row.expires_at > now() ? row.email : null;
}

// Sends through Cloudflare Email Service when the EMAIL binding is configured.
// Returns true if sent, false if email sending isn't set up yet.
async function sendMail(env, to, subject, text) {
  // Local testing only: with EMAIL_DEBUG=1 and no email binding, print the email to the dev console.
  if (env.EMAIL_DEBUG === "1" && !env.EMAIL) { console.log(`[email to ${to}] ${subject}\n${text}`); return true; }
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return false;
  await env.EMAIL.send({
    to,
    from: { email: env.MAIL_FROM || "hello@centexhomeschool.org", name: "CenTex Homeschool Hub" },
    subject,
    text,
  });
  return true;
}

// Emails the site owner (first address in ADMIN_EMAIL). Never throws.
async function notifyOwner(env, subject, text) {
  const to = (env.ADMIN_EMAIL || "").split(",")[0].trim();
  if (!to) return;
  try { await sendMail(env, to, subject, text + `\n\nReview it: ${env.SITE_URL || "https://centexhomeschool.org"}/admin.html`); }
  catch (e) { console.error("owner notice failed", e.code, e.message); }
}

function alertEmail(listing, town, avail, siteUrl) {
  const status = avail.s === "open" ? "has open spots" : `opens registration${avail.when ? " in " + avail.when : " soon"}`;
  return {
    subject: avail.s === "open" ? `Spots just opened at ${listing}` : `${listing} ${status}`,
    body:
      `Hi there,\n\nYou asked us to let you know when ${listing} in ${town} had room. Good news: they just updated their listing, and it now ${status}.\n\n` +
      `Spots at popular groups go quickly, so reach out soon. See their details and how to join: ${siteUrl}\n\n` +
      `CenTex Homeschool Hub\nYou're getting this because you signed up for alerts about ${listing}. Reply "unsubscribe" to stop.`,
  };
}

// Publish a listing change and, if it opens spots or posts a registration date, alert waiting families.
async function publishListing(env, slug, listing, town, fields, updatedBy) {
  const prevRow = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(slug).first();
  const prev = prevRow ? JSON.parse(prevRow.data) : {};
  const merged = { ...prev, ...fields, claimed: true };
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO listing_overrides (slug, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slug) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by"
  ).bind(slug, JSON.stringify(merged), stamp, updatedBy).run();

  const av = fields.avail || {}, was = prev.avail || {};
  let alerted = 0;
  if ((av.s === "open" || av.s === "opens") && (av.s !== was.s || (av.when || "") !== (was.when || ""))) {
    const { results } = await env.DB.prepare("SELECT DISTINCT email FROM alerts WHERE listing_slug=?").bind(slug).all();
    const mail = alertEmail(listing, town, av, env.SITE_URL || "https://centexhomeschool.org");
    for (const r of results) {
      let sent = false;
      try { sent = await sendMail(env, r.email, mail.subject, mail.body); } catch (e) { console.error("alert send failed", e.code, e.message); }
      await env.DB.prepare("INSERT INTO outbox (to_email, listing, kind, subject, body, status, sent_at) VALUES (?,?,?,?,?,?,?)")
        .bind(r.email, listing, av.s === "open" ? "opening" : "registration", mail.subject, mail.body, sent ? "sent" : "queued", sent ? stamp : null).run();
      alerted++;
    }
  }
  return alerted;
}

// Free listings get a 75-character description; Featured listings get up to 2,000.
const DESC_FREE = 75, DESC_FEATURED = 2000;
function cleanFields(f, dMax = DESC_FREE) {
  f = f || {};
  const fields = {};
  for (const [k, n] of [["d", dMax], ["ages", 40], ["sched", 80], ["cost", 80], ["site", 300], ["members", 120]]) { const v = clip(f[k], n); if (v) fields[k] = v; }
  if (fields.site && !/^https?:\/\//i.test(fields.site)) delete fields.site;
  if (typeof f.littles === "boolean") fields.littles = f.littles;
  const a = f.avail || {};
  fields.avail = { s: AVAIL.has(a.s) ? a.s : "unknown", when: clip(a.when, 40) };
  return fields;
}


// ---------- community helpers ----------
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_IN_TEXT_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
function privacyProblem(text) {
  if (PHONE_RE.test(text)) return "Please leave out phone numbers. Families reach each other through the site.";
  if (EMAIL_IN_TEXT_RE.test(text)) return "Please leave out email addresses. Families reach each other through the site.";
  return null;
}
async function profileOf(env, email) {
  return env.DB.prepare("SELECT name, town FROM profiles WHERE email=?").bind(email).first();
}

const routes = {
  // ---------- public ----------
  "GET /api/listings": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT slug, data FROM listing_overrides").all();
    const out = {};
    for (const r of results) { try { out[r.slug] = JSON.parse(r.data); } catch {} }
    const { results: made } = await env.DB.prepare("SELECT slug, data FROM user_listings WHERE status='live' ORDER BY created_at").all();
    const custom = [];
    for (const r of made) { try { custom.push({ ...JSON.parse(r.data), slug: r.slug }); } catch {} }
    return json({ overrides: out, custom });
  },

  "POST /api/submissions": async (req, env) => {
    const b = await body(req); if (!b) return bad("Invalid request.");
    const name = clip(b.name, 140), email = clip(b.email, 160);
    if (!name) return bad("Add the group or business name.");
    if (!EMAIL_RE.test(email)) return bad("Add a valid email address.");
    await env.DB.prepare(
      "INSERT INTO submissions (kind, name, town, website, contact, email, details, availability, registration_opens) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(clip(b.kind, 60), name, clip(b.town, 60), clip(b.website, 300), clip(b.contact, 80), email, clip(b.details, 2000),
      AVAIL.has(b.availability) ? b.availability : "", clip(b.registrationOpens, 40)).run();
    await notifyOwner(env, `New request: ${clip(b.kind, 60) || "Suggestion"} — ${name}`,
      `${clip(b.kind, 60)}\nName: ${name}\nTown: ${clip(b.town, 60)}\nWebsite: ${clip(b.website, 300)}\nFrom: ${clip(b.contact, 80)} <${email}>\n\n${clip(b.details, 2000)}`);
    return json({ ok: true });
  },

  "POST /api/subscribe": async (req, env) => {
    const b = await body(req); if (!b) return bad("Invalid request.");
    const email = clip(b.email, 160).toLowerCase();
    if (!EMAIL_RE.test(email)) return bad("Enter a valid email address.");
    await env.DB.prepare("INSERT INTO subscribers (email, source, answers) VALUES (?,?,?)")
      .bind(email, clip(b.source, 40) || "quiz", JSON.stringify(b.answers || {}).slice(0, 1000)).run();
    return json({ ok: true });
  },

  "POST /api/alerts": async (req, env) => {
    const b = await body(req); if (!b) return bad("Invalid request.");
    const email = clip(b.email, 160).toLowerCase(), slug = clip(b.slug, 120);
    if (!EMAIL_RE.test(email)) return bad("Enter a valid email address.");
    if (!slug) return bad("Missing listing.");
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO alerts (email, listing_slug, listing, town, status_at_signup) VALUES (?,?,?,?,?)")
        .bind(email, slug, clip(b.listing, 140), clip(b.town, 60), clip(b.status, 20)),
      env.DB.prepare("INSERT INTO subscribers (email, source, listing) VALUES (?,?,?)").bind(email, "alert", clip(b.listing, 140)),
    ]);
    return json({ ok: true });
  },

  "POST /api/demand": async (req, env) => {
    const b = await body(req); if (!b) return bad("Invalid request.");
    await env.DB.prepare("INSERT INTO demand (town, age, faith, want, interest, matches, local_matches) VALUES (?,?,?,?,?,?,?)")
      .bind(clip(b.town, 40), clip(b.age, 40), clip(b.faith, 40), clip(b.want, 40), clip(b.interest, 40),
        Number(b.matches) || 0, Number(b.localMatches) || 0).run();
    return json({ ok: true });
  },

  "POST /api/click": async (req, env) => {
    const b = await body(req); if (!b) return json({ ok: true });
    await env.DB.prepare("INSERT INTO clicks (listing_slug, kind) VALUES (?,?)").bind(clip(b.slug, 120), clip(b.kind, 20)).run();
    return json({ ok: true });
  },

  // ---------- group leader sign-in ----------
  "POST /api/auth/request-code": async (req, env) => {
    const b = await body(req); const email = clip(b && b.email, 160).toLowerCase();
    if (!EMAIL_RE.test(email)) return bad("Enter a valid email address.");
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email=? AND created_at>?").bind(email, now() - 15 * 60000).first();
    if (recent.n >= MAX_CODES_PER_15_MIN) return bad("Too many codes requested. Wait 15 minutes and try again.", 429);
    const code = sixDigitCode();
    let sent = false;
    try {
      sent = await sendMail(env, email, `Your CenTex Homeschool Hub sign-in code: ${code}`,
        `Your sign-in code is ${code}\n\nEnter it on the site within ${CODE_MINUTES} minutes to manage your listing.\n\nIf you didn't ask for this, you can ignore this email.\n\nCenTex Homeschool Hub`);
    } catch (e) { console.error("code send failed", e.code, e.message); return bad("We couldn't send the email. Check the address and try again.", 502); }
    if (!sent) return bad("Email sign-in isn't switched on yet. Please check back soon.", 503);
    await env.DB.prepare("INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES (?,?,?,?)")
      .bind(email, await sha256(email + ":" + code), now() + CODE_MINUTES * 60000, now()).run();
    return json({ ok: true });
  },

  "POST /api/auth/verify": async (req, env) => {
    const b = await body(req); const email = clip(b && b.email, 160).toLowerCase(), code = clip(b && b.code, 10).replace(/\D/g, "");
    if (!EMAIL_RE.test(email) || code.length !== 6) return bad("Enter the 6-digit code from your email.");
    const row = await env.DB.prepare("SELECT id, code_hash, expires_at, attempts FROM login_codes WHERE email=? AND used=0 ORDER BY id DESC LIMIT 1").bind(email).first();
    if (!row || row.expires_at < now()) return bad("That code has expired. Request a new one.");
    if (row.attempts >= MAX_CODE_ATTEMPTS) return bad("Too many tries. Request a new code.");
    if (row.code_hash !== (await sha256(email + ":" + code))) {
      await env.DB.prepare("UPDATE login_codes SET attempts=attempts+1 WHERE id=?").bind(row.id).run();
      return bad("That code doesn't match. Check your email and try again.");
    }
    const token = randomToken();
    await env.DB.batch([
      env.DB.prepare("UPDATE login_codes SET used=1 WHERE id=?").bind(row.id),
      env.DB.prepare("INSERT INTO sessions (token_hash, email, expires_at, created_at) VALUES (?,?,?,?)").bind(await sha256(token), email, now() + SESSION_DAYS * 86400000, now()),
    ]);
    return json({ ok: true, email }, 200, { "set-cookie": `cth_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
  },

  "POST /api/auth/logout": async (req, env) => {
    const token = cookie(req, "cth_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": "cth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  },

  // ---------- group leader (signed in) ----------
  "GET /api/leader/me": async (req, env) => {
    const email = await leaderEmail(req, env);
    if (!email) return json({ signedIn: false });
    const { results: owned } = await env.DB.prepare("SELECT slug FROM listing_owners WHERE email=?").bind(email).all();
    const { results: pending } = await env.DB.prepare("SELECT slug, listing FROM claims WHERE email=? AND status='pending'").bind(email).all();
    return json({ signedIn: true, email, owned: owned.map((r) => r.slug), pending });
  },


  "GET /api/leader/events": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const { results } = await env.DB.prepare(
      "SELECT e.id, e.slug, e.title, e.event_date, e.event_time, e.place, e.source FROM events e JOIN listing_owners o ON o.slug=e.slug AND o.email=? WHERE e.status='approved' AND e.event_date >= date('now','-1 day') ORDER BY e.event_date").bind(email).all();
    return json({ events: results });
  },

  "POST /api/leader/event": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req) || {}; const slug = clip(b.slug, 140);
    const owned = await env.DB.prepare("SELECT 1 FROM listing_owners WHERE slug=? AND email=?").bind(slug, email).first();
    if (!owned) return bad("You can only add events for listings you manage.", 403);
    const title = clip(b.title, 100), date = clip(b.date, 10), link = clip(b.link, 300), details = clip(b.details, 500);
    if (!title) return bad("Add a title for the event.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("Pick the event date.");
    if (!EVENT_CATS.has(b.category)) return bad("Pick the type of event.");
    if (b.isPublic !== true) return bad("Only events open to the public can go on the calendar.");
    if (link && !/^https?:\/\//i.test(link)) return bad("The link should start with https://");
    const problem = privacyProblem(details + " " + title); if (problem) return bad(problem);
    await env.DB.prepare("INSERT INTO events (email, name, title, event_date, event_time, town, place, host, link, details, status, slug, source, category) VALUES (?,?,?,?,?,?,?,?,?,?, 'approved', ?, 'leader', ?)")
      .bind(email, clip(b.listing, 140), title, date, clip(b.time, 30), clip(b.town, 40), clip(b.place, 120), clip(b.listing, 140), link, details, slug, b.category).run();
    return json({ ok: true });
  },

  "POST /api/leader/event/remove": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req); const id = Number(b && b.id) || 0;
    const ev = await env.DB.prepare("SELECT e.id FROM events e JOIN listing_owners o ON o.slug=e.slug AND o.email=? WHERE e.id=?").bind(email, id).first();
    if (!ev) return bad("You can only remove your own group's events.", 403);
    await env.DB.prepare("UPDATE events SET status='removed' WHERE id=?").bind(id).run();
    return json({ ok: true });
  },

  "POST /api/leader/claim": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req); const slug = clip(b && b.slug, 120);
    if (!slug) return bad("Pick your listing.");
    if (!clip(b.name, 80)) return bad("Add your name so we can confirm you lead this group.");
    const owned = await env.DB.prepare("SELECT 1 FROM listing_owners WHERE slug=? AND email=?").bind(slug, email).first();
    if (owned) return json({ ok: true, already: true });
    const dup = await env.DB.prepare("SELECT 1 FROM claims WHERE slug=? AND email=? AND status='pending'").bind(slug, email).first();
    if (!dup) {
      await env.DB.prepare("INSERT INTO claims (slug, listing, town, email, name, role, note, type) VALUES (?,?,?,?,?,?,?,?)")
        .bind(slug, clip(b.listing, 140), clip(b.town, 60), email, clip(b.name, 80), clip(b.role, 60), clip(b.note, 500), clip(b.type, 20)).run();
      await notifyOwner(env, `New listing claim: ${clip(b.listing, 140)}`,
        `${clip(b.name, 80)}${clip(b.role, 60) ? " (" + clip(b.role, 60) + ")" : ""} wants to manage ${clip(b.listing, 140)}.\nEmail: ${email}${clip(b.note, 500) ? "\nNote: " + clip(b.note, 500) : ""}`);
    }
    return json({ ok: true });
  },

  "POST /api/leader/update": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req); const slug = clip(b && b.slug, 120);
    const owned = await env.DB.prepare("SELECT 1 FROM listing_owners WHERE slug=? AND email=?").bind(slug, email).first();
    if (!owned) return bad("You can only update listings you've claimed. If you've asked to claim this one, we'll email you once it's approved.", 403);
    const ovRow = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(slug).first();
    const plan = ovRow ? (JSON.parse(ovRow.data).plan || "") : "";
    const dMax = ["featured", "partner", "enhanced"].includes(plan) ? DESC_FEATURED : DESC_FREE;
    const alerted = await publishListing(env, slug, clip(b.listing, 140), clip(b.town, 60), cleanFields(b.fields, dMax), email);
    return json({ ok: true, alerted });
  },


  // ---------- accounts (parents and leaders share one sign-in) ----------
  "GET /api/account/me": async (req, env) => {
    const email = await leaderEmail(req, env);
    if (!email) return json({ signedIn: false });
    return json({ signedIn: true, email, profile: await profileOf(env, email) });
  },

  "POST /api/account/profile": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req); const name = clip(b && b.name, 40);
    if (!name) return bad("Add the name other parents will see, like \"Sarah M.\"");
    await env.DB.prepare("INSERT INTO profiles (email, name, town) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, town=excluded.town")
      .bind(email, name, clip(b.town, 40)).run();
    return json({ ok: true });
  },

  // ---------- "Looking for" board ----------
  "GET /api/board": async (req, env) => {
    const me = await leaderEmail(req, env);
    const { results } = await env.DB.prepare(
      "SELECT id, email, name, town, ages, want, details, created_at FROM board_posts WHERE status='approved' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 100").all();
    let mine = [];
    if (me) ({ results: mine } = await env.DB.prepare("SELECT id, want, details, status, expires_at FROM board_posts WHERE email=? AND status!='removed' ORDER BY id DESC LIMIT 20").bind(me).all());
    return json({ posts: results.map(({ email, ...r }) => ({ ...r, mine: email === me })), mine });
  },

  "POST /api/board": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const prof = await profileOf(env, email); if (!prof) return bad("Add your display name first.");
    const b = await body(req); const details = clip(b && b.details, 400);
    if (details.length < 15) return bad("Tell families a little more about what you're looking for.");
    const problem = privacyProblem(details); if (problem) return bad(problem);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM board_posts WHERE email=? AND status IN ('pending','approved') AND expires_at > datetime('now')").bind(email).first();
    if (open.n >= 3) return bad("You can have up to 3 active posts. Remove one to add another.");
    await env.DB.prepare("INSERT INTO board_posts (email, name, town, ages, want, details, status, expires_at) VALUES (?,?,?,?,?,?, 'approved', datetime('now','+60 days'))")
      .bind(email, prof.name, clip(b.town, 40) || prof.town || "", clip(b.ages, 40), clip(b.want, 60), details).run();
    return json({ ok: true });
  },

  "POST /api/board/remove": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req);
    await env.DB.prepare("UPDATE board_posts SET status='removed' WHERE id=? AND email=?").bind(Number(b && b.id) || 0, email).run();
    return json({ ok: true });
  },

  "POST /api/board/reply": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const prof = await profileOf(env, email); if (!prof) return bad("Add your display name first.");
    const b = await body(req); const message = clip(b && b.message, 800);
    if (message.length < 5) return bad("Write a short message.");
    const post = await env.DB.prepare("SELECT email, details FROM board_posts WHERE id=? AND status='approved'").bind(Number(b.id) || 0).first();
    if (!post) return bad("That post is no longer up.", 404);
    let sent = false;
    try {
      sent = await sendMail(env, post.email, `${prof.name} replied to your post on CenTex Homeschool Hub`,
        `${prof.name}${prof.town ? " (" + prof.town + ")" : ""} replied to your "Looking for" post:\n\n"${message}"\n\nYour post: "${post.details}"\n\nTo write back, email ${email}. They chose to share it by replying.\n\nCenTex Homeschool Hub`);
    } catch (e) { console.error("reply send failed", e.code, e.message); }
    if (!sent) return bad("Replies aren't switched on yet. Please check back soon.", 503);
    return json({ ok: true });
  },

  // ---------- community events ----------
  "GET /api/events": async (req, env) => {
    const { results } = await env.DB.prepare(
      "SELECT id, title, event_date, event_time, town, place, host, link, details, slug, source, confirm, category FROM events WHERE status='approved' AND event_date >= date('now','-45 days') ORDER BY event_date, event_time LIMIT 300").all();
    return json({ events: results });
  },

  "POST /api/events": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const prof = await profileOf(env, email); if (!prof) return bad("Add your display name first.");
    const b = await body(req) || {};
    const title = clip(b.title, 100), date = clip(b.date, 10), details = clip(b.details, 500), link = clip(b.link, 300);
    if (!title) return bad("Add a title for the event.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("Pick the event date.");
    if (!EVENT_CATS.has(b.category)) return bad("Pick the type of event.");
    if (b.isPublic !== true) return bad("Only events open to the public can go on the calendar.");
    if (link && !/^https?:\/\//i.test(link)) return bad("The link should start with https://");
    const problem = privacyProblem(details + " " + title); if (problem) return bad(problem);
    await env.DB.prepare("INSERT INTO events (email, name, title, event_date, event_time, town, place, host, link, details, status, category) VALUES (?,?,?,?,?,?,?,?,?,?,'approved',?)")
      .bind(email, prof.name, title, date, clip(b.time, 30), clip(b.town, 40), clip(b.place, 120), clip(b.host, 100), link, details, b.category).run();
    return json({ ok: true });
  },

  // ---------- questions on listings ----------
  "GET /api/questions": async (req, env) => {
    const { results } = await env.DB.prepare(
      "SELECT id, slug, name, question, answer, answered_at FROM questions WHERE status='answered' ORDER BY answered_at DESC LIMIT 500").all();
    const by = {};
    for (const q of results) (by[q.slug] = by[q.slug] || []).push(q);
    return json({ questions: by });
  },

  "POST /api/questions": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const prof = await profileOf(env, email); if (!prof) return bad("Add your display name first.");
    const b = await body(req); const question = clip(b && b.question, 300), slug = clip(b && b.slug, 120);
    if (!slug) return bad("Missing listing.");
    if (question.length < 8) return bad("Write your question in a sentence or two.");
    const problem = privacyProblem(question); if (problem) return bad(problem);
    await env.DB.prepare("INSERT INTO questions (slug, listing, email, name, question) VALUES (?,?,?,?,?)")
      .bind(slug, clip(b.listing, 140), email, prof.name, question).run();
    const { results: owners } = await env.DB.prepare("SELECT email FROM listing_owners WHERE slug=?").bind(slug).all();
    for (const o of owners) {
      try { await sendMail(env, o.email, `New question about ${clip(b.listing, 140)}`,
        `A family asked:\n\n"${question}"\n\nAnswer it at ${env.SITE_URL || "https://centexhomeschool.org"}/leaders.html. Your answer will show on your listing so other families see it too.\n\nCenTex Homeschool Hub`); } catch (e) {}
    }
    return json({ ok: true, hasLeader: owners.length > 0 });
  },

  "GET /api/leader/questions": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const { results } = await env.DB.prepare(
      "SELECT q.id, q.slug, q.listing, q.name, q.question, q.answer, q.status FROM questions q JOIN listing_owners o ON o.slug=q.slug AND o.email=? WHERE q.status IN ('open','answered') ORDER BY q.status='answered', q.id DESC LIMIT 100").bind(email).all();
    return json({ questions: results });
  },

  "POST /api/leader/answer": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req); const id = Number(b && b.id) || 0, answer = clip(b && b.answer, 800);
    if (answer.length < 2) return bad("Write your answer first.");
    const q = await env.DB.prepare("SELECT q.id, q.email, q.listing FROM questions q JOIN listing_owners o ON o.slug=q.slug AND o.email=? WHERE q.id=?").bind(email, id).first();
    if (!q) return bad("You can only answer questions about listings you manage.", 403);
    await env.DB.prepare("UPDATE questions SET answer=?, answered_by=?, answered_at=datetime('now'), status='answered' WHERE id=?").bind(answer, email, id).run();
    try { await sendMail(env, q.email, `${q.listing} answered your question`,
      `${q.listing} answered your question on CenTex Homeschool Hub:\n\n"${answer}"\n\nSee it on their listing: ${env.SITE_URL || "https://centexhomeschool.org"}\n\nCenTex Homeschool Hub`); } catch (e) {}
    return json({ ok: true });
  },

  // ---------- owner moderation ----------
  "GET /api/admin/moderation": async (req, env) => {
    const [{ results: posts }, { results: evs }, { results: qs }] = await Promise.all([
      env.DB.prepare("SELECT id, name, email, town, ages, want, details, created_at FROM board_posts WHERE status='approved' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 50").all(),
      env.DB.prepare("SELECT id, name, email, title, event_date, event_time, town, place, host, link, details FROM events WHERE status='approved' AND event_date >= date('now','-1 day') ORDER BY event_date LIMIT 50").all(),
      env.DB.prepare("SELECT id, listing, name, question, answer, status FROM questions WHERE status IN ('open','answered') ORDER BY id DESC LIMIT 30").all(),
    ]);
    return json({ posts, events: evs, questions: qs });
  },

  "POST /api/admin/moderate": async (req, env) => {
    const b = await body(req) || {};
    const table = { post: "board_posts", event: "events", question: "questions" }[b.kind];
    const status = { remove: "removed", hide: "hidden" }[b.action];
    if (!table || !status) return bad("Unknown action.");
    await env.DB.prepare(`UPDATE ${table} SET status=? ${table === "questions" ? "" : ", reviewed_at=datetime('now')"} WHERE id=?`).bind(table === "questions" ? "hidden" : "removed", Number(b.id) || 0).run();
    return json({ ok: true });
  },


  // ---------- jobs board ----------
  "GET /api/jobs": async (req, env) => {
    const me = await leaderEmail(req, env);
    const { results } = await env.DB.prepare(
      "SELECT id, email, name, kind, title, org, town, pay, schedule, details, apply_link, created_at FROM jobs WHERE status='live' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 100").all();
    let mine = [];
    if (me) ({ results: mine } = await env.DB.prepare("SELECT id, kind, title, status FROM jobs WHERE email=? AND status='awaiting_payment' ORDER BY id DESC").bind(me).all());
    return json({ jobs: results.map(({ email, ...r }) => ({ ...r, mine: email === me })), awaitingPayment: mine });
  },

  "POST /api/jobs": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const prof = await profileOf(env, email); if (!prof) return bad("Add your display name first.");
    const b = await body(req) || {};
    const kind = b.kind === "hiring" ? "hiring" : "seeking";
    const title = clip(b.title, 100), details = clip(b.details, 800), link = clip(b.link, 300);
    if (!title) return bad(kind === "hiring" ? "Add a job title." : "Add a short headline, like \"Math tutor for a 7th grader\".");
    if (details.length < 20) return bad("Add a few more details.");
    if (link && !/^https?:\/\//i.test(link)) return bad("The link should start with https://");
    const problem = privacyProblem(details + " " + title); if (problem) return bad(problem);
    if (kind === "hiring" && !clip(b.org, 100)) return bad("Add the name of your co-op, school or business.");
    // Featured vendors post jobs free: live right away for 30 days.
    let featured = false;
    if (kind === "hiring") {
      const { results: owned } = await env.DB.prepare("SELECT o.data FROM listing_overrides o JOIN listing_owners w ON w.slug=o.slug WHERE w.email=?").bind(email).all();
      featured = owned.some((r) => { try { return ["featured", "partner", "enhanced"].includes(JSON.parse(r.data).plan); } catch { return false; } });
    }
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE email=? AND status IN ('live','awaiting_payment') AND (expires_at IS NULL OR expires_at > datetime('now'))").bind(email).first();
    if (open.n >= 5) return bad("You have 5 active posts. Remove one to add another.");
    const r = await env.DB.prepare(
      `INSERT INTO jobs (email, name, kind, title, org, town, pay, schedule, details, apply_link, status, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, ${kind === "hiring" && !featured ? "NULL" : kind === "hiring" ? "datetime('now','+30 days')" : "datetime('now','+60 days')"})`
    ).bind(email, prof.name, kind, title, clip(b.org, 100), clip(b.town, 40), clip(b.pay, 60), clip(b.schedule, 80), details, kind === "hiring" ? link : "", kind === "hiring" && !featured ? "awaiting_payment" : "live").run();
    if (featured) return json({ ok: true, id: r.meta.last_row_id, live: true });
    if (kind === "hiring") await notifyOwner(env, `Job post awaiting payment: ${title}`,
      `${clip(b.org, 100)} posted "${title}" (${clip(b.town, 40)}).\nPoster: ${prof.name} <${email}>\nMark it paid on your owner page once the $39 payment comes through.`);
    return json({ ok: true, id: r.meta.last_row_id, needsPayment: kind === "hiring" });
  },

  "POST /api/jobs/remove": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req);
    await env.DB.prepare("UPDATE jobs SET status='removed' WHERE id=? AND email=?").bind(Number(b && b.id) || 0, email).run();
    return json({ ok: true });
  },

  "POST /api/jobs/reply": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const prof = await profileOf(env, email); if (!prof) return bad("Add your display name first.");
    const b = await body(req); const message = clip(b && b.message, 1200);
    if (message.length < 10) return bad("Write a short message.");
    const job = await env.DB.prepare("SELECT email, kind, title FROM jobs WHERE id=? AND status='live'").bind(Number(b.id) || 0).first();
    if (!job) return bad("That post is no longer up.", 404);
    let sent = false;
    try {
      sent = await sendMail(env, job.email, `${prof.name} responded to "${job.title}" on CenTex Homeschool Hub`,
        `${prof.name}${prof.town ? " (" + prof.town + ")" : ""} responded to your post "${job.title}":\n\n"${message}"\n\nTo write back, email ${email}. They chose to share it by responding.\n\nCenTex Homeschool Hub`);
    } catch (e) { console.error("job reply failed", e.code, e.message); }
    if (!sent) return bad("Responses aren't switched on yet. Please check back soon.", 503);
    return json({ ok: true });
  },

  "GET /api/admin/jobs": async (req, env) => {
    const { results } = await env.DB.prepare(
      "SELECT id, email, name, kind, title, org, town, pay, details, apply_link, status, created_at, expires_at FROM jobs WHERE status='awaiting_payment' OR (status='live' AND expires_at > datetime('now')) ORDER BY status, id DESC LIMIT 100").all();
    return json({ jobs: results });
  },

  "POST /api/admin/jobs": async (req, env) => {
    const b = await body(req) || {}; const id = Number(b.id) || 0;
    if (b.action === "activate") {
      await env.DB.prepare("UPDATE jobs SET status='live', expires_at=datetime('now','+30 days') WHERE id=? AND status='awaiting_payment'").bind(id).run();
      const job = await env.DB.prepare("SELECT email, title FROM jobs WHERE id=?").bind(id).first();
      if (job) { try { await sendMail(env, job.email, `Your job post is live: ${job.title}`,
        `Thanks! Your post "${job.title}" is now live on CenTex Homeschool Hub for 30 days.\n\nSee it here: ${env.SITE_URL || "https://centexhomeschool.org"}/#jobs\n\nCenTex Homeschool Hub`); } catch (e) {} }
    } else if (b.action === "remove") {
      await env.DB.prepare("UPDATE jobs SET status='removed' WHERE id=?").bind(id).run();
    } else return bad("Unknown action.");
    return json({ ok: true });
  },


  "POST /api/leader/create-listing": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req) || {};
    const n = clip(b.name, 80), town = clip(b.town, 40), d = clip(b.description, DESC_FREE), subjects = clip(b.subjects, 120);
    if (!n) return bad("Add your name or business name.");
    if (!town) return bad("Add the town you're based in.");
    if (!subjects) return bad("List the subjects you teach.");
    if (d.length < 20) return bad("Add a short description (up to 75 characters).");
    const site = clip(b.site, 300); if (site && !/^https?:\/\//i.test(site)) return bad("The website should start with https://");
    const problem = privacyProblem(d + " " + n); if (problem) return bad(problem);
    const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_listings WHERE email=? AND status='live'").bind(email).first();
    if (mine.n >= 3) return bad("You can create up to 3 listings.");
    const base = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "tutor";
    const slug = base + "-" + randomToken(2);
    const format = ["In person", "Online", "In person or online"].includes(b.format) ? b.format : "";
    const data = { n, town, type: "tutor", tags: subjects.split(/[,;/]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6), days: [],
      ages: clip(b.ages, 40), cost: clip(b.rate, 60), sched: format, d, site };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user_listings (slug, email, data) VALUES (?,?,?)").bind(slug, email, JSON.stringify(data)),
      env.DB.prepare("INSERT OR REPLACE INTO listing_owners (slug, email, name, role, approved_at) VALUES (?,?,?,?,?)").bind(slug, email, n, "tutor", new Date().toISOString()),
      env.DB.prepare("INSERT INTO listing_overrides (slug, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slug) DO NOTHING").bind(slug, JSON.stringify({ claimed: true }), new Date().toISOString(), email),
    ]);
    return json({ ok: true, slug });
  },

  "POST /api/admin/plan": async (req, env) => {
    const b = await body(req) || {}; const slug = clip(b.slug, 140);
    const plan = ["", "featured"].includes(b.plan) ? b.plan : null;
    if (!slug || plan === null) return bad("Pick a listing and plan.");
    const prevRow = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(slug).first();
    const prev = prevRow ? JSON.parse(prevRow.data) : {};
    if (plan) prev.plan = plan; else delete prev.plan;
    await env.DB.prepare("INSERT INTO listing_overrides (slug, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slug) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by")
      .bind(slug, JSON.stringify(prev), new Date().toISOString(), "owner").run();
    return json({ ok: true });
  },

  "GET /api/admin/user-listings": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT slug, email, data, created_at FROM user_listings WHERE status='live' ORDER BY created_at DESC LIMIT 100").all();
    return json({ listings: results.map((r) => ({ ...r, data: JSON.parse(r.data) })) });
  },

  "POST /api/admin/user-listings/remove": async (req, env) => {
    const b = await body(req); const slug = clip(b && b.slug, 140);
    await env.DB.prepare("UPDATE user_listings SET status='removed' WHERE slug=?").bind(slug).run();
    return json({ ok: true });
  },

  // ---------- admin (owner only, via Cloudflare Access) ----------
  "GET /api/admin/me": async (req, env) => json({ admin: !!adminEmail(req, env) }),

  "GET /api/admin/claims": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT * FROM claims WHERE status='pending' ORDER BY id DESC LIMIT 200").all();
    return json({ claims: results });
  },

  "POST /api/admin/claims/approve": async (req, env) => {
    const b = await body(req); const id = Number(b && b.id); if (!id) return bad("Missing id.");
    const c = await env.DB.prepare("SELECT * FROM claims WHERE id=? AND status='pending'").bind(id).first();
    if (!c) return bad("That claim was already handled.", 404);
    const stamp = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO listing_owners (slug, email, name, role, approved_at) VALUES (?,?,?,?,?)").bind(c.slug, c.email, c.name, c.role, stamp),
      env.DB.prepare("UPDATE claims SET status='approved', reviewed_at=? WHERE id=?").bind(stamp, id),
    ]);
    // Mark the listing as claimed so families see it's managed by the group.
    const prevRow = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(c.slug).first();
    const prev = prevRow ? JSON.parse(prevRow.data) : {};
    await env.DB.prepare("INSERT INTO listing_overrides (slug, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slug) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .bind(c.slug, JSON.stringify({ ...prev, claimed: true }), stamp, "owner").run();
    try {
      const paid = ["class", "micro", "tutor"].includes(c.type);
      await sendMail(env, c.email, `You can now manage ${c.listing} on CenTex Homeschool Hub`,
        `Hi ${c.name || "there"},\n\nYour claim for ${c.listing} is approved. Sign in at ${env.SITE_URL || "https://centexhomeschool.org"}/leaders.html with this email address to update your details and availability anytime.\n\n` +
        `A few things that help families find you:\n- Mark your availability (open spots, waitlist or full)\n- Add your next open house or application deadline to the community calendar\n- Answer families' questions on your listing\n\n` +
        `When you mark open spots or post a registration date, families waiting on your group get an email right away.\n\n` +
        (paid ? `P.S. Want families to enroll in one click? A Featured listing ($39/month) adds a highlighted banner, photos, a "Register" button straight to your registration page, an unlimited description (free listings get 75 characters), a quarterly newsletter shout-out, free job posts and a monthly report on how your listing is doing. Details: ${env.SITE_URL || "https://centexhomeschool.org"}/leaders.html#plans\n\n` : "") +
        `Thanks,\nBenjamin\nCenTex Homeschool Hub`);
    } catch (e) { console.error("approval email failed", e.code, e.message); }
    return json({ ok: true });
  },

  "POST /api/admin/claims/reject": async (req, env) => {
    const b = await body(req); const id = Number(b && b.id); if (!id) return bad("Missing id.");
    await env.DB.prepare("UPDATE claims SET status='rejected', reviewed_at=? WHERE id=?").bind(new Date().toISOString(), id).run();
    return json({ ok: true });
  },

  "GET /api/admin/summary": async (req, env) => {
    const one = (sql) => env.DB.prepare(sql).first();
    const [subs, alerts, subm, outbox, quizzes, owners] = await Promise.all([
      one("SELECT COUNT(DISTINCT email) AS n FROM subscribers WHERE unsubscribed_at IS NULL"),
      one("SELECT COUNT(*) AS n FROM alerts"),
      one("SELECT COUNT(*) AS n FROM submissions WHERE status='new'"),
      one("SELECT COUNT(*) AS n FROM outbox WHERE status='queued'"),
      one("SELECT COUNT(*) AS n FROM demand"),
      one("SELECT COUNT(DISTINCT slug) AS n FROM listing_owners"),
    ]);
    const { results: gaps } = await env.DB.prepare(
      "SELECT town, faith, want, COUNT(*) AS n FROM demand WHERE local_matches=0 GROUP BY town, faith, want ORDER BY n DESC LIMIT 10"
    ).all();
    return json({ subscribers: subs.n, alerts: alerts.n, newSubmissions: subm.n, queuedEmails: outbox.n, quizzes: quizzes.n,
      claimedListings: owners.n, emailEnabled: !!(env.EMAIL && env.EMAIL.send), gaps });
  },
};
// Neutral aliases: ad and privacy blockers often block URLs containing "events" or "click".
Object.assign(routes, {
  "GET /api/cal": routes["GET /api/events"],
  "POST /api/cal": routes["POST /api/events"],
  "GET /api/leader/cal": routes["GET /api/leader/events"],
  "POST /api/leader/cal-add": routes["POST /api/leader/event"],
  "POST /api/leader/cal-remove": routes["POST /api/leader/event/remove"],
  "POST /api/visit": routes["POST /api/click"],
});

// Daily summary for the owner (runs on the cron in wrangler.jsonc). Skipped when nothing is new.
async function dailyDigest(env) {
  const since = "datetime('now','-1 day')";
  const q = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [posts, events, tutors, questions, subs, alerts] = await Promise.all([
    q(`SELECT name, town, want, details FROM board_posts WHERE created_at > ${since} AND status='approved'`),
    q(`SELECT title, event_date, host, name FROM events WHERE created_at > ${since} AND status='approved' AND source!='imported'`),
    q(`SELECT data FROM user_listings WHERE created_at > ${since} AND status='live'`),
    q(`SELECT listing, name, question FROM questions WHERE created_at > ${since}`),
    q(`SELECT COUNT(DISTINCT email) AS n FROM subscribers WHERE created_at > ${since}`),
    q(`SELECT COUNT(*) AS n FROM alerts WHERE created_at > ${since}`),
  ]);
  const lines = [];
  if (posts.length) lines.push(`"Looking for" posts (${posts.length}):\n` + posts.map((p) => `- ${p.name}, ${p.town || "no town"}: ${p.want} — ${p.details}`).join("\n"));
  if (events.length) lines.push(`Events (${events.length}):\n` + events.map((e) => `- ${e.event_date}: ${e.title}${e.host ? " (" + e.host + ")" : ""} posted by ${e.name}`).join("\n"));
  if (tutors.length) lines.push(`Tutor listings (${tutors.length}):\n` + tutors.map((t) => { const d = JSON.parse(t.data); return `- ${d.n}, ${d.town}: ${(d.tags || []).join(", ")}`; }).join("\n"));
  if (questions.length) lines.push(`Questions on listings (${questions.length}):\n` + questions.map((x) => `- ${x.listing}: "${x.question}" (${x.name})`).join("\n"));
  if (subs[0].n) lines.push(`New newsletter sign-ups: ${subs[0].n}`);
  if (alerts[0].n) lines.push(`New opening-alert sign-ups: ${alerts[0].n}`);
  if (!lines.length) return;
  await notifyOwner(env, "Your CenTex Homeschool Hub daily summary", "Here's what's new in the last 24 hours.\n\n" + lines.join("\n\n") + "\n\nRemove anything that breaks the rules from your owner page.");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyDigest(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) return bad("Not found.", 404);
    if (url.pathname.startsWith("/api/admin/") && url.pathname !== "/api/admin/me" && !adminEmail(request, env)) {
      return bad("Sign in as the site owner to use this.", 403);
    }
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      if (origin && new URL(origin).host !== url.host) return bad("Request blocked.", 403);
    }
    try { return await handler(request, env); }
    catch (err) { console.error(err); return bad("Something went wrong on our side. Please try again.", 500); }
  },
};
