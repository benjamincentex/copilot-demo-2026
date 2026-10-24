CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, name TEXT, town TEXT, website TEXT, contact TEXT, email TEXT, details TEXT, availability TEXT, registration_opens TEXT, status TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, source TEXT, listing TEXT, answers TEXT, created_at TEXT DEFAULT (datetime('now')), unsubscribed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, listing_slug TEXT NOT NULL, listing TEXT, town TEXT, status_at_signup TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(email, listing_slug));
CREATE TABLE IF NOT EXISTS demand (id INTEGER PRIMARY KEY AUTOINCREMENT, town TEXT, age TEXT, faith TEXT, want TEXT, interest TEXT, matches INTEGER, local_matches INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS listing_overrides (slug TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT);
CREATE TABLE IF NOT EXISTS listing_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, listing TEXT, town TEXT, fields TEXT NOT NULL, prev_avail TEXT, editor_name TEXT, editor_email TEXT, role TEXT, status TEXT DEFAULT 'pending', alerts_queued INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, listing TEXT, kind TEXT, subject TEXT, body TEXT, status TEXT DEFAULT 'queued', created_at TEXT DEFAULT (datetime('now')), sent_at TEXT);
CREATE TABLE IF NOT EXISTS clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, listing_slug TEXT, kind TEXT, created_at TEXT DEFAULT (datetime('now')));
-- Group leader accounts (email sign-in)
CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0, used INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS listing_owners (slug TEXT NOT NULL, email TEXT NOT NULL, name TEXT, role TEXT, approved_at TEXT, PRIMARY KEY (slug, email));
CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, listing TEXT, town TEXT, email TEXT NOT NULL, name TEXT, role TEXT, note TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT);
