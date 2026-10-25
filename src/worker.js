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
async function sendMail(env, to, subject, text, html) {
  // Local testing only: with EMAIL_DEBUG=1 and no email binding, print the email to the dev console.
  if (env.EMAIL_DEBUG === "1" && !env.EMAIL) { console.log(`[email to ${to}] ${subject}\n${text}`); return true; }
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return false;
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.MAIL_FROM || "hello@centexhomeschool.org", name: "CenTex Homeschool Hub" },
      subject,
      text,
      ...(html ? { html } : {}),
    });
    return true;
  } catch (e) {
    // Usually means the domain isn't onboarded to Cloudflare Email Sending yet.
    console.error("Email send failed:", e && e.message);
    return false;
  }
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

// Paid plans (Featured listing, paid job posts) are off until PAID_PLANS is set to "1" on the Worker.
const paidOn = (env) => env.PAID_PLANS === "1";

// Free listings get a 75-character description; Featured listings get up to 2,000.
const DESC_FREE = 75, DESC_FEATURED = 2000;
const SPOTLIGHT_MONTHS = 6; // Featured perk: a newsletter spotlight twice a year
const FREE_EVENT_LIMIT = 2; // upcoming calendar events per free listing (Featured: unlimited)
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


// ---------- moderation: every post is screened when it's submitted ----------
// hold = hidden until the owner approves it; flag = goes live, owner reviews it.
const MOD_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const STRONG_PROFANITY_RE = /\b(f+u+c+k\w*|sh[i1]t\w*|b[i1]tch\w*|a+ss+hole\w*|bastard\w*|c+u+n+t\w*|d[i1]ck(head)?s?|piss(ed)?\b|slut\w*|wh[o0]re\w*|retard\w*|motherf\w*)/i;
const ADDRESS_RE = /\b\d{2,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Dr|Drive|Ave|Avenue|Rd|Road|Ln|Lane|Blvd|Ct|Court|Way|Cv|Cove|Trl|Trail|Pkwy|Cir|Circle)\b/;
const CHILD_NAME_RE = /\b(?:[Mm]y|[Oo]ur)\s+(?:\d+[- ]year[- ]old\s+)?(?:son|daughter|kid|child|boy|girl|kiddo|twins?)\s*,?\s+(?:is\s+)?(?:named\s+|called\s+)?[A-Z][a-z]{2,}/;
const SOCIAL_RE = /(instagram\.com|tiktok\.com|snapchat|@[a-z0-9_.]{3,}\b)/i;
const MOD_PROMPT = `You review posts on a community website for Central Texas homeschool families (parents, schools, tutors). Classify the user's post. Answer only with JSON.
Set each field to true only if it clearly applies:
- child_sensitive: details that could identify or locate a specific child: a child's full name; a first name together with age, school, town, schedule or photo; where a child will be and when; home address; a child's social media; a child's medical, behavioral or custody details tied to an identifiable child. General ages ("kids 7 and 10") or a first name alone is NOT child_sensitive.
- inappropriate: profanity, sexual content, slurs, or content unsuitable for a family site.
- hostility: insults, threats, harassment, or attacks on a person, family, school or group.
- drama: gossip, accusations, public complaints or call-outs about a named person or group, or an argumentative tone likely to start conflict.
- spam: unrelated advertising, scams, or links to unrelated products.
Also give "reason": one short sentence explaining any true field, or "" if none.`;
const MOD_SCHEMA = { type: "object", properties: { child_sensitive: { type: "boolean" }, inappropriate: { type: "boolean" }, hostility: { type: "boolean" }, drama: { type: "boolean" }, spam: { type: "boolean" }, reason: { type: "string" } }, required: ["child_sensitive", "inappropriate", "hostility", "drama", "spam", "reason"] };
const MOD_LABELS = { child_sensitive: "Child-sensitive information", inappropriate: "Inappropriate language", hostility: "Hostility", drama: "Drama", spam: "Spam", unscreened: "Couldn't be screened automatically" };

