// dashboard.js - the mart owner's dashboard.
// server.js loads this file with ONE line (see Step 3).
const crypto = require("crypto");

module.exports = function addDashboard(app, { getDb, getCookie, OFFERS, toIso }) {
  const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "admin";
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "admin123";

  // Minutes your timezone is ahead of UTC. India = 330. Used to decide what "today" means.
  const DASHBOARD_UTC_OFFSET = Number(process.env.DASHBOARD_UTC_OFFSET_MINUTES ?? 330);

  const ADMIN_COOKIE = "mart_admin";

  // The cookie value that proves "this browser typed the right credentials"
  const ADMIN_TOKEN = crypto
    .createHash("sha256")
    .update(`mart-admin:${DASHBOARD_USERNAME}:${DASHBOARD_PASSWORD}`)
    .digest("hex");

  // Compares two texts safely (takes the same time whether they match or not)
  const sameText = (a, b) => {
    const first = Buffer.from(String(a));
    const second = Buffer.from(String(b));
    return first.length === second.length && crypto.timingSafeEqual(first, second);
  };

  // Is this request from a signed-in owner?
  const isAdmin = (request) =>
    sameText(getCookie(request, ADMIN_COOKIE) || "", ADMIN_TOKEN);

  // Database helpers that work with both the SQLite and the Turso version
  const adminAll = async (sql, args = []) => {
    const db = getDb();
    if (typeof db.all === "function") return db.all(sql, args); // sqlite package
    return (await db.execute({ sql, args })).rows;               // Turso client
  };
  const adminOne = async (sql, args = []) => (await adminAll(sql, args))[0] || null;

  // Never let the browser keep a copy of dashboard data
  app.use("/admin", (request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  // Short link: /dashboard opens the dashboard page
  app.get("/dashboard", (request, response) => response.redirect("/dashboard.html"));

  // --- Sign in with Username and Password ---
  app.post("/admin/login", (request, response) => {
    const inputUsername = String(request.body?.username ?? "").trim();
    const inputPassword = String(request.body?.password ?? "");

    if (!inputUsername || !inputPassword) {
      return response
        .status(400)
        .json({ error: "Please enter both username and password." });
    }

    const validUsername = sameText(inputUsername, DASHBOARD_USERNAME);
    const validPassword = sameText(inputPassword, DASHBOARD_PASSWORD);

    if (!validUsername || !validPassword) {
      return response.status(401).json({ error: "Invalid username or password." });
    }

    response.cookie(ADMIN_COOKIE, ADMIN_TOKEN, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.secure,
      maxAge: 12 * 60 * 60 * 1000, // stays signed in for 12 hours
    });
    response.json({ ok: true, username: DASHBOARD_USERNAME });
  });

  // --- Sign out ---
  app.post("/admin/logout", (request, response) => {
    response.clearCookie(ADMIN_COOKIE);
    response.json({ ok: true });
  });

  // --- All the numbers for the dashboard ---
  app.get("/admin/data", async (request, response) => {
    if (!isAdmin(request)) {
      return response.status(401).json({ error: "Please sign in." });
    }

    try {
      // Turns 330 into "+330 minutes" so SQLite can shift UTC times to your local day
      const shift = `${DASHBOARD_UTC_OFFSET >= 0 ? "+" : ""}${DASHBOARD_UTC_OFFSET} minutes`;

      // 1) The cards at the top
      const totals = await adminOne(
        `SELECT
           COUNT(*) AS customers,
           COALESCE(SUM(visit_count), 0) AS totalVisits,
           COALESCE(SUM(CASE WHEN date(created_at, ?) = date('now', ?) THEN 1 ELSE 0 END), 0) AS newToday,
           COALESCE(SUM(CASE WHEN last_visit_at IS NOT NULL
                             AND date(last_visit_at, ?) = date('now', ?) THEN 1 ELSE 0 END), 0) AS visitedToday,
           COALESCE(SUM(CASE WHEN last_visit_at IS NOT NULL
                             AND last_visit_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) AS visited7Days
         FROM users`,
        [shift, shift, shift, shift]
      );

      const claimTotals = await adminOne(
        `SELECT
           COUNT(*) AS claimed,
           COALESCE(SUM(CASE WHEN date(claimed_at, ?) = date('now', ?) THEN 1 ELSE 0 END), 0) AS claimedToday
         FROM claims`,
        [shift, shift]
      );

      // 2) One row per reward: how many unlocked it, how many claimed it
      const offers = [];
      for (const offer of OFFERS) {
        const unlocked = await adminOne(
          "SELECT COUNT(*) AS n FROM users WHERE visit_count >= ?",
          [offer.minVisits]
        );
        const claimed = await adminOne(
          "SELECT COUNT(*) AS n FROM claims WHERE min_visits = ?",
          [offer.minVisits]
        );
        offers.push({
          minVisits: offer.minVisits,
          headline: offer.headline,
          unlocked: Number(unlocked.n),
          claimed: Number(claimed.n),
        });
      }

      // 3) The customers table (most visits first)
      const customerRows = await adminAll(
        `SELECT u.email,
                u.visit_count AS visits,
                u.created_at AS joined,
                u.last_visit_at AS lastVisit,
                (SELECT COUNT(*) FROM claims c WHERE c.user_id = u.id) AS claimed
         FROM users u
         ORDER BY u.visit_count DESC, u.last_visit_at DESC
         LIMIT 1000`
      );
      const customers = customerRows.map((row) => ({
        email: row.email,
        visits: Number(row.visits),
        claimed: Number(row.claimed),
        joined: toIso(row.joined),
        lastVisit: row.lastVisit ? toIso(row.lastVisit) : null,
      }));

      // 4) The 20 most recent claims
      const claimRows = await adminAll(
        `SELECT u.email, c.min_visits AS minVisits, c.claimed_at AS claimedAt
         FROM claims c
         JOIN users u ON u.id = c.user_id
         ORDER BY c.claimed_at DESC
         LIMIT 20`
      );
      const recentClaims = claimRows.map((row) => {
        const offer = OFFERS.find((item) => item.minVisits === Number(row.minVisits));
        return {
          email: row.email,
          reward: offer ? offer.headline : `${row.minVisits} visits`,
          claimedAt: toIso(row.claimedAt),
        };
      });

      response.json({
        adminUser: DASHBOARD_USERNAME,
        summary: {
          customers: Number(totals.customers),
          totalVisits: Number(totals.totalVisits),
          newToday: Number(totals.newToday),
          visitedToday: Number(totals.visitedToday),
          visited7Days: Number(totals.visited7Days),
          claimed: Number(claimTotals.claimed),
          claimedToday: Number(claimTotals.claimedToday),
        },
        offers,
        customers,
        recentClaims,
      });
    } catch (e) {
      console.log(`Dashboard Error: ${e.message}`);
      response.status(500).json({ error: "Could not load the dashboard data." });
    }
  });

  // --- Download all customers as a CSV file (opens in Excel) ---
  app.get("/admin/export.csv", async (request, response) => {
    if (!isAdmin(request)) {
      return response.status(401).send("Please sign in on the dashboard first.");
    }

    try {
      const rows = await adminAll(
        `SELECT u.email,
                u.visit_count AS visits,
                u.created_at AS joined,
                u.last_visit_at AS lastVisit,
                (SELECT COUNT(*) FROM claims c WHERE c.user_id = u.id) AS claimed
         FROM users u
         ORDER BY u.visit_count DESC`
      );

      // Wrap each value in quotes. A leading ' stops Excel from running anything like =1+1
      const cell = (value) => {
        let text = String(value ?? "");
        if (/^[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
      };

      const lines = ["Email,Visits,Rewards claimed,Last visit (UTC),Joined (UTC)"];
      for (const row of rows) {
        lines.push(
          [row.email, row.visits, row.claimed, row.lastVisit, row.joined].map(cell).join(",")
        );
      }

      response.set("Content-Type", "text/csv; charset=utf-8");
      response.set("Content-Disposition", 'attachment; filename="mart-customers.csv"');
      response.send(lines.join("\r\n"));
    } catch (e) {
      console.log(`Export Error: ${e.message}`);
      response.status(500).send("Could not create the file.");
    }
  });
};