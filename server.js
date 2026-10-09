const express = require("express");
const fs = require("fs");
const path = require("path");

// Load environment variables from .env file if present
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  try {
    if (typeof process.loadEnvFile === "function") {
      process.loadEnvFile(envPath);
    } else {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, "$1");
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  } catch (err) {
    console.error("Warning: Could not load .env file:", err.message);
  }
}

const os = require("os");
const crypto = require("crypto");
const QRCode = require("qrcode");

const { open } = require("sqlite");
const sqlite3 = require("sqlite3");

const app = express();

const dbPath = process.env.DB_PATH || path.join(__dirname, "users.db");

const PORT = process.env.PORT || 3000;

// 0 = every scan counts as a visit.
// To ignore repeat scans, set minutes, e.g. 30 = at most one visit per 30 minutes.
const VISIT_COOLDOWN_MINUTES = Number(process.env.VISIT_COOLDOWN_MINUTES ?? 0);

const COOKIE_NAME = "mart_session";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// --- OFFERS: edit these to match your mart. Keep them in order, smallest minVisits first. ---
const OFFERS = [
  {
    minVisits: 1,
    icon: "🎟️",
    headline: "Get 5% OFF",
    text: "Welcome offer: 5% off your bill today.",
  },
  {
    minVisits: 3,
    icon: "🪙",
    headline: "Get 10% OFF",
    text: "Regular customer: 10% off your bill today.",
  },
  {
    minVisits: 5,
    icon: "🎁",
    headline: "Get A Free Gift",
    text: "Loyal customer: collect a free gift at the counter.",
  },
  {
    minVisits: 10,
    icon: "👑",
    headline: "Get 15% OFF",
    text: "VIP customer: 15% off every bill this month.",
  },
];

// claims is a Map of minVisits -> time the reward was claimed
const buildOffers = (visits, claims = new Map()) => {
  const offers = OFFERS.map((offer) => {
    const unlocked = visits >= offer.minVisits;
    const claimedAt = claims.get(offer.minVisits) || null;
    const status = claimedAt ? "claimed" : unlocked ? "available" : "locked";
    return { ...offer, unlocked, claimedAt, status };
  });
  const currentIndex = offers.reduce(
    (last, offer, index) => (offer.unlocked ? index : last),
    -1
  );
  const nextOffer = OFFERS.find((offer) => visits < offer.minVisits);
  const next = nextOffer
    ? { headline: nextOffer.headline, visitsAway: nextOffer.minVisits - visits }
    : null;
  return { offers, currentIndex, next };
};

// SQLite stores "2026-10-07 09:30:00" (UTC). Turn it into a proper date string.
const toIso = (sqliteTime) => `${sqliteTime.replace(" ", "T")}Z`;

// --- Network helpers: find the address a phone should use ---
const getLanAddresses = () => {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      const isV4 = i.family === "IPv4" || i.family === 4;
      if (isV4 && !i.internal && !i.address.startsWith("169.254.")) {
        found.push({ name, address: i.address });
      }
    }
  }
  return found;
};

// Prefer real Wi-Fi adapters, avoid virtual ones (WSL, VMware, VPN...)
const scoreAddress = ({ name, address }) => {
  const n = name.toLowerCase();
  let score = 0;
  if (/wi-?fi|wlan|wireless/.test(n)) score += 3;
  if (/vethernet|vmware|virtualbox|wsl|hyper-v|docker|vpn|tap|tun/.test(n)) score -= 5;
  if (address.startsWith("192.168.")) score += 2;
  else if (address.startsWith("10.")) score += 1;
  return score;
};