async function screenText(env, text) {
  const cats = new Set(), reasons = [];
  if (STRONG_PROFANITY_RE.test(text)) { cats.add("inappropriate"); reasons.push("Contains profanity."); }
  if (ADDRESS_RE.test(text)) { cats.add("child_sensitive"); reasons.push("Looks like it includes a street address."); }
  if (CHILD_NAME_RE.test(text)) { cats.add("child_sensitive"); reasons.push("Names a child."); }
  if (SOCIAL_RE.test(text)) { cats.add("child_sensitive"); reasons.push("Includes a social media handle or link."); }
  let aiOk = false;
  if (env.AI && typeof env.AI.run === "function") {
    try {
      const out = await env.AI.run(MOD_MODEL, {
        messages: [{ role: "system", content: MOD_PROMPT }, { role: "user", content: String(text).slice(0, 3000) }],
        response_format: { type: "json_schema", json_schema: MOD_SCHEMA }, max_tokens: 200, temperature: 0,
      });
      let r = out && out.response; if (typeof r === "string") r = JSON.parse(r);
      if (r && typeof r === "object") {
        aiOk = true;
        for (const k of ["child_sensitive", "inappropriate", "hostility", "drama", "spam"]) if (r[k] === true) cats.add(k);
        if (r.reason && [...cats].length) reasons.push(String(r.reason).slice(0, 300));
      }
    } catch (e) { console.error("moderation AI failed", e && e.message); }
  }
  if (!aiOk && !cats.size) cats.add("unscreened");
  const block = ["child_sensitive", "inappropriate", "hostility", "drama", "spam"].some((c) => cats.has(c));
  return { action: block ? "hold" : cats.size ? "flag" : "ok", categories: [...cats], reason: reasons.join(" ") };
}

