import { quoteForDate } from "./quotes.js";
// CenTex Homeschool Hub — API for the directory site.
// Static pages are served from /public; everything under /api/ runs here.
//
// Who can do what:
// - Anyone: browse, take the quiz, sign up for the newsletter or alerts, suggest a listing.
// - Group leaders: sign in with a one-time code sent to their email. Once the site owner
//   approves their claim to a listing, they can update it themselves and changes go live.
// - Site owner: /api/admin/* only answers when the signed-in session (one-time code sent to
//   that inbox) belongs to an address listed in ADMIN_EMAIL.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
const bad = (message, status = 400) => json({ error: message }, status);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const AVAIL = new Set(["open", "waitlist", "full", "opens", "unknown"]);
const EVENT_CATS = new Set(["openhouse", "deadline", "public", "activity", "other"]);
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

// Never trust a client-supplied header for this: only a real email-code session counts.
async function adminEmail(request, env) {
  const who = ((await leaderEmail(request, env)) || "").toLowerCase();
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
// ---- Email design: every email shares this branded frame (header picture, serif title, quote, footer) ----
function emailShell(env, inner, preheader = "") {
  const wq = quoteForDate(), QUOTE = [wq.q, wq.a];
  const site = env.SITE_URL || "https://centexhomeschool.org";
  const escH = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const social = [["Facebook", env.FACEBOOK_URL], ["Instagram", env.INSTAGRAM_URL]].filter((x) => x[1]).map(([n, u]) => `<a href="${u}" style="color:#2F5A3D;font-weight:bold;text-decoration:none">${n}</a>`).join(" &nbsp;·&nbsp; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#F8F1E7">${preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escH(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F1E7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFBF5;border:1px solid #EADCC9;border-radius:16px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2A2219">
<tr><td style="padding:0;line-height:0"><a href="${site}"><img src="${site}/email/header.jpg" width="600" alt="Families at a park day under a big live oak in the Texas Hill Country" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a></td></tr>
<tr><td style="padding:22px 30px 4px"><span style="font-family:'Young Serif',Georgia,'Times New Roman',serif;font-size:24px;color:#2F5A3D">CenTex Homeschool Hub</span><br><span style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#76675A;font-weight:bold">Homeschool begins here</span></td></tr>
<tr><td style="padding:14px 30px 10px;font-size:16px;line-height:1.65">${inner}</td></tr>
<tr><td style="padding:6px 30px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E3ECE2;border-radius:12px"><tr><td style="padding:16px 20px;font-family:'Young Serif',Georgia,serif;font-size:17px;line-height:1.5;color:#2F5A3D">&ldquo;${QUOTE[0]}&rdquo;<br><span style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#76675A">— ${QUOTE[1]}</span></td></tr></table></td></tr>
<tr><td style="padding:14px 30px 22px;border-top:1px solid #EADCC9;font-size:12.5px;line-height:1.6;color:#76675A">
<a href="${site}/directory" style="color:#2F5A3D;text-decoration:none;font-weight:bold">Directory</a> &nbsp;·&nbsp; <a href="${site}/calendar" style="color:#2F5A3D;text-decoration:none;font-weight:bold">Calendar</a> &nbsp;·&nbsp; <a href="${site}/texas-history" style="color:#2F5A3D;text-decoration:none;font-weight:bold">Texas History</a> &nbsp;·&nbsp; <a href="${site}/news" style="color:#2F5A3D;text-decoration:none;font-weight:bold">News</a>${social ? `<br>Follow us: ${social}` : ""}<br>CenTex Homeschool Hub · ${escH(env.MAILING_ADDRESS || "Central Texas")}</td></tr>
</table></td></tr></table></body></html>`;
}
// Plain-text email -> designed HTML. "Label: https://link" lines become buttons; other links are styled.
function textToHtml(env, text) {
  const escH = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const link = (h) => h.replace(/(^|[^"])(https?:\/\/[^\s<"]+[^\s<.,;:!?)"])/g, '$1<a href="$2" style="color:#3546A8">$2</a>');
  // "- Label: https://url" list lines -> the label becomes the link
  const labelLinks = (h) => h.replace(/^(- )?([^\n:<]{3,70}):\s*(https?:\/\/[^\s<]+)$/gm, (m, dash, label, url) => `${dash ? "&bull; " : ""}<a href="${url}" style="color:#3546A8;font-weight:bold">${label}</a>`);
  const paras = String(text).split(/\n{2,}/).map((p) => {
    if (/unsubscribe/i.test(p) && /https?:\/\//.test(p)) {
      const u = p.match(/https?:\/\/\S+/)[0];
      return `<p style="margin:18px 0 0;font-size:12.5px;color:#76675A">${escH(p.replace(/\s*(Unsubscribe( from all emails)?)?:?\s*https?:\/\/\S+/i, "").trim())} <a href="${escH(u)}" style="color:#76675A">Unsubscribe</a></p>`;
    }
    const code = p.match(/code is (\d{6})/i);
    if (code) return `<p style="margin:0 0 6px">Your sign-in code:</p><p style="margin:0 0 18px"><span style="display:inline-block;font-family:'Young Serif',Georgia,serif;font-size:34px;letter-spacing:.18em;color:#2F5A3D;background:#E3ECE2;border-radius:10px;padding:10px 18px">${code[1]}</span></p>`;
    const btn = p.trim().match(/^([^\n:]{3,60}):\s*(https?:\/\/\S+)$/);
    if (btn) return `<p style="margin:6px 0 18px"><a href="${escH(btn[2])}" style="display:inline-block;background:#2F5A3D;color:#FFFBF5;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">${escH(btn[1])} &rarr;</a></p>`;
    return `<p style="margin:0 0 14px">${link(labelLinks(escH(p))).replace(/\n/g, "<br>")}</p>`;
  });
  const first = String(text).split("\n").find((l) => l.trim() && !/^hi\b/i.test(l.trim())) || "";
  return emailShell(env, paras.join(""), first.slice(0, 120));
}

async function sendMail(env, to, subject, text, html, opts = {}) {
  // Local testing only: with EMAIL_DEBUG=1 and no email binding, print the email to the dev console.
  if (env.EMAIL_DEBUG === "1" && !env.EMAIL) { console.log(`[email to ${to}] ${subject}\n${text}`); return true; }
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return false;
  try {
    const owner = (env.ADMIN_EMAIL || "").split(",")[0].trim();
    // Emails that carry a personal unsubscribe link get one-click unsubscribe headers (Gmail/Yahoo look for these).
    const unsub = String(text + (html || "")).match(/https?:\/\/[^\s"<>]+\/api\/unsubscribe\?t=[a-f0-9]+/i);
    const headers = unsub ? { "List-Unsubscribe": `<${unsub[0]}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
    await env.EMAIL.send({
      to,
      from: { email: env.MAIL_FROM || "hello@centexhomeschool.org", name: "CenTex Homeschool Hub" },
      // Replies go to a real person: the other parent for reply emails, otherwise the owner's inbox.
      ...((opts.replyTo || owner) ? { replyTo: opts.replyTo || owner } : {}),
      subject,
      text,
      html: html || textToHtml(env, text),
      ...(headers ? { headers } : {}),
    });
    return true;
  } catch (e) {
    // Usually means the domain isn't onboarded to Cloudflare Email Sending yet.
    console.error("Email send failed:", e && e.message);
    try { await env.DB.prepare("INSERT INTO email_errors (to_email, subject, error) VALUES (?,?,?)").bind(String(to).slice(0, 160), String(subject).slice(0, 160), String((e && (e.code ? e.code + ": " : "") + e.message) || e).slice(0, 500)).run(); } catch {}
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

// Vendor/leader emails invite the recipient to the newsletter + Monday quotes (skipped if already subscribed).
async function joinBlock(env, email) {
  const e = String(email || "").toLowerCase(); if (!e) return "";
  try {
    const sub = await env.DB.prepare("SELECT 1 FROM subscribers WHERE email=? AND unsubscribed_at IS NULL").bind(e).first();
    if (sub) return "";
    const token = randomToken(16);
    await env.DB.prepare("INSERT INTO join_tokens (token, email) VALUES (?,?)").bind(token, e).run();
    const site = env.SITE_URL || "https://centexhomeschool.org";
    return `Stay in the loop: our monthly newsletter covers open houses, deadlines, homeschool days and Texas law changes, and every Monday we send a short quote to encourage you on your homeschool journey.\n\nGet the newsletter + Monday quotes: ${site}/api/join?t=${token}\n\n`;
  } catch (err) { console.error("joinBlock failed", err && err.message); return ""; }
}
function welcomeText(env, token, ref) {
  const site = env.SITE_URL || "https://centexhomeschool.org";
  return `Hi there,\n\nThanks for signing up for the CenTex Homeschool Hub newsletter. Once a month you'll get registration dates coming up, groups with open spots, new listings near you and public homeschool events around Central Texas. And every Monday, a short quote to encourage you on your homeschool journey.\n\n` +
    `Your Texas Homeschool Starter Checklist: ${site}/checklist.html\n\nWhile you wait for the first issue:\n- Find co-ops and classes near you: ${site}/directory\n- Homeschool-friendly activities: ${site}/activities\n- Take the 5-question quiz to find your fit: ${site}/#fit\n- See open houses and deadlines: ${site}/calendar\n\n` +
    `${shareLine(env, ref)}\n\nThanks,\nBenjamin\nCenTex Homeschool Hub\n\nDon't want these emails? Unsubscribe: ${site}/api/unsubscribe?t=${token}`;
}
function simplePage(title, msg, extra = "") {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · CenTex Homeschool Hub</title><body style="font-family:system-ui,sans-serif;background:#F8F1E7;color:#2A2219;padding:48px 16px;text-align:center"><h1 style="font-family:Georgia,serif;font-weight:normal;max-width:620px;margin:0 auto 16px">${msg}</h1>${extra}<p><a href="/" style="color:#3546A8">Back to CenTex Homeschool Hub</a></p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
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
  const stamp = new Date().toISOString();
  const merged = { ...prev, ...fields, claimed: true };
  if (fields.avail) merged.availAt = stamp; // when the group last confirmed availability
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
    const { results: seenRows } = await env.DB.prepare("SELECT slug, s, when_text, source, source_url, checked_at FROM seen_avail").all();
    const seen = Object.fromEntries(seenRows.map((r) => [r.slug, { s: r.s, when: r.when_text || "", source: r.source, url: r.source_url, at: r.checked_at }]));
    const { results: made } = await env.DB.prepare("SELECT slug, data FROM user_listings WHERE status='live' ORDER BY created_at").all();
    const custom = [];
    for (const r of made) { try { custom.push({ ...JSON.parse(r.data), slug: r.slug }); } catch {} }
    return json({ overrides: out, custom, seen });
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
    // Let the submitter know we got it.
    try {
      const site = env.SITE_URL || "https://centexhomeschool.org";
      await sendMail(env, email, `We got your listing for ${name}`,
        `Hi ${clip(b.contact, 80) || "there"},\n\nThanks for adding ${name} to CenTex Homeschool Hub. Your listing is in our review queue. We review every listing by hand, usually within a couple of days, and we'll reach out if we have any questions.\n\n` +
        `Once it's up, you can claim it to keep your details, availability and open house dates current. Families who tap "Notify me" get an email the moment you open spots.\n\nSee the directory: ${site}/directory\n\n` +
        (await joinBlock(env, email)) + `Thanks,\nBenjamin\nCenTex Homeschool Hub`);
    } catch (e) { console.error("submission receipt failed", e && e.message); }
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
      return json({ ok: true, already: !existing.unsubscribed_at, ref: await ensureRef(env, email) });
    }
    const token = crypto.randomUUID().replace(/-/g, ""), ref = newRef();
    // Credit the friend who shared their link (ignored if the code is unknown).
    const by = clip(b.ref, 16).replace(/[^a-f0-9]/gi, "").toLowerCase();
    const referrer = by ? await env.DB.prepare("SELECT ref FROM subscribers WHERE ref=? LIMIT 1").bind(by).first() : null;
    await env.DB.prepare("INSERT INTO subscribers (email, source, answers, token, ref, referred_by) VALUES (?,?,?,?,?,?)")
      .bind(email, clip(b.source, 40) || "quiz", JSON.stringify(b.answers || {}).slice(0, 1000), token, ref, referrer ? referrer.ref : null).run();
    await sendMail(env, email, "Welcome to CenTex Homeschool Hub", welcomeText(env, token, ref));
    return json({ ok: true, ref });
  },

  // Newsletter invite links in vendor emails. GET shows a confirm button (so link scanners can't sign anyone up); POST subscribes.
  "GET /api/join": async (req, env) => {
    const t = clip(new URL(req.url).searchParams.get("t"), 64).replace(/[^a-f0-9]/gi, "");
    const row = t ? await env.DB.prepare("SELECT email FROM join_tokens WHERE token=?").bind(t).first() : null;
    if (!row) return simplePage("Join", "That link has expired. You can sign up on our home page anytime.");
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    return simplePage("Join", "Get the monthly newsletter and a Monday quote for your homeschool journey?",
      `<p style="color:#76675A">We'll send them to <b>${esc(row.email)}</b>. Unsubscribe anytime.</p><form method="post" action="/api/join?t=${t}"><button style="font:inherit;font-weight:bold;background:#2F5A3D;color:#FFFBF5;border:0;border-radius:10px;padding:12px 22px;cursor:pointer">Yes, sign me up</button></form>`);
  },
  "POST /api/join": async (req, env) => {
    const t = clip(new URL(req.url).searchParams.get("t"), 64).replace(/[^a-f0-9]/gi, "");
    const row = t ? await env.DB.prepare("SELECT email FROM join_tokens WHERE token=?").bind(t).first() : null;
    if (!row) return simplePage("Join", "That link has expired. You can sign up on our home page anytime.");
    const email = row.email;
    const existing = await env.DB.prepare("SELECT id FROM subscribers WHERE email=? ORDER BY id LIMIT 1").bind(email).first();
    if (existing) {
      await env.DB.prepare("UPDATE subscribers SET unsubscribed_at=NULL, weekly_quotes=1 WHERE email=?").bind(email).run();
    } else {
      const token = crypto.randomUUID().replace(/-/g, ""), ref = newRef();
      await env.DB.prepare("INSERT INTO subscribers (email, source, answers, token, ref) VALUES (?,?,?,?,?)").bind(email, "vendor-email", "{}", token, ref).run();
      await sendMail(env, email, "Welcome to CenTex Homeschool Hub", welcomeText(env, token, ref));
    }
    await env.DB.prepare("DELETE FROM join_tokens WHERE email=?").bind(email).run();
    return simplePage("Welcome", "You're in! Watch for the monthly newsletter and a quote every Monday.");
  },

  // One-click unsubscribe from inbox providers (RFC 8058): POST to the same link.
  "POST /api/unsubscribe": async (req, env) => {
    const t = clip(new URL(req.url).searchParams.get("t"), 64).replace(/[^a-f0-9]/gi, "");
    if (t) await env.DB.prepare("UPDATE subscribers SET unsubscribed_at=datetime('now') WHERE token=? AND unsubscribed_at IS NULL").bind(t).run();
    return json({ ok: true });
  },
  "GET /api/unsubscribe": async (req, env) => {
    const u = new URL(req.url), t = clip(u.searchParams.get("t"), 64).replace(/[^a-f0-9]/gi, ""), quotesOnly = u.searchParams.get("what") === "quotes";
    let ok = false;
    if (t && quotesOnly) { await env.DB.prepare("UPDATE subscribers SET weekly_quotes=0 WHERE token=?").bind(t).run(); ok = true; }
    else if (t) { const r = await env.DB.prepare("UPDATE subscribers SET unsubscribed_at=datetime('now') WHERE token=? AND unsubscribed_at IS NULL").bind(t).run(); ok = true; }
    const msg = !ok ? "That unsubscribe link isn't valid. Reply to any of our emails and we'll take you off the list."
      : quotesOnly ? "Done. You won't get the weekly quote anymore. You'll still get the monthly newsletter." : "You're unsubscribed. You won't get CenTex Homeschool Hub emails anymore.";
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe · CenTex Homeschool Hub</title><body style="font-family:system-ui,sans-serif;background:#F8F1E7;color:#2A2219;padding:48px 16px;text-align:center"><h1 style="font-family:Georgia,serif;font-weight:normal">${msg}</h1><p><a href="/" style="color:#3546A8">Back to CenTex Homeschool Hub</a></p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  },

  // This week's inspirational quote (changes every Monday, Central Time).
  "GET /api/quote": async () => json({ quote: quoteForDate() }),

  // Homeschool news: summaries written by us, each linking to the original article.
  // "Still accurate": the leader confirms availability without changing it.
  "POST /api/leader/avail-confirm": async (req, env) => {
    const email = await leaderEmail(req, env); if (!email) return bad("Sign in first.", 401);
    const b = await body(req) || {}; const slug = clip(b.slug, 140);
    const owned = await env.DB.prepare("SELECT 1 FROM listing_owners WHERE slug=? AND email=?").bind(slug, email).first();
    if (!owned) return bad("You can only update listings you manage.", 403);
    return json({ ok: true, availAt: await confirmAvail(env, slug, email) });
  },
  // One-click link from the monthly availability reminder email.
  "GET /api/avail/confirm": async (req, env) => {
    const t = clip(new URL(req.url).searchParams.get("t"), 64).replace(/[^a-f0-9]/gi, "");
    const row = t ? await env.DB.prepare("SELECT slug, email, listing FROM avail_tokens WHERE token=? AND created_at > datetime('now','-45 days')").bind(t).first() : null;
    const site = env.SITE_URL || "https://centexhomeschool.org";
    if (row) await confirmAvail(env, row.slug, row.email);
    const msg = row ? `Thanks! ${row.listing || "Your listing"} is marked up to date as of today.` : "That link has expired. Sign in to update your availability.";
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Availability · CenTex Homeschool Hub</title><body style="font-family:system-ui,sans-serif;background:#F8F1E7;color:#2A2219;padding:48px 16px;text-align:center"><h1 style="font-family:Georgia,serif;font-weight:normal">${msg.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))}</h1><p>Something changed? <a href="${site}/leaders.html" style="color:#3546A8">Update your listing</a></p><p><a href="/" style="color:#3546A8">Back to CenTex Homeschool Hub</a></p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  },

  "GET /api/news": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT id, title, source, url, published, summary, region, topic FROM news WHERE status='live' ORDER BY published DESC, id DESC LIMIT 100").all();
    return json({ news: results });
  },

  // Coarse public count for "Join N families" (only shown by the page once it's 100+).
  "GET /api/stats": async (req, env) => {
    const r = await env.DB.prepare("SELECT COUNT(DISTINCT email) AS n FROM subscribers WHERE unsubscribed_at IS NULL").first();
    return json({ subscribers: r.n >= 100 ? Math.floor(r.n / 50) * 50 : 0 });
  },

  // "Remind me" on a calendar event: reminder email the morning before + monthly newsletter.
  "POST /api/cal/remind": async (req, env) => {
    const b = await body(req) || {}; const email = clip(b.email, 160).toLowerCase(), id = Number(b.id) || 0;
    if (!EMAIL_RE.test(email)) return bad("Enter a valid email address.");
    const ev = await env.DB.prepare("SELECT id FROM events WHERE id=? AND status='approved' AND event_date >= date('now')").bind(id).first();
    if (!ev) return bad("That event isn't on the calendar anymore.", 404);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO event_reminders (event_id, email) VALUES (?,?)").bind(id, email),
      env.DB.prepare("INSERT INTO subscribers (email, source, token, ref) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM subscribers WHERE email=?)").bind(email, "reminder", crypto.randomUUID().replace(/-/g, ""), newRef(), email),
    ]);
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
      env.DB.prepare("INSERT INTO subscribers (email, source, listing, token, ref) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM subscribers WHERE email=?)").bind(email, "alert", clip(b.listing, 140), crypto.randomUUID().replace(/-/g, ""), newRef(), email),
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
      try {
        await sendMail(env, email, `We got your request to manage ${clip(b.listing, 140)}`,
          `Hi ${clip(b.name, 80) || "there"},\n\nThanks for claiming ${clip(b.listing, 140)} on CenTex Homeschool Hub. We're reviewing your request now and will email you as soon as it's approved, usually within a couple of days.\n\n` +
          `Once approved, sign in with this email address to update your details, mark availability and add open houses to the community calendar.\n\n` +
          (await joinBlock(env, email)) + `Thanks,\nBenjamin\nCenTex Homeschool Hub`);
      } catch (e) { console.error("claim receipt failed", e && e.message); }
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
        `${prof.name}${prof.town ? " (" + prof.town + ")" : ""} replied to your "Looking for" post:\n\n"${message}"\n\nYour post: "${post.details}"\n\nTo write back, just reply to this email (it goes to ${email}). They chose to share it by replying.\n\nCenTex Homeschool Hub`, null, { replyTo: email });
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

  "GET /api/admin/news": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT id, title, source, url, published, region, topic, status FROM news ORDER BY published DESC, id DESC LIMIT 100").all();
    return json({ news: results });
  },
  "POST /api/admin/news/status": async (req, env) => {
    const b = await body(req) || {}; const id = Number(b.id) || 0; const st = b.status === "live" ? "live" : "hidden";
    await env.DB.prepare("UPDATE news SET status=? WHERE id=?").bind(st, id).run();
    return json({ ok: true });
  },

  "GET /api/admin/referrals": async (req, env) => {
    const { results } = await env.DB.prepare(
      "SELECT r.email, r.ref, COUNT(DISTINCT s.email) AS n, MAX(s.created_at) AS last FROM subscribers s JOIN subscribers r ON r.ref=s.referred_by WHERE s.referred_by IS NOT NULL GROUP BY r.email, r.ref ORDER BY n DESC, last DESC LIMIT 25").all();
    const tot = await env.DB.prepare("SELECT COUNT(DISTINCT email) AS n FROM subscribers WHERE referred_by IS NOT NULL").first();
    return json({ referrers: results, total: tot.n });
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
        `${prof.name}${prof.town ? " (" + prof.town + ")" : ""} responded to your post "${job.title}":\n\n"${message}"\n\nTo write back, just reply to this email (it goes to ${email}). They chose to share it by responding.\n\nCenTex Homeschool Hub`, null, { replyTo: email });
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
  "GET /api/admin/me": async (req, env) => json({ admin: !!(await adminEmail(req, env)) }),

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
        (await joinBlock(env, c.email)) +
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

  // Drill-down behind each "At a glance" number.
  "GET /api/admin/detail": async (req, env) => {
    const what = new URL(req.url).searchParams.get("what") || "";
    const all = async (sql) => (await env.DB.prepare(sql).all()).results;
    const Q = {
      subscribers: "SELECT email, source, created_at, COALESCE(weekly_quotes,1) AS quotes, referred_by FROM subscribers WHERE unsubscribed_at IS NULL GROUP BY email ORDER BY created_at DESC LIMIT 500",
      alerts: "SELECT email, listing, town, status_at_signup, created_at FROM alerts ORDER BY created_at DESC LIMIT 500",
      claimed: "SELECT w.slug, w.email, w.name, w.role, w.approved_at, COALESCE((SELECT c.listing FROM claims c WHERE c.slug=w.slug ORDER BY c.id DESC LIMIT 1), (SELECT json_extract(u.data,'$.n') FROM user_listings u WHERE u.slug=w.slug)) AS listing FROM listing_owners w ORDER BY w.approved_at DESC LIMIT 500",
      quizzes: "SELECT town, age, faith, want, interest, matches, local_matches, created_at FROM demand ORDER BY created_at DESC LIMIT 500",
      submissions: "SELECT id, kind, name, town, website, contact, email, details, availability, registration_opens, status, created_at FROM submissions ORDER BY (status='new') DESC, created_at DESC LIMIT 200",
      outbox: "SELECT to_email, listing, kind, subject, status, created_at FROM outbox WHERE status='queued' ORDER BY created_at DESC LIMIT 500",
    };
    if (!Q[what]) return bad("Unknown list.");
    return json({ what, rows: await all(Q[what]) });
  },

  // Publish a "Add a listing" request as a live directory listing, and tell the submitter.
  "POST /api/admin/submissions/approve": async (req, env) => {
    const b = await body(req) || {}; const id = Number(b.id); if (!id) return bad("Missing id.");
    const sub = await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(id).first();
    if (!sub) return bad("That request is gone.", 404);
    if (sub.status !== "new") return bad("That request was already handled.");
    const n = clip(b.n || sub.name, 140), town = clip(b.town || sub.town, 60);
    const type = ["coop", "group", "class", "micro", "tutor", "activity"].includes(b.type) ? b.type : "";
    if (!n || !town || !type) return bad("Add a name, town and type before publishing.");
    const site = clip(b.site ?? sub.website, 300); if (site && !/^https?:\/\//i.test(site)) return bad("The website should start with https://");
    const d = clip(b.d ?? sub.details, 300);
    const tags = String(b.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6);
    const slug = (n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "listing") + "-" + randomToken(2);
    const data = { n, town, type, tags, days: [], d, site, ages: clip(b.ages, 40) };
    const stamp = new Date().toISOString();
    const stmts = [
      env.DB.prepare("INSERT INTO user_listings (slug, email, data) VALUES (?,?,?)").bind(slug, sub.email, JSON.stringify(data)),
      env.DB.prepare("UPDATE submissions SET status='approved' WHERE id=?").bind(id),
    ];
    if (b.makeOwner) {
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO listing_owners (slug, email, name, role, approved_at) VALUES (?,?,?,?,?)").bind(slug, sub.email, sub.contact || "", "submitter", stamp));
      stmts.push(env.DB.prepare("INSERT INTO listing_overrides (slug, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slug) DO NOTHING").bind(slug, JSON.stringify({ claimed: true }), stamp, "owner"));
    }
    await env.DB.batch(stmts);
    const site0 = env.SITE_URL || "https://centexhomeschool.org";
    let emailed = false;
    try {
      emailed = await sendMail(env, sub.email, `${n} is now live on CenTex Homeschool Hub`,
        `Hi ${sub.contact || "there"},\n\nGood news: ${n} is now listed in the CenTex Homeschool Hub directory, where Central Texas families look for co-ops, classes and activities.\n\n` +
        (b.makeOwner
          ? `You can manage it yourself. Sign in with this email address to update your details, mark availability and add open houses to the community calendar. Families who tap "Notify me" get an email the moment you open spots.\n\nManage your listing: ${site0}/leaders.html\n\n`
          : `Want to keep it up to date yourself? Claim it with this email address and you can update details, mark availability and add open houses to the community calendar.\n\nClaim your listing: ${site0}/leaders.html\n\n`) +
        `See it in the directory: ${site0}/directory\n\n` + (await joinBlock(env, sub.email)) + `Thanks,\nBenjamin\nCenTex Homeschool Hub`);
    } catch (e) { console.error("live email failed", e && e.message); }
    return json({ ok: true, slug, emailed });
  },
  "POST /api/admin/submissions/status": async (req, env) => {
    const b = await body(req) || {}; const id = Number(b.id);
    const status = ["handled", "dismissed", "new"].includes(b.status) ? b.status : null;
    if (!id || !status) return bad("Missing id or status.");
    await env.DB.prepare("UPDATE submissions SET status=? WHERE id=?").bind(status, id).run();
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
async function confirmAvail(env, slug, email) {
  const row = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(slug).first();
  const data = row ? JSON.parse(row.data) : { claimed: true };
  const stamp = new Date().toISOString(); data.availAt = stamp;
  await env.DB.prepare("INSERT INTO listing_overrides (slug, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slug) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by")
    .bind(slug, JSON.stringify(data), stamp, email).run();
  return stamp;
}

// 1st of every month: ask each group leader to confirm or update their availability.
const AVAIL_WORDS = { open: "Open spots", waitlist: "Waitlist", full: "Full", opens: "Registration opens soon", unknown: "Not set yet" };
async function availReminders(env) {
  if (new Date().getUTCDate() !== 1 && env.FORCE_MONTHLY !== "1") return 0; // FORCE_MONTHLY=1 only for local testing
  const { results } = await env.DB.prepare(
    "SELECT w.slug, w.email, w.name, o.data, (SELECT c.listing FROM claims c WHERE c.slug=w.slug AND c.status='approved' ORDER BY c.id DESC LIMIT 1) AS listing, (SELECT COUNT(DISTINCT a.email) FROM alerts a WHERE a.listing_slug=w.slug) AS waiting FROM listing_owners w LEFT JOIN listing_overrides o ON o.slug=w.slug").all();
  const site = env.SITE_URL || "https://centexhomeschool.org", byEmail = {};
  for (const r of results) (byEmail[r.email] = byEmail[r.email] || []).push(r);
  let sent = 0;
  for (const [email, rows] of Object.entries(byEmail)) {
    const parts = [];
    for (const r of rows) {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
      const a = d.avail || { s: "unknown" }, name = r.listing || r.slug;
      const when = d.availAt ? new Date(d.availAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }) : "";
      let line = `${name}
  Shown to families now: ${AVAIL_WORDS[a.s] || "Not set yet"}${a.s === "opens" && a.when ? " (" + a.when + ")" : ""}${when ? ", last confirmed " + when : ""}`;
      if (r.waiting) line += `
  ${r.waiting} ${r.waiting === 1 ? "family is" : "families are"} waiting to hear when spots open`;
      if (a.s !== "unknown") {
        const token = crypto.randomUUID().replace(/-/g, "");
        await env.DB.prepare("INSERT INTO avail_tokens (token, slug, email, listing) VALUES (?,?,?,?)").bind(token, r.slug, email, name).run();
        line += `
  Still accurate? One click: ${site}/api/avail/confirm?t=${token}`;
      }
      parts.push(line);
    }
    const ok = await sendMail(env, email, "Quick check: is your availability up to date?",
      `Hi ${rows[0].name || "there"},

Families use CenTex Homeschool Hub to see which groups have room. Here's what your listing shows right now:

${parts.join("\n\n")}

` +
      `Something changed? Update it in a minute: ${site}/leaders.html
Opening spots alerts every family who tapped "Notify me" on your listing.

` + (await joinBlock(env, email)) + `Thanks,
Benjamin
CenTex Homeschool Hub`);
    if (ok) sent++;
  }
  return sent;
}

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
      `Tip: listings with current availability and an upcoming open house get the most attention. Update yours anytime: ${site}/leaders.html\n\n` + (await joinBlock(env, f.email)) + `Thanks for being a Featured listing,\nBenjamin\nCenTex Homeschool Hub`);
  }
}

