// Postgres-backed replacement for the Claude Artifact's shared `db`
// capability, scoped to what Pacing Desk actually reads and writes:
//   snapshots/<date>                 -> pacing_snapshots
//   snapshots/<date>/clients/<slug>  -> pacing_snapshot_clients
//   meta/latest                      -> pacing_meta
//   moves/<id>                       -> pacing_moves
"use strict";

const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pacing_snapshots (
      date TEXT PRIMARY KEY,
      meta JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacing_snapshot_clients (
      date TEXT NOT NULL REFERENCES pacing_snapshots(date) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY (date, slug)
    );
    CREATE TABLE IF NOT EXISTS pacing_meta (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacing_moves (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      loc TEXT,
      from_campaign TEXT,
      to_campaign TEXT,
      amt NUMERIC,
      applied BOOLEAN NOT NULL DEFAULT false,
      applied_at TEXT
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      meta JSONB
    );
    CREATE TABLE IF NOT EXISTS feedback_meeting_docs (
      id TEXT PRIMARY KEY,
      name TEXT,
      modified_time TIMESTAMPTZ,
      content TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback_budget_tracker (
      id INTEGER PRIMARY KEY DEFAULT 1,
      content TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback_emails (
      thread_id TEXT PRIMARY KEY,
      subject TEXT,
      sender TEXT,
      date TEXT,
      snippet TEXT,
      body TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback_sync_meta (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
}

async function listSnapshots() {
  const { rows } = await pool.query(
    "SELECT date, meta FROM pacing_snapshots ORDER BY date ASC"
  );
  return rows.map((r) => Object.assign({ id: r.date }, r.meta));
}

async function getSnapshotMeta(date) {
  const { rows } = await pool.query(
    "SELECT meta FROM pacing_snapshots WHERE date = $1",
    [date]
  );
  return rows.length ? rows[0].meta : null;
}

async function getSnapshotClients(date) {
  const { rows } = await pool.query(
    "SELECT data FROM pacing_snapshot_clients WHERE date = $1 ORDER BY slug ASC",
    [date]
  );
  return rows.map((r) => r.data);
}

async function getLatest() {
  const { rows } = await pool.query(
    "SELECT value FROM pacing_meta WHERE key = 'latest'"
  );
  return rows.length ? rows[0].value : null;
}

async function listMoves(date) {
  const { rows } = await pool.query(
    `SELECT id, date, loc, from_campaign AS "from", to_campaign AS "to",
            amt, applied, applied_at AS "appliedAt"
     FROM pacing_moves WHERE date = $1`,
    [date]
  );
  return rows;
}

async function upsertMove(id, payload) {
  await pool.query(
    `INSERT INTO pacing_moves (id, date, loc, from_campaign, to_campaign, amt, applied, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       date = EXCLUDED.date, loc = EXCLUDED.loc,
       from_campaign = EXCLUDED.from_campaign, to_campaign = EXCLUDED.to_campaign,
       amt = EXCLUDED.amt, applied = EXCLUDED.applied, applied_at = EXCLUDED.applied_at`,
    [id, payload.date, payload.loc, payload.from, payload.to, payload.amt, payload.applied, payload.appliedAt]
  );
}

// One transaction: replace a whole day's snapshot + client rows, and point
// meta/latest at it. Mirrors dashboard/build_seed.js's shape exactly, just
// against Postgres instead of the Claude Artifact's db.
async function seedDay({ meta, clients, latest }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO pacing_snapshots (date, meta) VALUES ($1, $2)
       ON CONFLICT (date) DO UPDATE SET meta = EXCLUDED.meta`,
      [meta.asOf, meta]
    );
    await client.query("DELETE FROM pacing_snapshot_clients WHERE date = $1", [meta.asOf]);
    for (const c of clients) {
      await client.query(
        "INSERT INTO pacing_snapshot_clients (date, slug, data) VALUES ($1, $2, $3)",
        [meta.asOf, c.id, c.data]
      );
    }
    await client.query(
      `INSERT INTO pacing_meta (key, value) VALUES ('latest', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [latest]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Single-tenant token store -- one row per provider ("slack", "google"),
// holding whichever human authorized that connector (matches the original
// Client Feedback Agent's "reads with your own access" framing).
async function getToken(provider) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at, meta FROM oauth_tokens WHERE provider = $1",
    [provider]
  );
  return rows.length ? rows[0] : null;
}

async function setToken(provider, { accessToken, refreshToken, expiresAt, meta }) {
  await pool.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, meta)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
       expires_at = EXCLUDED.expires_at,
       meta = EXCLUDED.meta`,
    [provider, accessToken, refreshToken || null, expiresAt || null, meta || null]
  );
}

// Client Feedback Agent's Google mirror: a scheduled task (running with this
// project's own already-authorized Drive/Gmail connectors, outside Railway
// entirely) pulls a bounded slice of meeting docs / the Budget Tracker /
// recent email and pushes it here, since Railway has no Google OAuth app of
// its own. One transaction replaces the whole mirror each sync.
async function seedFeedback({ meetingDocs, budgetTracker, emails }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM feedback_meeting_docs");
    for (const d of meetingDocs || []) {
      await client.query(
        "INSERT INTO feedback_meeting_docs (id, name, modified_time, content) VALUES ($1, $2, $3, $4)",
        [d.id, d.name, d.modifiedTime, d.content]
      );
    }
    await client.query(
      `INSERT INTO feedback_budget_tracker (id, content) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
      [budgetTracker || ""]
    );
    await client.query("DELETE FROM feedback_emails");
    for (const e of emails || []) {
      await client.query(
        `INSERT INTO feedback_emails (thread_id, subject, sender, date, snippet, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.threadId, e.subject, e.sender, e.date, e.snippet, e.body]
      );
    }
    await client.query(
      `INSERT INTO feedback_sync_meta (key, value) VALUES ('last_sync', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ at: new Date().toISOString(), meetingDocs: (meetingDocs || []).length, emails: (emails || []).length })]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getFeedbackSyncStatus() {
  const { rows } = await pool.query("SELECT value FROM feedback_sync_meta WHERE key = 'last_sync'");
  return rows.length ? rows[0].value : null;
}

async function listMeetingDocs() {
  const { rows } = await pool.query(
    "SELECT id, name, modified_time AS \"modifiedTime\", content FROM feedback_meeting_docs ORDER BY modified_time DESC"
  );
  return rows;
}

async function getBudgetTrackerContent() {
  const { rows } = await pool.query("SELECT content FROM feedback_budget_tracker WHERE id = 1");
  return rows.length ? rows[0].content : null;
}

async function searchEmails(query) {
  const like = "%" + String(query || "") + "%";
  const { rows } = await pool.query(
    `SELECT thread_id AS "threadId", subject, sender, date, snippet FROM feedback_emails
     WHERE subject ILIKE $1 OR sender ILIKE $1 OR body ILIKE $1 OR snippet ILIKE $1
     ORDER BY date DESC LIMIT 8`,
    [like]
  );
  return rows;
}

async function getEmailByThreadId(threadId) {
  const { rows } = await pool.query(
    "SELECT thread_id AS \"threadId\", subject, sender, date, body FROM feedback_emails WHERE thread_id = $1",
    [threadId]
  );
  return rows.length ? rows[0] : null;
}

module.exports = {
  pool, ensureSchema, listSnapshots, getSnapshotMeta, getSnapshotClients,
  getLatest, listMoves, upsertMove, seedDay, getToken, setToken,
  seedFeedback, getFeedbackSyncStatus, listMeetingDocs, getBudgetTrackerContent,
  searchEmails, getEmailByThreadId,
};