// Cleans up PUBLIC_URL: removes spaces and trailing slashes, adds https:// if missing.
const normalizeUrl = (value) => {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const getPublicUrl = () =>
  process.env.PUBLIC_URL?.trim() ||
  process.env.RENDER_EXTERNAL_URL?.trim() ||
  process.env.VERCEL_URL?.trim() ||
  "";

// If PUBLIC_URL is set (tunnel or deployed site), that wins. Works on mobile data.
// Otherwise we use the computer's Wi-Fi address, which only works on the same Wi-Fi.
const getBaseUrl = () => {
  const publicUrl = getPublicUrl();
  if (publicUrl) {
    return normalizeUrl(publicUrl);
  }
  const best = getLanAddresses().sort((a, b) => scoreAddress(b) - scoreAddress(a))[0];
  return `http://${best ? best.address : "localhost"}:${PORT}`;
};

// The QR code points here. Every scan of this link adds one visit.
const getScanUrl = () => `${getBaseUrl()}/scan`;

let db = null;

const createLibsqlDatabase = () => {
  const { createClient } = require("@libsql/client");
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  return {
    async run(sql, args = []) {
      const result = await client.execute({ sql, args });
      return {
        changes: Number(result.rowsAffected),
        lastID: Number(result.lastInsertRowid),
      };
    },
    async get(sql, args = []) {
      const result = await client.execute({ sql, args });
      return result.rows[0];
    },
    async all(sql, args = []) {
      const result = await client.execute({ sql, args });
      return result.rows;
    },
    exec(sql) {
      return client.executeMultiple(sql);
    },
  };
};

const initializeDatabase = async () => {
  if (process.env.VERCEL && (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)) {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required on Vercel.");
  }

  if (process.env.TURSO_DATABASE_URL) {
    db = createLibsqlDatabase();
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });
    await db.run(`PRAGMA foreign_keys = ON;`);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      visit_count   INTEGER NOT NULL DEFAULT 0,
      last_visit_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS claims (
      user_id    INTEGER NOT NULL REFERENCES users(id),
      min_visits INTEGER NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, min_visits)
    );
  `);
};

const databaseReady = initializeDatabase();
app.locals.databaseReady = databaseReady;

// --- Helpers ---
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const getCookie = (request, name) => {
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
};

// Finds the signed-in customer from the cookie (or null).
const getUserFromRequest = async (request) => {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  const user = await db.get(
    `
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?;
    `,
    [hashToken(token)]
  );
  return user || null;
};

// Adds 1 visit. Returns true if it was counted.
const addVisit = async (userId) => {
  const result = await db.run(
    `
    UPDATE users
    SET visit_count = visit_count + 1, last_visit_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND (last_visit_at IS NULL
           OR (julianday('now') - julianday(last_visit_at)) * 1440 >= ?);
    `,
    [userId, VISIT_COOLDOWN_MINUTES]
  );
  return result.changes === 1;
};

// What the page shows: email, visit count, offers and claimed status. Does NOT add a visit.
const getStatus = async (userId) => {
  const user = await db.get(`SELECT * FROM users WHERE id = ?;`, [userId]);
  const rows = await db.all(
    `SELECT min_visits, claimed_at FROM claims WHERE user_id = ?;`,
    [userId]
  );
  const claims = new Map(rows.map((row) => [row.min_visits, toIso(row.claimed_at)]));
  return {
    ok: true,
    email: user.email,
    visits: user.visit_count,
    ...buildOffers(user.visit_count, claims),
  };
};

// --- Middleware ---
// Trust the tunnel / host proxy, so request.secure is true when the visitor used https.
app.set("trust proxy", 1);
app.use(express.json({ limit: "2kb" }));
app.use("/api", (request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});

// --- Test and QR routes ---
app.get("/health", (request, response) => {
  response.type("text").send("OK");
});

app.get("/qr.png", async (request, response) => {
  try {
    const png = await QRCode.toBuffer(getScanUrl(), { width: 600, margin: 2 });
    response.type("png").send(png);
  } catch (e) {
    response.status(500).send("Could not create QR code");
  }
});

app.get("/qr", (request, response) => {
  response.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scan to open</title>
</head>
<body style="font-family:sans-serif;text-align:center;padding:2rem">
  <h1>Scan to open</h1>
  <img src="/qr.png" alt="QR code" width="300" height="300">
  <p>${getScanUrl()}</p>
</body>
</html>`);
});

// --- THE SCAN LINK: every scan adds one visit, then opens the page ---
app.get("/scan", async (request, response) => {
  response.set("Cache-Control", "no-store");
  let counted = false;
  try {
    const user = await getUserFromRequest(request);
    if (user) {
      counted = await addVisit(user.id);
    }
  } catch (e) {
    console.log(`Scan Error: ${e.message}`);
  }
  response.redirect(counted ? "/?counted=1" : "/");
});

app.use(express.static(path.join(__dirname, "public")));