async function recordFlag(env, kind, itemId, res, text, email, name) {
  if (res.action === "ok") return;
  try {
    await env.DB.prepare("INSERT INTO moderation_flags (kind, item_id, action, categories, reason, excerpt, email, name) VALUES (?,?,?,?,?,?,?,?)")
      .bind(kind, itemId || 0, res.action, res.categories.join(","), res.reason || "", String(text).slice(0, 600), email || "", name || "").run();
  } catch (e) { console.error("recordFlag failed", e && e.message); }
}
// Blocked posts are never published. The poster is asked to rewrite; the attempt is logged for the owner.
function blockMsg(mod) {
  const c = new Set(mod.categories);
  if (c.has("child_sensitive")) return "This can't be posted as written. To protect kids' privacy, please leave out children's names, addresses, schools, schedules and social media, then try again.";
  if (c.has("spam")) return "This can't be posted. Please keep posts about homeschooling in Central Texas.";
  return "This can't be posted as written. Please keep it kind, family-friendly and focused on homeschooling, then try again.";
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
    const existing = await env.DB.prepare("SELECT id, unsubscribed_at FROM subscribers WHERE email=? ORDER BY id LIMIT 1").bind(email).first();
    if (existing) {
      // Already on the list: re-subscribe if they had left, otherwise nothing to do.
      if (existing.unsubscribed_at) await env.DB.prepare("UPDATE subscribers SET unsubscribed_at=NULL WHERE email=?").bind(email).run();
      return json({ ok: true, already: !existing.unsubscribed_at });
    }
    const token = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare("INSERT INTO subscribers (email, source, answers, token) VALUES (?,?,?,?)")
      .bind(email, clip(b.source, 40) || "quiz", JSON.stringify(b.answers || {}).slice(0, 1000), token).run();
    const site = env.SITE_URL || "https://centexhomeschool.org";
    await sendMail(env, email, "Welcome to CenTex Homeschool Hub",
      `Hi there,\n\nThanks for signing up for the CenTex Homeschool Hub newsletter. Once a month you'll get registration dates coming up, groups with open spots, new listings near you and public homeschool events around Central Texas.\n\n` +
      `While you wait for the first issue:\n- Find co-ops and classes near you: ${site}/directory\n- Take the 5-question quiz to find your fit: ${site}/#fit\n- See open houses and deadlines: ${site}/calendar\n\n` +
      `Thanks,\nBenjamin\nCenTex Homeschool Hub\n\nDon't want these emails? Unsubscribe: ${site}/api/unsubscribe?t=${token}`);
    return json({ ok: true });
  },

  "GET /api/unsubscribe": async (req, env) => {
    const t = clip(new URL(req.url).searchParams.get("t"), 64).replace(/[^a-f0-9]/gi, "");
    let ok = false;
    if (t) { const r = await env.DB.prepare("UPDATE subscribers SET unsubscribed_at=datetime('now') WHERE token=? AND unsubscribed_at IS NULL").bind(t).run(); ok = true; }
    const msg = ok ? "You're unsubscribed. You won't get the CenTex Homeschool Hub newsletter anymore." : "That unsubscribe link isn't valid. Reply to any of our emails and we'll take you off the list.";
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe · CenTex Homeschool Hub</title><body style="font-family:system-ui,sans-serif;background:#F8F1E7;color:#2A2219;padding:48px 16px;text-align:center"><h1 style="font-family:Georgia,serif;font-weight:normal">${msg}</h1><p><a href="/" style="color:#3546A8">Back to CenTex Homeschool Hub</a></p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
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
    const kind = ["website", "view", "register"].includes(b.kind) ? b.kind : "other";
    const slugs = Array.isArray(b.slugs) ? b.slugs.slice(0, 80) : [b.slug];
    const stmts = slugs.map((x) => clip(x, 120)).filter(Boolean).map((x) => env.DB.prepare("INSERT INTO clicks (listing_slug, kind) VALUES (?,?)").bind(x, kind));
    if (stmts.length) await env.DB.batch(stmts);
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
    // Featured plan perk: unlimited calendar events. Free listings get FREE_EVENT_LIMIT upcoming events (only enforced when paid plans are on).
    if (paidOn(env)) {
      const ov = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(slug).first();
      const plan = ov ? (JSON.parse(ov.data).plan || "") : "";
      if (!["featured", "partner", "enhanced"].includes(plan)) {
        const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE slug=? AND source='leader' AND status='approved' AND event_date >= date('now')").bind(slug).first();
        if (n.n >= FREE_EVENT_LIMIT) return bad(`Free listings can have ${FREE_EVENT_LIMIT} upcoming events on the calendar at a time. Featured listings can add as many as they like.`);
      }
    }
    const title = clip(b.title, 100), date = clip(b.date, 10), link = clip(b.link, 300), details = clip(b.details, 500);
    if (!title) return bad("Add a title for the event.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("Pick the event date.");
    if (!EVENT_CATS.has(b.category)) return bad("Pick the type of event.");
    if (b.isPublic !== true) return bad("Only events open to the public can go on the calendar.");
    if (link && !/^https?:\/\//i.test(link)) return bad("The link should start with https://");
    const problem = privacyProblem(details + " " + title); if (problem) return bad(problem);
    const mod = await screenText(env, title + "\n" + details);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, title + "\n" + details, email, ""); return bad(blockMsg(mod)); }
    const ins = await env.DB.prepare("INSERT INTO events (email, name, title, event_date, event_time, town, place, host, link, details, status, slug, source, category) VALUES (?,?,?,?,?,?,?,?,?,?, ?, ?, 'leader', ?)")
      .bind(email, clip(b.listing, 140), title, date, clip(b.time, 30), clip(b.town, 40), clip(b.place, 120), clip(b.listing, 140), link, details, mod.action === "hold" ? "held" : "approved", slug, b.category).run();
    await recordFlag(env, "event", ins.meta.last_row_id, mod, title + " — " + details, email, clip(b.listing, 140));
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
    if (details.length < 15) return bad("Add a little more detail so other families can help or learn from it.");
    const problem = privacyProblem(details); if (problem) return bad(problem);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM board_posts WHERE email=? AND status IN ('pending','approved','held') AND expires_at > datetime('now')").bind(email).first();
    if (open.n >= 3) return bad("You can have up to 3 active posts. Remove one to add another.");
    const mod = await screenText(env, details);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, details, email, ""); return bad(blockMsg(mod)); }
    const ins = await env.DB.prepare("INSERT INTO board_posts (email, name, town, ages, want, details, status, expires_at) VALUES (?,?,?,?,?,?, ?, datetime('now','+60 days'))")
      .bind(email, prof.name, clip(b.town, 40) || prof.town || "", clip(b.ages, 40), clip(b.want, 60), details, mod.action === "hold" ? "held" : "approved").run();
    await recordFlag(env, "post", ins.meta.last_row_id, mod, details, email, prof.name);
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
    const mod = await screenText(env, message);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, message, email, ""); return bad(blockMsg(mod)); }
    await recordFlag(env, "reply", Number(b.id) || 0, mod, message, email, prof.name);
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
    const mod = await screenText(env, title + "\n" + details);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, title + "\n" + details, email, ""); return bad(blockMsg(mod)); }
    const ins = await env.DB.prepare("INSERT INTO events (email, name, title, event_date, event_time, town, place, host, link, details, status, category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(email, prof.name, title, date, clip(b.time, 30), clip(b.town, 40), clip(b.place, 120), clip(b.host, 100), link, details, mod.action === "hold" ? "held" : "approved", b.category).run();
    await recordFlag(env, "event", ins.meta.last_row_id, mod, title + " — " + details, email, prof.name);
    return json({ ok: true });
  },

  // ---------- questions on listings ----------
  "GET /api/questions": async (req, env) => {
    // All visible questions, newest first, each with every answer (the school's and the community's).
    const { results } = await env.DB.prepare(
      "SELECT id, slug, listing, name, question, answer, answered_at, created_at FROM questions WHERE status IN ('open','answered') ORDER BY id DESC LIMIT 500").all();
    const ids = results.map((q) => q.id);
    const answers = {};
    if (ids.length) {
      const { results: ans } = await env.DB.prepare(
        `SELECT id, question_id, name, answer, from_school, created_at FROM question_answers WHERE status='live' AND question_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all();
      for (const a of ans) (answers[a.question_id] = answers[a.question_id] || []).push({ name: a.name, answer: a.answer, school: !!a.from_school });
    }
    const by = {};
    for (const q of results) {
      const list = [];
      if (q.answer) list.push({ name: q.listing, answer: q.answer, school: true }); // answer given from the school's portal
      list.push(...(answers[q.id] || []));
      (by[q.slug] = by[q.slug] || []).push({ id: q.id, name: q.name, question: q.question, answers: list });
    }
    return json({ questions: by });
  },

  "POST /api/questions": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const prof = await profileOf(env, email); if (!prof) return bad("Add your display name first.");
    const b = await body(req); const question = clip(b && b.question, 300), slug = clip(b && b.slug, 120);
    if (!slug) return bad("Missing listing.");
    if (question.length < 8) return bad("Write your question in a sentence or two.");
    const problem = privacyProblem(question); if (problem) return bad(problem);
    const mod = await screenText(env, question);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, question, email, ""); return bad(blockMsg(mod)); }
    const ins = await env.DB.prepare("INSERT INTO questions (slug, listing, email, name, question, status) VALUES (?,?,?,?,?,?)")
      .bind(slug, clip(b.listing, 140), email, prof.name, question, mod.action === "hold" ? "held" : "open").run();
    await recordFlag(env, "question", ins.meta.last_row_id, mod, question, email, prof.name);
    const { results: owners } = await env.DB.prepare("SELECT email FROM listing_owners WHERE slug=?").bind(slug).all();
    for (const o of owners) {
      try { await sendMail(env, o.email, `New question about ${clip(b.listing, 140)}`,
        `A family asked:\n\n"${question}"\n\nAnswer it at ${env.SITE_URL || "https://centexhomeschool.org"}/leaders.html. Your answer will show on your listing so other families see it too.\n\nCenTex Homeschool Hub`); } catch (e) {}
    }
    return json({ ok: true, hasLeader: owners.length > 0 });
  },

  // Anyone signed in (school, parent or teacher) can answer a question on a listing.
  "POST /api/questions/answer": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req); const id = Number(b && b.id) || 0, answer = clip(b && b.answer, 600);
    if (answer.length < 2) return bad("Write your answer first.");
    const problem = privacyProblem(answer); if (problem) return bad(problem);
    const q = await env.DB.prepare("SELECT id, slug, listing, email, question FROM questions WHERE id=? AND status IN ('open','answered')").bind(id).first();
    if (!q) return bad("That question isn't available anymore.", 404);
    const owner = await env.DB.prepare("SELECT 1 FROM listing_owners WHERE slug=? AND email=?").bind(q.slug, email).first();
    const fromSchool = !!owner;
    const prof = fromSchool ? null : await profileOf(env, email);
    if (!fromSchool && !prof) return bad("Add your display name first.");
    const mod = await screenText(env, answer);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, answer, email, ""); return bad(blockMsg(mod)); }
    const ins = await env.DB.prepare("INSERT INTO question_answers (question_id, email, name, answer, from_school, status) VALUES (?,?,?,?,?,?)")
      .bind(id, email, fromSchool ? q.listing : prof.name, answer, fromSchool ? 1 : 0, mod.action === "hold" ? "held" : "live").run();
    await recordFlag(env, "answer", ins.meta.last_row_id, mod, answer, email, fromSchool ? q.listing : prof.name);
    if (fromSchool) await env.DB.prepare("UPDATE questions SET status='answered', answered_at=COALESCE(answered_at, datetime('now')) WHERE id=?").bind(id).run();
    const site = env.SITE_URL || "https://centexhomeschool.org";
    if (q.email !== email) {
      try { await sendMail(env, q.email, `New answer to your question about ${q.listing}`,
        `${fromSchool ? q.listing : prof.name} answered your question on CenTex Homeschool Hub:\n\nYou asked: "${q.question}"\n\nAnswer: "${answer}"\n\nSee all answers: ${site}/directory\n\nCenTex Homeschool Hub`); } catch (e) {}
    }
    return json({ ok: true, fromSchool });
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
  "GET /api/admin/newsletters": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT id, subject, status, created_at, approved_at, sent_at, total, sent FROM newsletters WHERE status!='deleted' ORDER BY id DESC LIMIT 24").all();
    const subs = await env.DB.prepare("SELECT COUNT(DISTINCT email) AS n FROM subscribers WHERE unsubscribed_at IS NULL").first();
    return json({ newsletters: results, subscribers: subs.n, mailingAddress: !!env.MAILING_ADDRESS, emailOn: !!env.EMAIL });
  },

  "GET /api/admin/newsletter/preview": async (req, env) => {
    const id = Number(new URL(req.url).searchParams.get("id")) || 0;
    const nl = await env.DB.prepare("SELECT html FROM newsletters WHERE id=?").bind(id).first();
    if (!nl) return bad("Not found.", 404);
    return new Response(personalize(nl.html, env, ""), { headers: { "content-type": "text/html; charset=utf-8" } });
  },

  "POST /api/admin/newsletter/test": async (req, env) => {
    const b = await body(req) || {}; const id = Number(b.id) || 0;
    const nl = await env.DB.prepare("SELECT subject, html FROM newsletters WHERE id=?").bind(id).first();
    if (!nl) return bad("Not found.", 404);
    const to = (env.ADMIN_EMAIL || "").split(",")[0].trim(); if (!to) return bad("Set ADMIN_EMAIL first.");
    const html = personalize(nl.html, env, "");
    const ok = await sendMail(env, to, `[Test] ${nl.subject}`, htmlToText(html), html);
    if (!ok) return bad("Email sending isn't switched on yet, so the test couldn't be sent.", 503);
    return json({ ok: true, to });
  },

  "POST /api/admin/newsletter/approve": async (req, env) => {
    const b = await body(req) || {}; const id = Number(b.id) || 0;
    if (!env.EMAIL) return bad("Email sending isn't switched on yet.", 503);
    if (!env.MAILING_ADDRESS) return bad("Add your mailing address (MAILING_ADDRESS) first. Newsletters must include one by law.");
    const nl = await env.DB.prepare("SELECT id FROM newsletters WHERE id=? AND status='draft'").bind(id).first();
    if (!nl) return bad("Only drafts can be approved.");
    await env.DB.prepare("INSERT OR IGNORE INTO newsletter_sends (newsletter_id, email) SELECT ?, email FROM subscribers WHERE unsubscribed_at IS NULL GROUP BY email").bind(id).run();
    const t = await env.DB.prepare("SELECT COUNT(*) AS n FROM newsletter_sends WHERE newsletter_id=?").bind(id).first();
    await env.DB.prepare("UPDATE newsletters SET status='sending', approved_at=datetime('now'), total=? WHERE id=?").bind(t.n, id).run();
    const sent = await processNewsletters(env, NL_BATCH);
    return json({ ok: true, total: t.n, sentNow: sent });
  },

  "POST /api/admin/newsletter/delete": async (req, env) => {
    const b = await body(req) || {};
    await env.DB.prepare("UPDATE newsletters SET status='deleted' WHERE id=? AND status='draft'").bind(Number(b.id) || 0).run();
    return json({ ok: true });
  },

  // ---------- Featured perk: newsletter spotlight (photo + their own words), twice a year ----------
  "GET /api/leader/spotlight": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const slug = clip(new URL(req.url).searchParams.get("slug"), 120);
    const owned = await env.DB.prepare("SELECT 1 FROM listing_owners WHERE slug=? AND email=?").bind(slug, email).first();
    if (!owned) return bad("Not your listing.", 403);
    const last = await env.DB.prepare("SELECT id, text, status, created_at, used_at FROM spotlights WHERE slug=? AND status IN ('pending','used') ORDER BY id DESC LIMIT 1").bind(slug).first();
    let next = null;
    if (last) { const d = new Date(last.created_at.replace(" ", "T") + "Z"); d.setMonth(d.getMonth() + SPOTLIGHT_MONTHS); if (d > new Date()) next = d.toISOString().slice(0, 10); }
    return json({ last: last ? { ...last, photo: `/api/photo/spotlight/${last.id}` } : null, nextAvailable: next });
  },

  "POST /api/leader/spotlight": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req) || {}; const slug = clip(b.slug, 120), text = clip(b.text, 500), photo = String(b.photo || "");
    const owned = await env.DB.prepare("SELECT 1 FROM listing_owners WHERE slug=? AND email=?").bind(slug, email).first();
    if (!owned) return bad("You can only submit a spotlight for a listing you manage.", 403);
    const ov = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(slug).first();
    const plan = ov ? (JSON.parse(ov.data).plan || "") : "";
    if (!["featured", "partner", "enhanced"].includes(plan)) return bad("Newsletter spotlights are part of the Featured listing.", 403);
    const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM spotlights WHERE slug=? AND status IN ('pending','used') AND created_at > datetime('now','-${SPOTLIGHT_MONTHS} months')`).bind(slug).first();
    if (recent.n) return bad("You've already used this spotlight in the last 6 months. Featured listings get one twice a year.");
    if (text.length < 40) return bad("Tell families a little more, at least a couple of sentences.");
    const m = photo.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return bad("Add a photo (JPG or PNG).");
    if (m[2].length > 1600000) return bad("That photo is too large. Try a smaller one.");
    const problem = privacyProblem(text); if (problem) return bad(problem);
    const mod = await screenText(env, text);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, text, email, ""); return bad(blockMsg(mod)); }
    await env.DB.prepare("INSERT INTO spotlights (slug, listing, email, text, photo_type, photo) VALUES (?,?,?,?,?,?)")
      .bind(slug, clip(b.listing, 140), email, text, m[1], m[2]).run();
    await notifyOwner(env, `Newsletter spotlight submitted: ${clip(b.listing, 140)}`,
      `${clip(b.listing, 140)} submitted their twice-a-year newsletter spotlight. It will be included in the next newsletter draft.\n\n"${text}"`);
    return json({ ok: true });
  },

  "GET /api/admin/activity": async (req, env) => {
    const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
    return json({ days, listings: await listingActivity(env, `-${days} days`, "+1 day") });
  },

  "GET /api/admin/flags": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT id, kind, item_id, action, categories, reason, excerpt, email, name, status, created_at FROM moderation_flags ORDER BY status='open' DESC, id DESC LIMIT 100").all();
    return json({ flags: results.map((f) => ({ ...f, labels: String(f.categories || "").split(",").filter(Boolean).map((c) => MOD_LABELS[c] || c) })) });
  },

  "POST /api/admin/flags/resolve": async (req, env) => {
    const b = await body(req) || {}; const id = Number(b.id) || 0;
    const f = await env.DB.prepare("SELECT kind, item_id FROM moderation_flags WHERE id=?").bind(id).first();
    if (!f) return bad("Not found.", 404);
    const approve = b.action === "approve";
    const map = {
      post: ["board_posts", "approved", "removed"], event: ["events", "approved", "removed"], question: ["questions", "open", "hidden"],
      answer: ["question_answers", "live", "removed"], job: ["jobs", "live", "removed"],
    }[f.kind];
    if (map && f.item_id) {
      const [table, ok, gone] = map;
      if (approve) await env.DB.prepare(`UPDATE ${table} SET status=? WHERE id=? AND status='held'`).bind(ok, f.item_id).run();
      else await env.DB.prepare(`UPDATE ${table} SET status=? WHERE id=?`).bind(gone, f.item_id).run();
    }
    await env.DB.prepare("UPDATE moderation_flags SET status=?, resolved_at=datetime('now') WHERE id=?").bind(approve ? "approved" : "removed", id).run();
    return json({ ok: true });
  },

  "GET /api/admin/moderation": async (req, env) => {
    const [{ results: posts }, { results: evs }, { results: qs }, { results: answers }] = await Promise.all([
      env.DB.prepare("SELECT id, name, email, town, ages, want, details, created_at FROM board_posts WHERE status='approved' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 50").all(),
      env.DB.prepare("SELECT id, name, email, title, event_date, event_time, town, place, host, link, details FROM events WHERE status='approved' AND event_date >= date('now','-1 day') ORDER BY event_date LIMIT 50").all(),
      env.DB.prepare("SELECT id, listing, name, question, answer, status FROM questions WHERE status IN ('open','answered') ORDER BY id DESC LIMIT 30").all(),
      env.DB.prepare("SELECT a.id, a.name, a.email, a.answer, a.from_school, q.listing, q.question FROM question_answers a JOIN questions q ON q.id=a.question_id WHERE a.status='live' ORDER BY a.id DESC LIMIT 50").all(),
    ]);
    return json({ posts, events: evs, questions: qs, answers });
  },

  "POST /api/admin/moderate": async (req, env) => {
    const b = await body(req) || {};
    const table = { post: "board_posts", event: "events", question: "questions", answer: "question_answers" }[b.kind];
    const status = { remove: "removed", hide: "hidden" }[b.action];
    if (!table || !status) return bad("Unknown action.");
    await env.DB.prepare(`UPDATE ${table} SET status=? ${table === "questions" || table === "question_answers" ? "" : ", reviewed_at=datetime('now')"} WHERE id=?`).bind(table === "questions" ? "hidden" : "removed", Number(b.id) || 0).run();
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
    if (!paidOn(env)) featured = true; // paid plans off: every job post is free and goes live right away
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE email=? AND status IN ('live','awaiting_payment','held') AND (expires_at IS NULL OR expires_at > datetime('now'))").bind(email).first();
    if (open.n >= 5) return bad("You have 5 active posts. Remove one to add another.");
    const mod = await screenText(env, title + "\n" + details);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, title + "\n" + details, email, ""); return bad(blockMsg(mod)); }
    const r = await env.DB.prepare(
      `INSERT INTO jobs (email, name, kind, title, org, town, pay, schedule, details, apply_link, status, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, ${kind === "hiring" && !featured ? "NULL" : kind === "hiring" ? "datetime('now','+30 days')" : "datetime('now','+60 days')"})`
    ).bind(email, prof.name, kind, title, clip(b.org, 100), clip(b.town, 40), clip(b.pay, 60), clip(b.schedule, 80), details, kind === "hiring" ? link : "", mod.action === "hold" ? "held" : kind === "hiring" && !featured ? "awaiting_payment" : "live").run();
    await recordFlag(env, "job", r.meta.last_row_id, mod, title + " — " + details, email, prof.name);
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
    const mod = await screenText(env, message);
    if (mod.action === "hold") { await recordFlag(env, "blocked", 0, mod, message, email, ""); return bad(blockMsg(mod)); }
    await recordFlag(env, "reply", Number(b.id) || 0, mod, message, email, prof.name);
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
    const mod = await screenText(env, n + "\n" + d + "\n" + subjects);
    if (mod.action === "hold") { await recordFlag(env, "tutor listing", 0, mod, n + " — " + d, email, n); return bad(blockMsg(mod)); }
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
    await recordFlag(env, "tutor listing", 0, mod, n + " — " + d, email, n);
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
        (paid && paidOn(env) ? `P.S. Want families to enroll in one click? A Featured listing ($39/month) adds a highlighted banner, photos, a "Register" button straight to your registration page, an unlimited description (free listings get 75 characters), a newsletter spotlight twice a year, free job posts and a quarterly report on how your listing is performing. Details: ${env.SITE_URL || "https://centexhomeschool.org"}/leaders.html#plans\n\n` : "") +
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

