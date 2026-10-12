// dashboard.js - the mart owner's dashboard (MongoDB version).
// server.js loads this file with one line: require("./dashboard")(app, {...})
const crypto = require("crypto");

module.exports = function addDashboard(app, { getDb, getCookie, getOffers, defaultOffers, toIso }) {
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

  // The moment "today" started in your timezone, as a UTC Date
  const startOfToday = () => {
    const offsetMs = DASHBOARD_UTC_OFFSET * 60 * 1000;
    const local = new Date(Date.now() + offsetMs);
    return new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMs
    );
  };

  // Map of userId -> how many rewards that customer claimed
  const getClaimCounts = async (db) => {
    const rows = await db.claims
      .aggregate([{ $group: { _id: "$userId", n: { $sum: 1 } } }])
      .toArray();
    return new Map(rows.map((row) => [String(row._id), row.n]));
  };

  // Never let the browser keep a copy of dashboard data
  app.use("/admin", (request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  // Short link: /dashboard opens the dashboard page
  app.get("/dashboard", (request, response) => response.redirect("/dashboard.html"));

  // Short link: /dashboard/offers opens the page where the owner edits the offers
  app.get("/dashboard/offers", (request, response) => response.redirect("/offers-admin.html"));

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

  // --- Checks and cleans the offers the owner typed. Throws a readable message if something is wrong. ---
  const cleanOffers = (input) => {
    if (!Array.isArray(input) || input.length === 0) {
      throw new Error("Add at least one offer.");
    }
    if (input.length > 20) {
      throw new Error("You can have at most 20 offers.");
    }
    const seen = new Set();
    const cleaned = input.map((item, index) => {
      const number = index + 1;
      const minVisits = Number(item?.minVisits);
      const icon = String(item?.icon ?? "").trim().slice(0, 8);
      const headline = String(item?.headline ?? "").trim();
      const text = String(item?.text ?? "").trim();

      if (!Number.isInteger(minVisits) || minVisits < 1 || minVisits > 1000) {
        throw new Error(`Offer ${number}: visits must be a whole number from 1 to 1000.`);
      }
      if (seen.has(minVisits)) {
        throw new Error(`Offer ${number}: another offer already uses ${minVisits} visits.`);
      }
      seen.add(minVisits);
      if (!headline || headline.length > 60) {
        throw new Error(`Offer ${number}: the title must be 1 to 60 characters.`);
      }
      if (!text || text.length > 200) {
        throw new Error(`Offer ${number}: the message must be 1 to 200 characters.`);
      }
      return { minVisits, icon: icon || "🎁", headline, text };
    });
    return cleaned.sort((a, b) => a.minVisits - b.minVisits);
  };

  // --- Offers: read, save, and reset to the built-in defaults ---
  app.get("/admin/offers", async (request, response) => {
    if (!isAdmin(request)) {
      return response.status(401).json({ error: "Please sign in." });
    }
    try {
      response.json({ offers: await getOffers() });
    } catch (e) {
      console.log(`Offers Error: ${e.message}`);
      response.status(500).json({ error: "Could not load the offers." });
    }
  });

  app.put("/admin/offers", async (request, response) => {
    if (!isAdmin(request)) {
      return response.status(401).json({ error: "Please sign in." });
    }
    let offers;
    try {
      offers = cleanOffers(request.body?.offers);
    } catch (e) {
      return response.status(400).json({ error: e.message });
    }
    try {
      await getDb().settings.updateOne(
        { _id: "offers" },
        { $set: { items: offers, updatedAt: new Date() } },
        { upsert: true }
      );
      response.json({ ok: true, offers });
    } catch (e) {
      console.log(`Offers Save Error: ${e.message}`);
      response.status(500).json({ error: "Could not save the offers." });
    }
  });

  app.post("/admin/offers/reset", async (request, response) => {
    if (!isAdmin(request)) {
      return response.status(401).json({ error: "Please sign in." });
    }
    try {
      await getDb().settings.deleteOne({ _id: "offers" });
      response.json({ ok: true, offers: defaultOffers });
    } catch (e) {
      console.log(`Offers Reset Error: ${e.message}`);
      response.status(500).json({ error: "Could not reset the offers." });
    }
  });

  // --- All the numbers for the dashboard ---
  app.get("/admin/data", async (request, response) => {
    if (!isAdmin(request)) {
      return response.status(401).json({ error: "Please sign in." });
    }

    try {
      const db = getDb();
      const OFFERS = await getOffers();
      const todayStart = startOfToday();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // 1) The cards at the top
      const [
        customers,
        visitSums,
        newToday,
        visitedToday,
        visited7Days,
        claimed,
        claimedToday,
      ] = await Promise.all([
        db.users.countDocuments({}),
        db.users
          .aggregate([{ $group: { _id: null, total: { $sum: "$visitCount" } } }])
          .toArray(),
        db.users.countDocuments({ createdAt: { $gte: todayStart } }),
        db.users.countDocuments({ lastVisitAt: { $gte: todayStart } }),
        db.users.countDocuments({ lastVisitAt: { $gte: sevenDaysAgo } }),
        db.claims.countDocuments({}),
        db.claims.countDocuments({ claimedAt: { $gte: todayStart } }),
      ]);
      const totalVisits = visitSums[0]?.total ?? 0;

      // 2) One row per reward: how many unlocked it, how many claimed it
      const offers = [];
      for (const offer of OFFERS) {
        const [unlocked, claimedCount] = await Promise.all([
          db.users.countDocuments({ visitCount: { $gte: offer.minVisits } }),
          db.claims.countDocuments({ minVisits: offer.minVisits }),
        ]);
        offers.push({
          minVisits: offer.minVisits,
          headline: offer.headline,
          unlocked,
          claimed: claimedCount,
        });
      }

      // 3) The customers table (most visits first)
      const claimCounts = await getClaimCounts(db);
      const customerRows = await db.users
        .find({})
        .sort({ visitCount: -1, lastVisitAt: -1 })
        .limit(1000)
        .toArray();
      const customerList = customerRows.map((row) => ({
        email: row.email,
        visits: Number(row.visitCount),
        claimed: claimCounts.get(String(row._id)) || 0,
        joined: toIso(row.createdAt),
        lastVisit: row.lastVisitAt ? toIso(row.lastVisitAt) : null,
      }));

      // 4) The 20 most recent claims
      const claimRows = await db.claims.find({}).sort({ claimedAt: -1 }).limit(20).toArray();
      const claimUsers = await db.users
        .find({ _id: { $in: claimRows.map((row) => row.userId) } })
        .toArray();
      const emailById = new Map(claimUsers.map((user) => [String(user._id), user.email]));
      const recentClaims = claimRows.map((row) => {
        const offer = OFFERS.find((item) => item.minVisits === Number(row.minVisits));
        return {
          email: emailById.get(String(row.userId)) || "(deleted user)",
          reward: offer ? offer.headline : `${row.minVisits} visits`,
          claimedAt: toIso(row.claimedAt),
        };
      });

      response.json({
        adminUser: DASHBOARD_USERNAME,
        summary: {
          customers,
          totalVisits,
          newToday,
          visitedToday,
          visited7Days,
          claimed,
          claimedToday,
        },
        offers,
        customers: customerList,
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
      const db = getDb();
      const claimCounts = await getClaimCounts(db);
      const rows = await db.users
        .find({})
        .sort({ visitCount: -1, lastVisitAt: -1 })
        .toArray();

      // Wrap each value in quotes. A leading ' stops Excel from running anything like =1+1
      const cell = (value) => {
        let text = String(value ?? "");
        if (/^[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
      };

      const lines = ["Email,Visits,Rewards claimed,Last visit (UTC),Joined (UTC)"];
      for (const row of rows) {
        lines.push(
          [
            row.email,
            row.visitCount,
            claimCounts.get(String(row._id)) || 0,
            row.lastVisitAt ? toIso(row.lastVisitAt) : "",
            toIso(row.createdAt),
          ]
            .map(cell)
            .join(",")
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