// --- API 1: Sign in with email. Saves the email, remembers this phone, counts this visit. ---
app.post("/api/login", async (request, response) => {
  const email = String(request.body?.email ?? "").trim().toLowerCase();

  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return response.status(400).json({ error: "Enter a valid email address." });
  }

  try {
    await db.run(`INSERT OR IGNORE INTO users (email) VALUES (?);`, [email]);
    const user = await db.get(`SELECT * FROM users WHERE email = ?;`, [email]);

    const token = crypto.randomBytes(32).toString("hex");
    await db.run(
      `INSERT INTO sessions (token_hash, user_id) VALUES (?, ?);`,
      [hashToken(token), user.id]
    );

    response.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.secure, // true on https links (tunnel or hosted site), false on plain http
      maxAge: ONE_YEAR_MS,
    });

    const counted = await addVisit(user.id);
    response.json({ ...(await getStatus(user.id)), newVisit: counted });
  } catch (e) {
    console.log(`Login Error: ${e.message}`);
    response.status(500).json({ error: "Could not save your email. Try again." });
  }
});

// --- API 2: Who is this phone? Returns visits, offers and claims (does not add a visit). ---
app.get("/api/me", async (request, response) => {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      response.clearCookie(COOKIE_NAME);
      return response.status(401).json({
        error: "Not signed in.",
        offers: buildOffers(0).offers,
      });
    }
    response.json(await getStatus(user.id));
  } catch (e) {
    console.log(`Me Error: ${e.message}`);
    response.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// --- API 3: Claim a reward (only works if it is unlocked, and only once) ---
app.post("/api/claim", async (request, response) => {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return response.status(401).json({ error: "Please sign in first." });
    }

    const minVisits = Number(request.body?.minVisits);
    const offer = OFFERS.find((item) => item.minVisits === minVisits);
    if (!offer) {
      return response.status(400).json({ error: "Unknown reward." });
    }
    if (user.visit_count < offer.minVisits) {
      return response.status(400).json({ error: "This reward is not unlocked yet." });
    }

    const result = await db.run(
      `INSERT OR IGNORE INTO claims (user_id, min_visits) VALUES (?, ?);`,
      [user.id, offer.minVisits]
    );

    response.json({ ...(await getStatus(user.id)), justClaimed: result.changes === 1 });
  } catch (e) {
    console.log(`Claim Error: ${e.message}`);
    response.status(500).json({ error: "Could not claim the reward. Try again." });
  }
});

// --- API 4: Sign out ---
app.post("/api/logout", async (request, response) => {
  const token = getCookie(request, COOKIE_NAME);
  try {
    if (token) {
      await db.run(`DELETE FROM sessions WHERE token_hash = ?;`, [hashToken(token)]);
    }
  } catch (e) {
    console.log(`Logout Error: ${e.message}`);
  }
  response.clearCookie(COOKIE_NAME);
  response.json({ ok: true });
});

require("./dashboard")(app, { getDb: () => db, getCookie, OFFERS, toIso });

if (require.main === module) {
  databaseReady
    .then(() => {
      const scanUrl = getScanUrl();
      const isPublic = Boolean(getPublicUrl());
      const server = app.listen(PORT, "0.0.0.0", async () => {
        console.log(`Server Running at http://localhost:${PORT}/`);
        console.log(
          process.env.TURSO_DATABASE_URL
            ? "Database: Turso/libSQL"
            : `Database file: ${dbPath}`
        );
        console.log("");
        console.log("Addresses on this computer:");
        for (const address of getLanAddresses()) {
          console.log(`  http://${address.address}:${PORT}   (${address.name})`);
        }
        console.log("");
        try {
          console.log(await QRCode.toString(scanUrl, { type: "terminal", small: true }));
        } catch (error) {
          console.log(`Could not draw QR code: ${error.message}`);
        }
        console.log(`QR code points to: ${scanUrl}`);
        if (isPublic) {
          console.log("A public URL is set, so this QR code works on mobile data too.");
        } else {
          console.log("No public URL is set, so this QR code works only on the same Wi-Fi.");
          console.log("For mobile data, run a tunnel and set PUBLIC_URL to its https link.");
        }
        console.log(`1) Test on your phone first: ${getBaseUrl()}/health   (should show OK)`);
        console.log(`2) QR image page on your computer: http://localhost:${PORT}/qr`);
        if (isPublic) {
          console.log("3) Admin Dashboard:");
          console.log(`   On this computer: http://localhost:${PORT}/dashboard`);
          console.log(`   Online link:      ${getBaseUrl()}/dashboard`);
        } else {
          console.log("3) Admin Dashboard: http://localhost:${PORT}/dashboard");
        }
      });

      server.on("error", (error) => {
        console.error(`Server Error: ${error.message}`);
        process.exit(1);
      });
    })
    .catch((error) => {
      console.error(`DB Error: ${error.message}`);
      process.exit(1);
    });
}

module.exports = app;