// ---------- listing activity: views, website clicks, "Notify me" signups, questions ----------
async function listingActivity(env, from, to) {
  const range = `created_at >= datetime('now','${from}') AND created_at < datetime('now','${to}')`;
  const q = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [clicks, alerts, qs] = await Promise.all([
    q(`SELECT listing_slug AS slug, kind, COUNT(*) AS n FROM clicks WHERE ${range} GROUP BY listing_slug, kind`),
    q(`SELECT listing_slug AS slug, COUNT(*) AS n FROM alerts WHERE ${range} GROUP BY listing_slug`),
    q(`SELECT slug, COUNT(*) AS n FROM questions WHERE ${range} AND status IN ('open','answered') GROUP BY slug`),
  ]);
  const by = {};
  const row = (sl) => (by[sl] = by[sl] || { slug: sl, views: 0, website: 0, register: 0, alerts: 0, questions: 0 });
  for (const c of clicks) { const r = row(c.slug), k = c.kind === "view" ? "views" : c.kind; if (k in r && k !== "slug") r[k] += c.n; }
  for (const a of alerts) row(a.slug).alerts += a.n;
  for (const x of qs) row(x.slug).questions += x.n;
  return Object.values(by).sort((a, b) => b.views - a.views || b.website - a.website);
}

// Featured perk: quarterly (Jan 1, Apr 1, Jul 1, Oct 1), email each Featured listing a report on the previous 3 months.
async function monthlyReports(env) {
  const today = new Date(); if (today.getUTCDate() !== 1 || today.getUTCMonth() % 3 !== 0) return;
  const { results } = await env.DB.prepare("SELECT o.slug, o.data, w.email FROM listing_overrides o JOIN listing_owners w ON w.slug=o.slug").all();
  const featured = results.filter((r) => { try { return ["featured", "partner", "enhanced"].includes(JSON.parse(r.data).plan); } catch { return false; } });
  if (!featured.length) return;
  const stats = Object.fromEntries((await listingActivity(env, "start of month', '-3 months", "start of month")).map((r) => [r.slug, r]));
  const waiting = Object.fromEntries((await env.DB.prepare("SELECT listing_slug AS slug, COUNT(DISTINCT email) AS n FROM alerts GROUP BY listing_slug").all()).results.map((r) => [r.slug, r.n]));
  const fmt = (d) => d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)), start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1));
  const month = `${fmt(start)}–${fmt(end)} ${end.getUTCFullYear()}`;
  const site = env.SITE_URL || "https://centexhomeschool.org";
  for (const f of featured) {
    const s = stats[f.slug] || { views: 0, website: 0, register: 0, alerts: 0, questions: 0 };
    let name = f.slug; try { name = JSON.parse(f.data).n || name; } catch {}
    await sendMail(env, f.email, `Your quarterly CenTex Homeschool Hub report: ${month}`,
      `Here's how your listing did from ${month}:\n\n` +
      `- Times families saw your listing: ${s.views}\n- Clicks to your website: ${s.website}\n- Clicks on your Register button: ${s.register}\n` +
      `- New families tapping "Notify me": ${s.alerts}\n- Families waiting on you now: ${waiting[f.slug] || 0}\n- Questions asked on your listing: ${s.questions}\n\n` +
      `Tip: listings with current availability and an upcoming open house get the most attention. Update yours anytime: ${site}/leaders.html\n\nThanks for being a Featured listing,\nBenjamin\nCenTex Homeschool Hub`);
  }
}

