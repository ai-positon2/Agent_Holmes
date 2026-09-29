// Client Feedback Agent, standalone. Two different answers to "there's no
// Claude `mcp` capability out here":
// - Slack: our own OAuth app (single tenant -- one grant, whoever authorizes
//   it), same live Slack Web API calls the original page made via MCP.
// - Google (Drive + Gmail): getting a Google Cloud OAuth client through IT
//   was enough friction that we mirror it instead -- a scheduled task in
//   this project's own Claude Code session (which already has Drive/Gmail
//   connectors authorized) pulls meeting docs, the Budget Tracker, and
//   recent email on a schedule and pushes it here via /api/feedback/seed.
//   These tools read that mirror, not a live Google API.
// Either way, the Anthropic tool-use loop that ties it together runs here
// server-side, replacing window.claude.use("sample")'s client-side loop.
"use strict";

const SLACK_SCOPES = "search:read,channels:history,groups:history,im:history,mpim:history,channels:read,groups:read";

function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "\n...(truncated)" : s;
}

module.exports = function mountFeedback(app, db) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
  const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
  const SEED_SECRET = process.env.SEED_SECRET;

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

  async function slackAccessToken() {
    const row = await db.getToken("slack");
    return row ? row.access_token : null;
  }

  // ---- status ---------------------------------------------------------------

  app.get("/api/feedback/status", async (_req, res) => {
    if (!db.pool) { res.json({ slack: "unknown", google: null }); return; }
    try {
      const [slack, googleSync] = await Promise.all([db.getToken("slack"), db.getFeedbackSyncStatus()]);
      res.json({ slack: slack ? "connected" : "unknown", google: googleSync });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Fail-closed like Pacing Desk's seed route: reuses SEED_SECRET (same
  // trust boundary, same operator) rather than adding yet another secret.
  app.post("/api/feedback/seed", async (req, res) => {
    if (!db.pool) { res.status(503).json({ error: "DATABASE_URL is not configured on this server." }); return; }
    if (!SEED_SECRET || req.get("x-seed-secret") !== SEED_SECRET) { res.status(403).json({ error: "Forbidden." }); return; }
    try {
      await db.seedFeedback(req.body || {});
      res.json({ ok: true });
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

  // ---- Google-touching tools, against the daily-synced mirror in Postgres --
  // (a scheduled task pushes this via /api/feedback/seed -- see the module
  // comment at the top of this file for why there's no live Google API here)

  async function tGetMeetingTranscript(input) {
    if (!db.pool) return "The meeting-notes mirror isn't configured on this server.";
    const keyword = String(input.keyword || "").trim();
    const docs = await db.listMeetingDocs();
    if (!docs.length) return "No meeting-transcript documents have been synced yet.";
    const candidates = docs.slice(0, 2);

    const tokens = keyword.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    const allTitles = [];
    const scored = [];
    for (const f of candidates) {
      const text = String(f.content || "");
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
    return "No meeting matching \"" + keyword + "\" found in the most recently synced transcript doc(s). " +
      "Meetings that WERE found: " + truncate(allTitles.join(" | "), 1500) +
      " -- try calling this again with a keyword closer to one of those titles.";
  }

  async function tGetBudgetSnapshot(input) {
    if (!db.pool) return "The Budget Tracker mirror isn't configured on this server.";
    const client = String(input.client || "").trim();
    let text = await db.getBudgetTrackerContent();
    if (!text) return "The Budget Tracker hasn't been synced yet.";
    if (client) {
      const lines = text.split("\n").filter((l) => l.toLowerCase().includes(client.toLowerCase()));
      if (lines.length) text = lines.join("\n");
    }
    return truncate(text, 5000);
  }

  async function tSearchEmail(input) {
    if (!db.pool) return "The email mirror isn't configured on this server.";
    const rows = await db.searchEmails(String(input.query || ""));
    if (!rows.length) return "No synced emails matched that search (search only covers the last scheduled sync, not live Gmail).";
    return truncate(JSON.stringify(rows, null, 2), 5000);
  }

  async function tReadEmail(input) {
    if (!db.pool) return "The email mirror isn't configured on this server.";
    const row = await db.getEmailByThreadId(String(input.thread_id || ""));
    if (!row) return "That thread ID isn't in the synced email mirror.";
    return truncate(
      "From: " + row.sender + "\nDate: " + row.date + "\nSubject: " + row.subject + "\n\n" + row.body, 5000
    );
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
      description: "Find and read a meeting transcript from Position2's daily meeting-notes Drive folder, as of the last scheduled sync (not live). Give a client name or topic keyword; returns the matching meeting section(s) (title, date, full transcript) from the most recently synced daily doc(s), or a list of meeting titles found if nothing matches the keyword.",
      input_schema: { type: "object", properties: { keyword: { type: "string", description: "Client name or topic to find, e.g. 'Riccobene' or 'Beta Bionics'" } }, required: ["keyword"] } },
    { name: "get_budget_snapshot",
      description: "Read Position2's Budget Tracker sheet (allocated budgets, target CPA/ROAS, status, channel per account), as of the last scheduled sync. Optionally filter to rows mentioning one client.",
      input_schema: { type: "object", properties: { client: { type: "string", description: "Client or account name to filter to, e.g. 'Eventgroove'. Omit for the whole sheet." } } } },
    { name: "search_email",
      description: "Plain keyword search over a daily-synced mirror of recent email (not live Gmail, and no Gmail search operators -- just a substring match against subject/sender/snippet/body). Returns compact results: subject, sender, date, snippet, and thread ID for follow-up reads.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "read_email",
      description: "Read the full plain-text content of one synced email thread, given a thread ID from search_email.",
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
