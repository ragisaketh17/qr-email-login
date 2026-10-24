// dashboard.js - the mart owner's dashboard (MongoDB version).
// server.js loads this file with: require("./dashboard")(app, {...})
const crypto = require("crypto");

module.exports = function addDashboard(app, { getDb, getCookie, getOffers, defaultOffers, toIso }) {
  const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "admin";
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "admin123";
  const DASHBOARD_UTC_OFFSET = Number(process.env.DASHBOARD_UTC_OFFSET_MINUTES ?? 330); // India = 330
  const ADMIN_COOKIE = "mart_admin";

  const ADMIN_TOKEN = crypto
    .createHash("sha256")
    .update(`mart-admin:${DASHBOARD_USERNAME}:${DASHBOARD_PASSWORD}`)
    .digest("hex");

  const sameText = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  const isAdmin = (req) => sameText(getCookie(req, ADMIN_COOKIE) || "", ADMIN_TOKEN);

  const startOfToday = () => {
    const off = DASHBOARD_UTC_OFFSET * 60 * 1000;
    const local = new Date(Date.now() + off);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off);
  };

  const getClaimCounts = async (db) => {
    const rows = await db.claims.aggregate([{ $group: { _id: "$userId", n: { $sum: 1 } } }]).toArray();
    return new Map(rows.map((r) => [String(r._id), r.n]));
  };

  app.use("/admin", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/dashboard", (req, res) => res.redirect("/dashboard.html"));
  app.get("/dashboard/offers", (req, res) => res.redirect("/offers-admin.html"));

  // --- Sign in / out ---
  app.post("/admin/login", (req, res) => {
    const u = String(req.body?.username ?? "").trim();
    const p = String(req.body?.password ?? "");
    if (!u || !p) return res.status(400).json({ error: "Please enter both username and password." });
    if (!sameText(u, DASHBOARD_USERNAME) || !sameText(p, DASHBOARD_PASSWORD)) {
      return res.status(401).json({ error: "Invalid username or password." });
    }
    res.cookie(ADMIN_COOKIE, ADMIN_TOKEN, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true, username: DASHBOARD_USERNAME });
  });

  app.post("/admin/logout", (req, res) => {
    res.clearCookie(ADMIN_COOKIE);
    res.json({ ok: true });
  });

  // --- Offers ---
  const cleanOffers = (input) => {
    if (!Array.isArray(input) || input.length === 0) throw new Error("Add at least one offer.");
    if (input.length > 20) throw new Error("You can have at most 20 offers.");
    const seen = new Set();
    const cleaned = input.map((item, i) => {
      const n = i + 1;
      const minVisits = Number(item?.minVisits);
      const icon = String(item?.icon ?? "").trim().slice(0, 8);
      const headline = String(item?.headline ?? "").trim();
      const text = String(item?.text ?? "").trim();
      if (!Number.isInteger(minVisits) || minVisits < 1 || minVisits > 1000)
        throw new Error(`Offer ${n}: visits must be a whole number from 1 to 1000.`);
      if (seen.has(minVisits)) throw new Error(`Offer ${n}: another offer already uses ${minVisits} visits.`);
      seen.add(minVisits);
      if (!headline || headline.length > 60) throw new Error(`Offer ${n}: the title must be 1 to 60 characters.`);
      if (!text || text.length > 200) throw new Error(`Offer ${n}: the message must be 1 to 200 characters.`);
      return { minVisits, icon: icon || "🎁", headline, text };
    });
    return cleaned.sort((a, b) => a.minVisits - b.minVisits);
  };

  app.get("/admin/offers", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Please sign in." });
    try {
      res.json({ offers: await getOffers() });
    } catch (e) {
      console.log(`Offers Error: ${e.message}`);
      res.status(500).json({ error: "Could not load the offers." });
    }
  });

  app.put("/admin/offers", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Please sign in." });
    let offers;
    try {
      offers = cleanOffers(req.body?.offers);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    try {
      await getDb().settings.updateOne(
        { _id: "offers" },
        { $set: { items: offers, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ ok: true, offers });
    } catch (e) {
      console.log(`Offers Save Error: ${e.message}`);
      res.status(500).json({ error: "Could not save the offers." });
    }
  });

  app.post("/admin/offers/reset", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Please sign in." });
    try {
      await getDb().settings.deleteOne({ _id: "offers" });
      res.json({ ok: true, offers: defaultOffers });
    } catch (e) {
      console.log(`Offers Reset Error: ${e.message}`);
      res.status(500).json({ error: "Could not reset the offers." });
    }
  });

  // --- Dashboard numbers ---
  app.get("/admin/data", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Please sign in." });
    try {
      const db = getDb();
      const OFFERS = await getOffers();
      const todayStart = startOfToday();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [customers, visitSums, newToday, visitedToday, visited7Days, claimed, claimedToday] =
        await Promise.all([
          db.users.countDocuments({}),
          db.users.aggregate([{ $group: { _id: null, total: { $sum: "$visitCount" } } }]).toArray(),
          db.users.countDocuments({ createdAt: { $gte: todayStart } }),
          db.users.countDocuments({ lastVisitAt: { $gte: todayStart } }),
          db.users.countDocuments({ lastVisitAt: { $gte: sevenDaysAgo } }),
          db.claims.countDocuments({}),
          db.claims.countDocuments({ claimedAt: { $gte: todayStart } }),
        ]);

      const offers = [];
      for (const o of OFFERS) {
        const [unlocked, claimedCount] = await Promise.all([
          db.users.countDocuments({ visitCount: { $gte: o.minVisits } }),
          db.claims.countDocuments({ minVisits: o.minVisits }),
        ]);
        offers.push({ minVisits: o.minVisits, headline: o.headline, unlocked, claimed: claimedCount });
      }

      const claimCounts = await getClaimCounts(db);
      const rows = await db.users.find({}).sort({ visitCount: -1, lastVisitAt: -1 }).limit(1000).toArray();
      const customerList = rows.map((r) => ({
        email: r.email,
        visits: Number(r.visitCount),
        claimed: claimCounts.get(String(r._id)) || 0,
        joined: toIso(r.createdAt),
        lastVisit: r.lastVisitAt ? toIso(r.lastVisitAt) : null,
      }));

      const claimRows = await db.claims.find({}).sort({ claimedAt: -1 }).limit(20).toArray();
      const claimUsers = await db.users.find({ _id: { $in: claimRows.map((r) => r.userId) } }).toArray();
      const emailById = new Map(claimUsers.map((u) => [String(u._id), u.email]));
      const recentClaims = claimRows.map((r) => {
        const o = OFFERS.find((x) => x.minVisits === Number(r.minVisits));
        return {
          email: emailById.get(String(r.userId)) || "(deleted user)",
          reward: o ? o.headline : `${r.minVisits} visits`,
          claimedAt: toIso(r.claimedAt),
        };
      });

      res.json({
        adminUser: DASHBOARD_USERNAME,
        summary: {
          customers,
          totalVisits: visitSums[0]?.total ?? 0,
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
      res.status(500).json({ error: "Could not load the dashboard data." });
    }
  });

  // --- NEW: one customer's full history, 1st visit to last ---
  // Needs a "visits" collection: { userId, at } saved on every counted visit.
  app.get("/admin/customer", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Please sign in." });
    try {
      const db = getDb();
      const email = String(req.query.email || "").trim().toLowerCase();
      const user = await db.users.findOne({ email });
      if (!user) return res.status(404).json({ error: "Customer not found." });

      const OFFERS = await getOffers();
      const [visits, claims] = await Promise.all([
        db.visits.find({ userId: user._id }).sort({ at: 1 }).limit(2000).toArray(),
        db.claims.find({ userId: user._id }).sort({ claimedAt: 1 }).toArray(),
      ]);

      res.json({
        email: user.email,
        joined: toIso(user.createdAt),
        firstVisit: visits[0] ? toIso(visits[0].at) : null,
        lastVisit: user.lastVisitAt ? toIso(user.lastVisitAt) : null,
        totalVisits: Number(user.visitCount),
        visits: visits.map((v) => toIso(v.at)),
        claims: claims.map((c) => {
          const o = OFFERS.find((x) => x.minVisits === Number(c.minVisits));
          return { reward: o ? o.headline : `${c.minVisits} visits`, claimedAt: toIso(c.claimedAt) };
        }),
      });
    } catch (e) {
      console.log(`Customer Error: ${e.message}`);
      res.status(500).json({ error: "Could not load this customer." });
    }
  });

  // --- CSV export ---
  app.get("/admin/export.csv", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send("Please sign in on the dashboard first.");
    try {
      const db = getDb();
      const claimCounts = await getClaimCounts(db);
      const rows = await db.users.find({}).sort({ visitCount: -1, lastVisitAt: -1 }).toArray();

      const cell = (v) => {
        let t = String(v ?? "");
        if (/^[=+\-@]/.test(t)) t = `'${t}`;
        return `"${t.replace(/"/g, '""')}"`;
      };

      const lines = ["Email,Visits,Rewards claimed,Last visit (UTC),Joined (UTC)"];
      for (const r of rows) {
        lines.push(
          [
            r.email,
            r.visitCount,
            claimCounts.get(String(r._id)) || 0,
            r.lastVisitAt ? toIso(r.lastVisitAt) : "",
            toIso(r.createdAt),
          ].map(cell).join(",")
        );
      }

      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="mart-customers.csv"');
      res.send(lines.join("\r\n"));
    } catch (e) {
      console.log(`Export Error: ${e.message}`);
      res.status(500).send("Could not create the file.");
    }
  });
};