// Daily summary for the owner (runs on the cron in wrangler.jsonc). Skipped when nothing is new.
// ---------- monthly newsletter: drafted, approved by the owner, then sent to every subscriber ----------
const NL_BATCH = 40;
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<div style="display:none[\s\S]*?<\/div>/i, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
function personalize(html, env, token) {
  const site = env.SITE_URL || "https://centexhomeschool.org";
  return String(html)
    .split("{{unsubscribe_url}}").join(token ? `${site}/api/unsubscribe?t=${token}` : `${site}/newsletter`)
    .split("{{mailing_address}}").join(env.MAILING_ADDRESS || "");
}
async function processNewsletters(env, limit = NL_BATCH) {
  // Tell the owner about new drafts waiting for approval.
  const { results: fresh } = await env.DB.prepare("SELECT id, subject FROM newsletters WHERE status='draft' AND notified=0").all();
  for (const d of fresh) {
    await notifyOwner(env, `Newsletter ready for your approval: ${d.subject}`,
      `A newsletter draft is ready.\n\nPreview it, send yourself a test, then approve it to send to every subscriber:\n${env.SITE_URL || "https://centexhomeschool.org"}/admin.html#newsletter`);
    await env.DB.prepare("UPDATE newsletters SET notified=1 WHERE id=?").bind(d.id).run();
  }
  // Send queued copies for approved newsletters.
  const nl = await env.DB.prepare("SELECT id, subject, html FROM newsletters WHERE status='sending' ORDER BY id LIMIT 1").first();
  if (!nl) return 0;
  const { results: batch } = await env.DB.prepare(
    "SELECT s.id, s.email, sub.token FROM newsletter_sends s LEFT JOIN subscribers sub ON sub.email=s.email AND sub.unsubscribed_at IS NULL WHERE s.newsletter_id=? AND s.status='queued' ORDER BY s.id LIMIT ?").bind(nl.id, limit).all();
  let sent = 0;
  for (const r of batch) {
    if (!r.token) { await env.DB.prepare("UPDATE newsletter_sends SET status='skipped' WHERE id=?").bind(r.id).run(); continue; } // unsubscribed meanwhile
    const html = personalize(nl.html, env, r.token);
    const ok = await sendMail(env, r.email, nl.subject, htmlToText(html), html);
    await env.DB.prepare("UPDATE newsletter_sends SET status=?, sent_at=datetime('now') WHERE id=?").bind(ok ? "sent" : "failed", r.id).run();
    if (ok) sent++;
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM newsletter_sends WHERE newsletter_id=? AND status='queued'").bind(nl.id).first();
  await env.DB.prepare("UPDATE newsletters SET sent=(SELECT COUNT(*) FROM newsletter_sends WHERE newsletter_id=? AND status='sent'), status=CASE WHEN ?=0 THEN 'sent' ELSE status END, sent_at=CASE WHEN ?=0 THEN datetime('now') ELSE sent_at END WHERE id=?")
    .bind(nl.id, left.n, left.n, nl.id).run();
  return sent;
}

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
    if (event.cron === "0 13 * * *") { ctx.waitUntil(dailyDigest(env)); ctx.waitUntil(monthlyReports(env)); }
    ctx.waitUntil(processNewsletters(env, 200));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const pm = request.method === "GET" && url.pathname.match(/^\/api\/photo\/spotlight\/(\d+)$/);
    if (pm) {
      const row = await env.DB.prepare("SELECT photo_type, photo FROM spotlights WHERE id=? AND status!='removed'").bind(Number(pm[1])).first();
      if (!row) return new Response("Not found", { status: 404 });
      const bytes = Uint8Array.from(atob(row.photo), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { "content-type": row.photo_type, "cache-control": "public, max-age=86400" } });
    }
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
