//server.js
import express from "express";
import dotenv from "dotenv";
import isUrl from "is-url";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
console.log("→ EJS will look for templates in:", app.get("views"));

const port = process.env.PORT || 3000;
const router = express.Router();
const startTime = Date.now();

// Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize database table
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        code VARCHAR(8) UNIQUE NOT NULL,
        url TEXT NOT NULL,
        clicks INT DEFAULT 0,
        last_clicked TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("Database table created/verified");
  } catch (err) {
    console.error("DB init error:", err.message);
    process.exit(1);
  }
}

initDb();

// Helper to generate random code
function generateCode(len = 6) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < len; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
router.get("/_ping", (req, res) => res.send("ok-debug"));

router.get("/_test-html", (req, res) => {
  // quick check that rendering and routing works without EJS
  res.send("<html><body><h1>test html OK</h1></body></html>");
});

router.get("/", (req, res) => {
  // log the incoming request so you can see it in the terminal
  console.log(
    `GET /  from ${req.ip}  — headers: ${JSON.stringify(req.headers.host)}`
  );

  // render with a callback to catch template errors
  res.render("dashboard");
});

// ============ GET ALL LINKS (API) ============

router.get("/api/links", async (req, res) => {
  try {
    const { search } = req.query;
    let query = "SELECT code, url, clicks, last_clicked, created_at FROM links";
    let params = [];

    if (search) {
      query += " WHERE code ILIKE $1 OR url ILIKE $1";
      params.push(`%${search}%`);
    }

    query += " ORDER BY created_at DESC";

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// ============ CREATE SHORT URL ============
router.post("/api/links", async (req, res) => {
  try {
    const { url, code: customCode } = req.body;

    // Validate URL
    if (!url || !isUrl(url)) {
      return res.status(400).json({ error: "Invalid or missing URL" });
    }

    let code;

    // If custom code provided, use it
    if (customCode) {
      // Validate custom code format (6-8 chars, alphanumeric)
      if (!/^[A-Za-z0-9]{6,8}$/.test(customCode)) {
        return res
          .status(400)
          .json({ error: "Code must be 6-8 chars [A-Za-z0-9]" });
      }
      // Check if code already exists in DB
      const { rowCount } = await pool.query(
        "SELECT 1 FROM links WHERE code = $1",
        [customCode]
      );
      if (rowCount > 0) {
        return res.status(409).json({ error: "Code already in use" });
      }
      code = customCode;
    } else {
      // Generate random code
      let found = false;
      for (let i = 0; i < 10; i++) {
        code = generateCode();
        const { rowCount } = await pool.query(
          "SELECT 1 FROM links WHERE code = $1",
          [code]
        );
        if (rowCount === 0) {
          found = true;
          break;
        }
      }
      if (!found) {
        return res
          .status(500)
          .json({ error: "Unable to generate unique code" });
      }
    }

    // Store in database
    await pool.query(
      "INSERT INTO links (code, url, clicks, last_clicked) VALUES ($1, $2, $3, $4)",
      [code, url, 0, null]
    );

    // Build full short URL
    const domain = `${req.protocol}://${req.get("host")}`;
    const fullUrl = `${domain}/${code}`;

    return res.status(201).json({ code, fullUrl, url, clicks: 0 });
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// ============ DELETE SHORT URL ============
router.delete("/api/links/:code", async (req, res) => {
  try {
    const { code } = req.params;

    const { rowCount } = await pool.query("DELETE FROM links WHERE code = $1", [
      code,
    ]);

    if (rowCount === 0) {
      return res.status(404).json({ error: "Short URL not found" });
    }

    return res.json({ message: "Short URL deleted" });
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// ============ STATS PAGE - GET SINGLE LINK DETAILS ============
router.get("/stats/:code", async (req, res) => {
  try {
    const { code } = req.params;

    const { rows } = await pool.query(
      "SELECT code, url, clicks, last_clicked, created_at FROM links WHERE code = $1",
      [code]
    );

    if (!rows.length) {
      return res.status(404).render("404", { message: "Short URL not found" });
    }

    const link = rows[0];
    const fullShortUrl = `${req.protocol}://${req.get("host")}/${link.code}`;
    res.render("stats", { link, fullShortUrl });
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).send("Server error");
  }
});

// ============ HEALTHCHECK ============
router.get("/health", (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const uptimeString = `${Math.floor(uptime / 3600)}h ${Math.floor(
    (uptime % 3600) / 60
  )}m ${uptime % 60}s`;

  return res.json({
    status: "OK",
    uptime: uptimeString,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    database: "Connected to Neon",
  });
});

// ============ REDIRECT BY CODE (increment clicks) ============
router.get("/:code", async (req, res) => {
  try {
    const { code } = req.params;

    // Skip redirects for known routes
    if (code === "api" || code === "stats" || code === "health") {
      return res.status(404).send("Not found");
    }

    const { rows } = await pool.query(
      "SELECT url FROM links WHERE code = $1 LIMIT 1",
      [code]
    );

    if (!rows.length) {
      return res.status(404).send("Short URL not found");
    }

    // Increment clicks and update last_clicked
    await pool.query(
      "UPDATE links SET clicks = clicks + 1, last_clicked = NOW() WHERE code = $1",
      [code]
    );

    return res.redirect(rows[0].url);
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).send("Server error");
  }
});

app.use("/", router);

app.listen(1337, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
