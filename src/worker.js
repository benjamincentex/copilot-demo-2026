// CenTex Homeschool Hub — API for the directory site.
// Static pages are served from /public; everything under /api/ runs here.
// Admin routes (/api/admin/*) only answer for the email in ADMIN_EMAIL, as
// verified by Cloudflare Access (the Cf-Access-Authenticated-User-Email header).

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const bad = (message, status = 400) => json({ error: message }, status);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const AVAIL = new Set(["open", "waitlist", "full", "opens", "unknown"]);

async function body(request) {
  try { return await request.json(); } catch { return null; }
}

function adminEmail(request, env) {
  const who = (request.headers.get("cf-access-authenticated-user-email") || "").toLowerCase();
  const allowed = (env.ADMIN_EMAIL || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return who && allowed.includes(who) ? who : null;
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

const routes = {
  // ---------- public ----------
  "GET /api/listings": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT slug, data FROM listing_overrides").all();
    const out = {};
    for (const r of results) { try { out[r.slug] = JSON.parse(r.data); } catch {} }
    return json({ overrides: out });
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

  "POST /api/listing-edits": async (req, env) => {
    const b = await body(req); if (!b) return bad("Invalid request.");
    const slug = clip(b.slug, 120), email = clip(b.editorEmail, 160), name = clip(b.editorName, 80);
    if (!slug) return bad("Pick your listing.");
    if (!name) return bad("Add your name.");
    if (!EMAIL_RE.test(email)) return bad("Add a valid email address.");
    const f = b.fields || {}, fields = {};
    for (const [k, n] of [["d", 600], ["ages", 40], ["sched", 80], ["cost", 80], ["site", 300]]) { const v = clip(f[k], n); if (v) fields[k] = v; }
    if (fields.site && !/^https?:\/\//i.test(fields.site)) delete fields.site;
    const a = f.avail || {};
    fields.avail = { s: AVAIL.has(a.s) ? a.s : "unknown", when: clip(a.when, 40) };
    await env.DB.prepare("INSERT INTO listing_edits (slug, listing, town, fields, prev_avail, editor_name, editor_email, role) VALUES (?,?,?,?,?,?,?,?)")
      .bind(slug, clip(b.listing, 140), clip(b.town, 60), JSON.stringify(fields), clip(b.prevAvail, 20), name, email, clip(b.role, 60)).run();
    return json({ ok: true });
  },

  "POST /api/click": async (req, env) => {
    const b = await body(req); if (!b) return json({ ok: true });
    await env.DB.prepare("INSERT INTO clicks (listing_slug, kind) VALUES (?,?)").bind(clip(b.slug, 120), clip(b.kind, 20)).run();
    return json({ ok: true });
  },

  // ---------- admin (owner only, via Cloudflare Access) ----------
  "GET /api/admin/me": async (req, env) => json({ admin: !!adminEmail(req, env) }),

  "GET /api/admin/edits": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT * FROM listing_edits WHERE status='pending' ORDER BY id DESC LIMIT 200").all();
    return json({ edits: results.map((r) => ({ ...r, fields: JSON.parse(r.fields || "{}") })) });
  },

  "POST /api/admin/edits/approve": async (req, env) => {
    const b = await body(req); const id = Number(b && b.id); if (!id) return bad("Missing id.");
    const ed = await env.DB.prepare("SELECT * FROM listing_edits WHERE id=? AND status='pending'").bind(id).first();
    if (!ed) return bad("That update was already handled.", 404);
    const fields = JSON.parse(ed.fields || "{}");
    const prevRow = await env.DB.prepare("SELECT data FROM listing_overrides WHERE slug=?").bind(ed.slug).first();
    const prev = prevRow ? JSON.parse(prevRow.data) : {};
    const merged = { ...prev, ...fields, claimed: true };
    const now = new Date().toISOString();
    const stmts = [
      env.DB.prepare("INSERT INTO listing_overrides (slug, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slug) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by")
        .bind(ed.slug, JSON.stringify(merged), now, ed.editor_name),
    ];
    let queued = 0;
    const av = fields.avail || {}, wasS = (prev.avail && prev.avail.s) || ed.prev_avail, wasWhen = (prev.avail && prev.avail.when) || "";
    if ((av.s === "open" || av.s === "opens") && (av.s !== wasS || (av.when || "") !== wasWhen)) {
      const { results } = await env.DB.prepare("SELECT DISTINCT email FROM alerts WHERE listing_slug=?").bind(ed.slug).all();
      const mail = alertEmail(ed.listing, ed.town, av, env.SITE_URL || "https://centexhomeschool.org");
      for (const r of results) {
        stmts.push(env.DB.prepare("INSERT INTO outbox (to_email, listing, kind, subject, body) VALUES (?,?,?,?,?)")
          .bind(r.email, ed.listing, av.s === "open" ? "opening" : "registration", mail.subject, mail.body));
        queued++;
      }
    }
    stmts.push(env.DB.prepare("UPDATE listing_edits SET status='approved', reviewed_at=?, alerts_queued=? WHERE id=?").bind(now, queued, id));
    await env.DB.batch(stmts);
    return json({ ok: true, queued });
  },

  "POST /api/admin/edits/reject": async (req, env) => {
    const b = await body(req); const id = Number(b && b.id); if (!id) return bad("Missing id.");
    await env.DB.prepare("UPDATE listing_edits SET status='rejected', reviewed_at=? WHERE id=?").bind(new Date().toISOString(), id).run();
    return json({ ok: true });
  },

  "GET /api/admin/summary": async (req, env) => {
    const one = (sql) => env.DB.prepare(sql).first();
    const [subs, alerts, subm, outbox, quizzes] = await Promise.all([
      one("SELECT COUNT(DISTINCT email) AS n FROM subscribers WHERE unsubscribed_at IS NULL"),
      one("SELECT COUNT(*) AS n FROM alerts"),
      one("SELECT COUNT(*) AS n FROM submissions WHERE status='new'"),
      one("SELECT COUNT(*) AS n FROM outbox WHERE status='queued'"),
      one("SELECT COUNT(*) AS n FROM demand"),
    ]);
    const { results: gaps } = await env.DB.prepare(
      "SELECT town, faith, want, COUNT(*) AS n FROM demand WHERE local_matches=0 GROUP BY town, faith, want ORDER BY n DESC LIMIT 10"
    ).all();
    const { results: newSubs } = await env.DB.prepare("SELECT * FROM submissions WHERE status='new' ORDER BY id DESC LIMIT 50").all();
    return json({ subscribers: subs.n, alerts: alerts.n, newSubmissions: subm.n, queuedEmails: outbox.n, quizzes: quizzes.n, gaps, submissions: newSubs });
  },
};

export default {
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