// Event reminders: runs with the 8 a.m. daily job and emails anyone who asked about tomorrow's events.
async function sendEventReminders(env) {
  const { results } = await env.DB.prepare(
    "SELECT r.id, r.email, e.title, e.event_date, e.event_time, e.place, e.town, e.link, s.token, s.ref FROM event_reminders r JOIN events e ON e.id=r.event_id LEFT JOIN subscribers s ON s.email=r.email AND s.unsubscribed_at IS NULL WHERE r.sent=0 AND e.status='approved' AND e.event_date = date('now','-5 hours','+1 day') LIMIT 300").all();
  const site = env.SITE_URL || "https://centexhomeschool.org";
  for (const r of results) {
    const when = new Date(r.event_date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
    const ok = await sendMail(env, r.email, `Reminder: ${r.title} is tomorrow`,
      `Just a reminder: ${r.title} is tomorrow, ${when}${r.event_time ? " at " + r.event_time : ""}${r.place || r.town ? ", " + [r.place, r.town].filter(Boolean).join(", ") : ""}.\n\n${r.link ? "Details and registration: " + r.link + "\n\n" : ""}Please confirm details with the host before you go.\n\nMore homeschool events: ${site}/calendar\n\n${shareLine(env, r.ref)}\n\nCenTex Homeschool Hub${r.token ? "\nUnsubscribe from all emails: " + site + "/api/unsubscribe?t=" + r.token : ""}`);
    await env.DB.prepare("UPDATE event_reminders SET sent=? WHERE id=?").bind(ok ? 1 : 2, r.id).run();
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
const newRef = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const refUrl = (env, ref) => `${env.SITE_URL || "https://centexhomeschool.org"}/${ref ? "?ref=" + ref : ""}`;
// Make sure a subscriber has a share code (older rows were created before referrals existed).
async function ensureRef(env, email) {
  const row = await env.DB.prepare("SELECT ref FROM subscribers WHERE email=? AND ref IS NOT NULL ORDER BY id LIMIT 1").bind(email).first();
  if (row) return row.ref;
  const ref = newRef();
  await env.DB.prepare("UPDATE subscribers SET ref=? WHERE email=? AND ref IS NULL").bind(ref, email).run();
  return ref;
}
const shareLine = (env, ref) => `Know another homeschool family who'd find this useful? Forward this email, or share your link: ${refUrl(env, ref)}`;
// Newsletter footer: "Follow us on Facebook · Instagram" once FACEBOOK_URL / INSTAGRAM_URL are set on the Worker.
function socialLinks(env) {
  const links = [["Facebook", env.FACEBOOK_URL], ["Instagram", env.INSTAGRAM_URL]].filter((x) => x[1]);
  return links.length ? "Follow us on " + links.map(([n, u]) => `<a href="${u}" style="color:#2F5A3D;font-weight:bold;">${n}</a>`).join(" · ") + "<br>" : "";
}
function personalize(html, env, token, ref) {
  const site = env.SITE_URL || "https://centexhomeschool.org";
  return String(html)
    .split("{{referral_url}}").join(refUrl(env, ref))
    .split("{{social_links}}").join(socialLinks(env))
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
    "SELECT s.id, s.email, sub.token, sub.ref FROM newsletter_sends s LEFT JOIN subscribers sub ON sub.email=s.email AND sub.unsubscribed_at IS NULL WHERE s.newsletter_id=? AND s.status='queued' ORDER BY s.id LIMIT ?").bind(nl.id, limit).all();
  let sent = 0;
  for (const r of batch) {
    if (!r.token) { await env.DB.prepare("UPDATE newsletter_sends SET status='skipped' WHERE id=?").bind(r.id).run(); continue; } // unsubscribed meanwhile
    const html = personalize(nl.html, env, r.token, r.ref || await ensureRef(env, r.email));
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

// ---------- Weekly inspirational quote email (Mondays) ----------
async function sendWeeklyQuote(env, force = false) {
  const now = new Date(), ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  if (!force && ct.getDay() !== 1) return 0;
  const wq = quoteForDate(now), site = env.SITE_URL || "https://centexhomeschool.org";
  const { results } = await env.DB.prepare(
    "SELECT s.email, MIN(s.token) AS token FROM subscribers s WHERE s.unsubscribed_at IS NULL AND COALESCE(s.weekly_quotes,1)=1 AND s.token IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quote_sends q WHERE q.week=? AND q.email=s.email) GROUP BY s.email LIMIT 150").bind(wq.week).all();
  const escH = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let sent = 0;
  for (const r of results) {
    const stopQ = `${site}/api/unsubscribe?t=${r.token}&what=quotes`, stopAll = `${site}/api/unsubscribe?t=${r.token}`;
    const inner = `<p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#76675A;font-weight:bold">This week · ${escH(wq.t)}</p>
<p style="margin:0 0 10px;font-family:'Young Serif',Georgia,serif;font-size:26px;line-height:1.35;color:#2A2219">&ldquo;${escH(wq.q)}&rdquo;</p>
<p style="margin:0 0 18px;color:#76675A">— ${escH(wq.a)}</p>
<p style="margin:0 0 18px">${escH(wq.n)}</p>
<p style="margin:0 0 18px"><a href="${site}/calendar" style="display:inline-block;background:#2F5A3D;color:#FFFBF5;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">See what's happening this week &rarr;</a></p>
<p style="margin:18px 0 0;font-size:12.5px;color:#76675A">You're getting this because you subscribed at centexhomeschool.org. <a href="${stopQ}" style="color:#76675A">Stop weekly quotes</a> · <a href="${stopAll}" style="color:#76675A">Unsubscribe from everything</a></p>`;
    const text = `This week: ${wq.t}\n\n"${wq.q}"\n— ${wq.a}\n\n${wq.n}\n\nSee what's happening this week: ${site}/calendar\n\nStop weekly quotes: ${stopQ}\nUnsubscribe from everything: ${stopAll}`;
    const ok = await sendMail(env, r.email, `Your weekly homeschool inspiration: ${wq.t}`, text, emailShell(env, inner, `"${wq.q.slice(0, 90)}" — ${wq.a}`).replace(/<tr><td style="padding:6px 30px 22px"><table[\s\S]*?<\/table><\/td><\/tr>/, ""));
    await env.DB.prepare("INSERT OR IGNORE INTO quote_sends (week, email, ok) VALUES (?,?,?)").bind(wq.week, r.email, ok ? 1 : 0).run();
    if (ok) sent++;
  }
  return sent;
}

// ---------- Website availability snapshots ----------
// Every 10 minutes, read a few listing websites and keep the sentences that talk about enrollment,
// waitlists or openings. These only feed a "per their website" placeholder for UNCLAIMED listings,
// set after review; a group's own claimed status always wins.
const AVAIL_WORDS_RE = /(wait\s?-?list|enrol(l)?(ment|ing)?|registration|register now|now accepting|accepting (new )?(students|families|applications)|applications? (are )?(open|closed|due)|open (spots|seats|enrollment|house)|spots? (left|available|remaining|open)|seats? (left|available|remaining)|currently full|is full|sold out|no openings|limited (spots|space|availability)|openings)/i;
async function listingSites(env) {
  const r = await env.ASSETS.fetch(new Request("https://assets.local/listings.js"));
  const txt = await r.text(), out = [];
  for (const line of txt.split("\n")) {
    const n = line.match(/\{n:"([^"]+)"/), site = line.match(/site:"(https?:[^"]+)"/), type = line.match(/type:"([a-z]+)"/);
    if (!n || !site || /test:true/.test(line)) continue;
    const slug = n[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
    out.push({ slug, name: n[1], url: site[1], type: type ? type[1] : "" });
  }
  return out;
}
function pageSnippets(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ");
  const parts = text.split(/(?<=[.!?])\s+/), keep = [];
  for (const p of parts) if (AVAIL_WORDS_RE.test(p) && p.length < 400 && !keep.includes(p.trim())) keep.push(p.trim());
  return keep.slice(0, 8);
}
async function snapshotSites(env, batch = 12) {
  const sites = (await listingSites(env)).filter((s) => !/facebook\.com|instagram\.com|groups\.io/.test(s.url));
  const { results } = await env.DB.prepare("SELECT slug FROM site_snapshots WHERE fetched_at > datetime('now','-14 days')").all();
  const fresh = new Set(results.map((r) => r.slug));
  // Schools and co-ops first; activities after.
  const todo = sites.filter((s) => !fresh.has(s.slug)).sort((a, b) => (a.type === "activity") - (b.type === "activity")).slice(0, batch);
  for (const s of todo) {
    let snippets = [], status = 0, pages = [s.url];
    try {
      const res = await fetch(s.url, { headers: { "user-agent": "CenTexHomeschoolHub/1.0 (+https://centexhomeschool.org)" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
      status = res.status; const html = res.ok ? await res.text() : "";
      snippets = pageSnippets(html);
      // Also read up to two admissions/enrollment pages linked from the home page.
      const links = [...html.matchAll(/href="([^"#]+)"/gi)].map((m) => m[1]).filter((h) => /admission|enrol|register|registration|join|apply|tuition|openings|waitlist/i.test(h)).slice(0, 2);
      for (const h of links) {
        try {
          const u = new URL(h, s.url).toString(); if (pages.includes(u)) continue; pages.push(u);
          const r2 = await fetch(u, { headers: { "user-agent": "CenTexHomeschoolHub/1.0" }, signal: AbortSignal.timeout(8000) });
          if (r2.ok) snippets = snippets.concat(pageSnippets(await r2.text()).map((x) => x + " [" + new URL(u).pathname + "]"));
        } catch {}
      }
    } catch (e) { status = -1; }
    await env.DB.prepare("INSERT INTO site_snapshots (slug, name, url, http_status, snippets, fetched_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(slug) DO UPDATE SET name=excluded.name, url=excluded.url, http_status=excluded.http_status, snippets=excluded.snippets, fetched_at=excluded.fetched_at")
      .bind(s.slug, s.name, s.url, status, JSON.stringify(snippets.slice(0, 12))).run();
  }
  return todo.length;
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") ctx.waitUntil(snapshotSites(env));
    if (event.cron === "0 13 * * *") { ctx.waitUntil(dailyDigest(env)); ctx.waitUntil(monthlyReports(env)); ctx.waitUntil(sendEventReminders(env)); ctx.waitUntil(availReminders(env)); ctx.waitUntil(sendWeeklyQuote(env)); }
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
    if (url.pathname.startsWith("/api/admin/") && url.pathname !== "/api/admin/me" && !(await adminEmail(request, env))) {
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
