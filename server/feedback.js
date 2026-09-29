// Client Feedback Agent, standalone: our own Slack + Google OAuth (single
// tenant -- one Slack grant, one Google grant, matching the original page's
// "reads with your own access" framing) and our own Anthropic tool-use loop,
// replacing what window.claude.use("sample"/"mcp") did inside Claude's
// Artifact sandbox.
"use strict";

const MEETING_FOLDER_ID = "1hc1fPOHKsUNGbqBClcb4G7qwa5T38KYf";
const BUDGET_TRACKER_ID = "1X_HjD0NUzp1br9SsLV7AICdS_SokdYuzbXc75ENVJ7A";

const SLACK_SCOPES = "search:read,channels:history,groups:history,im:history,mpim:history,channels:read,groups:read";
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly";

function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "\n...(truncated)" : s;
}

module.exports = function mountFeedback(app, db) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
  const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  // Server-to-Server OAuth -- an account-level credential, not a per-user
  // grant, so there's no /auth/zoom/start flow and nothing stored in
  // oauth_tokens for it: just fetch (and cache) an access token whenever
  // it's needed, the same way client_credentials works elsewhere.
  const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
  const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
  const ZOOM_USER_ID = process.env.ZOOM_USER_ID; // whose recordings to search -- S2S has no "me"

  function baseUrl(req) {
    return req.protocol + "://" + req.get("host");
  }

  // ---- OAuth: Slack -------------------------------------------------------

  app.get("/auth/slack/start", (req, res) => {
    if (!SLACK_CLIENT_ID) { res.status(503).send("SLACK_CLIENT_ID is not configured on this server."); return; }
    const redirectUri = baseUrl(req) + "/auth/slack/callback";
    const url = "https://slack.com/oauth/v2/authorize?client_id=" + encodeURIComponent(SLACK_CLIENT_ID) +
      "&user_scope=" + encodeURIComponent(SLACK_SCOPES) +
      "&redirect_uri=" + encodeURIComponent(redirectUri);
    res.redirect(url);
  });

  app.get("/auth/slack/callback", async (req, res) => {
    if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) { res.status(503).send("Slack OAuth is not configured on this server."); return; }
    const code = req.query.code;
    if (!code) { res.status(400).send("Missing 'code' from Slack."); return; }
    try {
      const redirectUri = baseUrl(req) + "/auth/slack/callback";
      const params = new URLSearchParams({
        client_id: SLACK_CLIENT_ID, client_secret: SLACK_CLIENT_SECRET,
        code: String(code), redirect_uri: redirectUri,
      });
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params,
      });
      const data = await tokenRes.json();
      if (!data.ok || !data.authed_user || !data.authed_user.access_token) {
        res.status(502).send("Slack authorization failed: " + (data.error || "unknown error"));
        return;
      }
      await db.setToken("slack", {
        accessToken: data.authed_user.access_token,
        meta: { userId: data.authed_user.id, team: data.team && data.team.name },
      });
      res.redirect("/client_feedback_agent.html?connected=slack");
    } catch (e) {
      res.status(500).send("Slack authorization failed: " + String((e && e.message) || e));
    }
  });

  // ---- OAuth: Google (covers both Drive and Gmail) -------------------------

  app.get("/auth/google/start", (req, res) => {
    if (!GOOGLE_CLIENT_ID) { res.status(503).send("GOOGLE_CLIENT_ID is not configured on this server."); return; }
    const redirectUri = baseUrl(req) + "/auth/google/callback";
    const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID) +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&response_type=code&access_type=offline&prompt=consent" +
      "&scope=" + encodeURIComponent(GOOGLE_SCOPES);
    res.redirect(url);
  });

  app.get("/auth/google/callback", async (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) { res.status(503).send("Google OAuth is not configured on this server."); return; }
    const code = req.query.code;
    if (!code) { res.status(400).send("Missing 'code' from Google."); return; }
    try {
      const redirectUri = baseUrl(req) + "/auth/google/callback";
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        code: String(code), redirect_uri: redirectUri, grant_type: "authorization_code",
      });
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params,
      });
      const data = await tokenRes.json();
      if (!tokenRes.ok || !data.access_token) {
        res.status(502).send("Google authorization failed: " + (data.error_description || data.error || "unknown error"));
        return;
      }
      if (!data.refresh_token) {
        // Google only issues a refresh_token on first consent. Re-consenting
        // (prompt=consent, already set above) fixes a stale grant; this path
        // only fires if that somehow still didn't happen.
        res.status(502).send("Google didn't return a refresh token -- revoke this app's access at myaccount.google.com/permissions and try connecting again.");
        return;
      }
      await db.setToken("google", {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
      });
      res.redirect("/client_feedback_agent.html?connected=google");
    } catch (e) {
      res.status(500).send("Google authorization failed: " + String((e && e.message) || e));
    }
  });

  async function googleAccessToken() {
    const row = await db.getToken("google");
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60000) {
      return row.access_token;
    }
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: row.refresh_token, grant_type: "refresh_token",
    });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params,
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) throw new Error("Google token refresh failed: " + (data.error_description || data.error || tokenRes.status));
    await db.setToken("google", {
      accessToken: data.access_token,
      refreshToken: row.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    });
    return data.access_token;
  }

  async function slackAccessToken() {
    const row = await db.getToken("slack");
    return row ? row.access_token : null;
  }

  // ---- Zoom: Server-to-Server OAuth (account_credentials grant) -----------
  let zoomTokenCache = null; // { token, expiresAt } -- in-memory only, no per-user grant to persist

  async function zoomAccessToken() {
    if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) return null;
    if (zoomTokenCache && zoomTokenCache.expiresAt > Date.now() + 60000) return zoomTokenCache.token;
    const basic = Buffer.from(ZOOM_CLIENT_ID + ":" + ZOOM_CLIENT_SECRET).toString("base64");
    const res = await fetch(
      "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=" + encodeURIComponent(ZOOM_ACCOUNT_ID),
      { method: "POST", headers: { Authorization: "Basic " + basic } }
    );
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error("Zoom token request failed: " + (data.reason || data.error || res.status));
    zoomTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return data.access_token;
  }

  // WebVTT -> plain text: drop the header, cue-index lines, and timestamp
  // lines, keep only the spoken text.
  function vttToText(vtt) {
    return String(vtt || "").split("\n")
      .filter((line) => line.trim() && line.trim() !== "WEBVTT" && !/-->/.test(line) && !/^\d+$/.test(line.trim()))
      .join(" ").replace(/\s+/g, " ").trim();
  }

  // Returns transcript text for the best-matching recent Zoom recording, or
  // null if Zoom isn't configured / nothing matched -- tGetMeetingTranscript
  // falls back to Drive in either case.
  async function findZoomTranscript(keyword) {
    const token = await zoomAccessToken();
    if (!token || !ZOOM_USER_ID) return null;
    const params = new URLSearchParams({ page_size: "30" });
    const res = await fetch(
      "https://api.zoom.us/v2/users/" + encodeURIComponent(ZOOM_USER_ID) + "/recordings?" + params,
      { headers: { Authorization: "Bearer " + token } }
    );
    const data = await res.json();
    if (!res.ok) throw new Error("Zoom recordings list failed: " + (data.message || res.status));
    const meetings = data.meetings || [];
    if (!meetings.length) return null;

    const tokens = keyword.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    const scored = meetings.map((mtg) => {
      const topic = String(mtg.topic || "").toLowerCase();
      const score = tokens.length ? tokens.filter((t) => topic.includes(t)).length : 0;
      return { mtg, score };
    });
    scored.sort((a, b) => b.score - a.score || new Date(b.mtg.start_time) - new Date(a.mtg.start_time));
    const best = tokens.length ? scored.find((s) => s.score > 0) : scored[0];
    if (!best) return null;

    const files = best.mtg.recording_files || [];
    const transcriptFile = files.find((f) => f.file_type === "TRANSCRIPT");
    if (!transcriptFile) return null;
    const fileRes = await fetch(transcriptFile.download_url, { headers: { Authorization: "Bearer " + token } });
    if (!fileRes.ok) throw new Error("Zoom transcript download failed: " + fileRes.status);
    const vtt = await fileRes.text();
    return "Meeting: " + best.mtg.topic + " (" + best.mtg.start_time + ")\n\n" + vttToText(vtt);
  }

  // ---- status -------------------------------------------------------------

  app.get("/api/feedback/status", async (_req, res) => {
    const zoomConfigured = !!(ZOOM_ACCOUNT_ID && ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET && ZOOM_USER_ID);
    if (!db.pool) { res.json({ slack: "unknown", google: "unknown", zoom: zoomConfigured ? "configured" : "not configured" }); return; }
    try {
      const [slack, google] = await Promise.all([db.getToken("slack"), db.getToken("google")]);
      res.json({
        slack: slack ? "connected" : "unknown", google: google ? "connected" : "unknown",
        zoom: zoomConfigured ? "configured" : "not configured",
      });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // ---- the 6 tools, against real REST APIs instead of MCP ------------------

  async function tSearchSlack(input) {
    const token = await slackAccessToken();
    if (!token) return "Slack isn't connected yet.";
    const params = new URLSearchParams({
      query: String(input.query || ""), count: "20",
      sort: input.sort === "relevance" ? "score" : "timestamp", sort_dir: "desc",
    });
    const res = await fetch("https://slack.com/api/search.messages?" + params, {
      headers: { Authorization: "Bearer " + token },
    });
    const data = await res.json();
    if (!data.ok) return "Slack search failed: " + (data.error || res.status);
    const matches = (data.messages && data.messages.matches) || [];
    if (!matches.length) return "No Slack messages matched that search.";
    const text = matches.map((m) => {
      const chan = m.channel ? ("#" + m.channel.name + " (ID: " + m.channel.id + ")") : "unknown channel";
      return "Channel: " + chan + " | " + (m.username || m.user || "unknown") + " | " + m.ts + "\n" + (m.text || "");
    }).join("\n\n");
    return truncate(text, 6000);
  }

  async function tReadSlackChannel(input) {
    const token = await slackAccessToken();
    if (!token) return "Slack isn't connected yet.";
    const params = new URLSearchParams({
      channel: String(input.channel_id || ""),
      limit: String(Math.min(Number(input.limit) || 30, 50)),
    });
    const res = await fetch("https://slack.com/api/conversations.history?" + params, {
      headers: { Authorization: "Bearer " + token },
    });
    const data = await res.json();
    if (!data.ok) return "Reading that channel failed: " + (data.error || res.status);
    const msgs = data.messages || [];
    const text = msgs.map((m) => (m.user || "unknown") + " | " + m.ts + "\n" + (m.text || "")).join("\n\n");
    return truncate(text || "No messages found.", 5000);
  }

  async function driveExport(fileId, mimeType, accessToken) {
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/files/" + fileId + "/export?mimeType=" + encodeURIComponent(mimeType),
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    if (!res.ok) throw new Error("Drive export failed: " + res.status + " " + (await res.text()).slice(0, 300));
    return res.text();
  }

  async function tGetMeetingTranscript(input) {
    const keyword = String(input.keyword || "").trim();

    try {
      const zoomHit = await findZoomTranscript(keyword);
      if (zoomHit) return truncate(zoomHit, 16000);
    } catch (e) {
      // Zoom misconfigured or the API call failed -- fall through to Drive
      // rather than surface a Zoom-specific error for what's still a
      // meeting-transcript question.
      console.error("Zoom transcript lookup failed, falling back to Drive:", e);
    }

    const token = await googleAccessToken();
    if (!token) return "Google isn't connected yet.";
    const params = new URLSearchParams({
      q: "'" + MEETING_FOLDER_ID + "' in parents and trashed = false",
      orderBy: "modifiedTime desc", pageSize: "10", fields: "files(id,name,modifiedTime)",
    });
    const listRes = await fetch("https://www.googleapis.com/drive/v3/files?" + params, {
      headers: { Authorization: "Bearer " + token },
    });
    const listing = await listRes.json();
    const files = listing.files || [];
    if (!files.length) return "No meeting-transcript documents found in the Meeting Notes folder yet.";
    const candidates = files.slice(0, 2);

    const tokens = keyword.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    const allTitles = [];
    const scored = [];
    for (const f of candidates) {
      const text = await driveExport(f.id, "text/plain", token);
      const marks = [];
      const re = /Meeting:\s*([^\n]+)/g;
      let m;
      while ((m = re.exec(text))) marks.push({ idx: m.index, title: m[1].trim() });
      for (let i = 0; i < marks.length; i++) {
        const start = marks[i].idx;
        const end = i + 1 < marks.length ? marks[i + 1].idx : text.length;
        const section = text.slice(start, end);
        const title = marks[i].title;
        allTitles.push(title);
        if (!tokens.length) { scored.push({ section, titleScore: 0, len: section.length }); continue; }
        const titleLc = title.toLowerCase(), bodyLc = section.toLowerCase();
        const titleScore = tokens.filter((t) => titleLc.includes(t)).length;
        const bodyScore = tokens.filter((t) => bodyLc.includes(t)).length;
        if (titleScore > 0 || bodyScore > 0) scored.push({ section: section.trim(), titleScore, len: section.length });
      }
    }
    if (scored.length) {
      scored.sort((a, b) => ((b.titleScore > 0) - (a.titleScore > 0)) || (b.len - a.len));
      return truncate(scored.slice(0, 2).map((s) => s.section).join("\n\n---\n\n"), 16000);
    }
    return "No meeting matching \"" + keyword + "\" found in the most recent transcript doc(s). " +
      "Meetings that WERE found: " + truncate(allTitles.join(" | "), 1500) +
      " -- try calling this again with a keyword closer to one of those titles.";
  }

  async function tGetBudgetSnapshot(input) {
    const token = await googleAccessToken();
    if (!token) return "Google isn't connected yet.";
    const client = String(input.client || "").trim();
    let text = await driveExport(BUDGET_TRACKER_ID, "text/csv", token);
    if (client) {
      const lines = text.split("\n").filter((l) => l.toLowerCase().includes(client.toLowerCase()));
      if (lines.length) text = lines.join("\n");
    }
    return truncate(text, 5000);
  }

  function decodeGmailPart(data) {
    return Buffer.from(String(data || ""), "base64").toString("utf-8");
  }
  function findPlainTextBody(payload) {
    if (!payload) return "";
    if (payload.mimeType === "text/plain" && payload.body && payload.body.data) return decodeGmailPart(payload.body.data);
    for (const part of payload.parts || []) {
      const found = findPlainTextBody(part);
      if (found) return found;
    }
    if (payload.body && payload.body.data) return decodeGmailPart(payload.body.data);
    return "";
  }
  function header(headers, name) {
    const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : "";
  }

  async function tSearchEmail(input) {
    const token = await googleAccessToken();
    if (!token) return "Google isn't connected yet.";
    const params = new URLSearchParams({ q: String(input.query || ""), maxResults: "8" });
    const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?" + params, {
      headers: { Authorization: "Bearer " + token },
    });
    const listing = await listRes.json();
    const msgs = listing.messages || [];
    const compact = [];
    for (const m of msgs) {
      const mRes = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + m.id +
          "?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date",
        { headers: { Authorization: "Bearer " + token } }
      );
      const msg = await mRes.json();
      compact.push({
        threadId: msg.threadId, subject: header(msg.payload && msg.payload.headers, "Subject"),
        from: header(msg.payload && msg.payload.headers, "From"),
        date: header(msg.payload && msg.payload.headers, "Date"),
        snippet: (msg.snippet || "").slice(0, 200),
      });
    }
    if (!compact.length) return "No emails matched that search.";
    return truncate(JSON.stringify(compact, null, 2), 5000);
  }

  async function tReadEmail(input) {
    const token = await googleAccessToken();
    if (!token) return "Google isn't connected yet.";
    const threadId = String(input.thread_id || "");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/threads/" + threadId + "?format=full", {
      headers: { Authorization: "Bearer " + token },
    });
    const data = await res.json();
    if (!data.messages) return "Couldn't read that thread: " + (data.error && data.error.message || res.status);
    const text = data.messages.map((m) => {
      const h = m.payload && m.payload.headers;
      return "From: " + header(h, "From") + "\nDate: " + header(h, "Date") + "\nSubject: " + header(h, "Subject") +
        "\n\n" + (findPlainTextBody(m.payload) || m.snippet || "");
    }).join("\n\n====\n\n");
    return truncate(text, 5000);
  }

  const TOOL_IMPL = {
    search_slack: tSearchSlack, read_slack_channel: tReadSlackChannel,
    get_meeting_transcript: tGetMeetingTranscript, get_budget_snapshot: tGetBudgetSnapshot,
    search_email: tSearchEmail, read_email: tReadEmail,
  };

  const TOOLS_SPEC = [
    { name: "search_slack",
      description: "Search Slack messages across every channel and DM the viewer can see, newest first by default. Returns up to 20 matching messages with channel, author, timestamp, and text. Add after:/before:/during: to the query for date-bounded questions -- plain keyword search alone can miss in-range messages that just aren't the top relevance match. Call more than once with different phrasings for a broad question; this returns pointers to check further, not necessarily the whole conversation.",
      input_schema: { type: "object", properties: {
        query: { type: "string", description: "Slack search terms, optionally with modifiers like in:#channel-name, from:@user, after:2026-09-07" },
        sort: { type: "string", enum: ["recent", "relevance"], description: "'recent' (default) for newest-first, best for 'what's been discussed lately' questions; 'relevance' to rank by match quality instead." },
      }, required: ["query"] } },
    { name: "read_slack_channel",
      description: "Read the recent message history of one Slack channel, given its channel ID (find one via search_slack first -- results show 'Channel: #name (ID: Cxxxx)').",
      input_schema: { type: "object", properties: { channel_id: { type: "string" }, limit: { type: "number", description: "Max messages, default 30" } }, required: ["channel_id"] } },
    { name: "get_meeting_transcript",
      description: "Find and read a meeting transcript. Checks Zoom's own cloud recordings first (live, when configured) for a matching meeting's real transcript, then falls back to Position2's daily meeting-notes Drive folder if Zoom has nothing. Give a client name or topic keyword; returns the matching meeting's transcript (title, date, full text), or a list of meeting titles found if nothing matches the keyword.",
      input_schema: { type: "object", properties: { keyword: { type: "string", description: "Client name or topic to find, e.g. 'Riccobene' or 'Beta Bionics'" } }, required: ["keyword"] } },
    { name: "get_budget_snapshot",
      description: "Read Position2's Budget Tracker sheet (allocated budgets, target CPA/ROAS, status, channel per account). Optionally filter to rows mentioning one client.",
      input_schema: { type: "object", properties: { client: { type: "string", description: "Client or account name to filter to, e.g. 'Eventgroove'. Omit for the whole sheet." } } } },
    { name: "search_email",
      description: "Search the viewer's Gmail using Gmail search syntax (from:, to:, subject:, after:, newer_than:, etc). Returns compact results: subject, sender, date, snippet, and thread ID for follow-up reads.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "read_email",
      description: "Read the full plain-text content of one email thread, given a thread ID from search_email.",
      input_schema: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
  ];

  function instructions() {
    return "You are the Client Feedback Agent, an internal tool for Position2's PPC " +
      "team. An account manager is asking you questions about their clients. " +
      "Answer using the tools provided -- search before you answer anything " +
      "that depends on real data, never guess a number, a name, or a date. " +
      "Today's date is " + new Date().toISOString().slice(0, 10) + ". " +
      "When a question names no specific meeting or date ('the last meeting', " +
      "'this week'), use get_meeting_transcript or search tools to find " +
      "candidates, then pick the most recent one yourself unless it's " +
      "genuinely ambiguous (e.g. two different clients could match) -- in " +
      "that case ask a short clarifying question instead of guessing.\n\n" +
      "Be thorough before you answer a broad question ('what's been said about " +
      "X', 'what happened this week'): one search call is rarely the full " +
      "picture. Add an after:/before:/during: date filter to search_slack when " +
      "the question names a timeframe -- plain keyword search sorts by " +
      "relevance and silently drops in-range messages that just scored lower. " +
      "Search more than once with different phrasings (a client's name, a " +
      "product name, a person's name if one is mentioned) and, for anything " +
      "that looks like the main channel for the topic, follow up with " +
      "read_slack_channel to get that channel's actual full recent discussion " +
      "instead of relying on a handful of top search hits -- a search result " +
      "is a pointer to check further, not the complete conversation. Only " +
      "write the answer once you're confident you've seen what happened, not " +
      "just what one search call happened to surface.\n\n" +
      "Write answers as a synthesized summary in your own words -- what " +
      "happened, what was decided, what's still open -- grouped by topic or " +
      "outcome. Do not write it as a list of 'Person said: quote' log lines; " +
      "quote someone directly only when their exact wording matters (a number, " +
      "a commitment, a deadline). Keep it tight and scannable: short " +
      "paragraphs or a few bullets, no filler preamble. Say plainly when a " +
      "tool found nothing, rather than inventing an answer.";
  }

  async function callClaude(messages) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2048, system: instructions(), messages, tools: TOOLS_SPEC }),
    });
    if (!res.ok) throw new Error("Anthropic API error " + res.status + ": " + (await res.text()).slice(0, 300));
    return res.json();
  }

  async function runToolLoop(userMessages) {
    const toolsUsed = [];
    let messages = userMessages.slice();
    for (let round = 0; round < 6; round++) {
      const result = await callClaude(messages);
      const blocks = result.content || [];
      if (result.stop_reason !== "tool_use") {
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        return { text, toolsUsed };
      }
      messages.push({ role: "assistant", content: blocks });
      const toolResults = [];
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        toolsUsed.push(block.name);
        let content;
        try {
          const impl = TOOL_IMPL[block.name];
          content = impl ? await impl(block.input || {}) : "Unknown tool " + block.name;
        } catch (e) {
          content = "Error: " + String((e && e.message) || e);
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: String(content) });
      }
      messages.push({ role: "user", content: toolResults });
    }
    return { text: "Reached the tool-call limit for this question -- try breaking it into smaller parts.", toolsUsed };
  }

  app.post("/api/feedback/chat", async (req, res) => {
    if (!ANTHROPIC_API_KEY) { res.status(503).json({ error: "ANTHROPIC_API_KEY is not configured on this server." }); return; }
    const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];
    const message = req.body && req.body.message;
    if (typeof message !== "string" || !message.trim()) { res.status(400).json({ error: "Missing 'message' in request body." }); return; }
    try {
      const messages = [...history, { role: "user", content: message }];
      const { text, toolsUsed } = await runToolLoop(messages);
      res.json({ text, toolsUsed: Array.from(new Set(toolsUsed)) });
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) });
    }
  });
};
