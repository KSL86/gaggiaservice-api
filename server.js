// ═══════════════════════════════════════════════════════════
// Battericentralen Service System — Backend API
// Express + PostgreSQL + JWT + bcrypt
// Deploy on Render.com as Web Service
// ═══════════════════════════════════════════════════════════

require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();

app.use(cors({
  origin: [
    "https://gaggiaservice.no",
    "https://www.gaggiaservice.no",
    "http://localhost:3000",
  ],
  credentials: true,
}));
app.use(express.json());

// ─── Database ───
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Config ───
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const JWT_EXPIRES = "8h";
const SALT_ROUNDS = 10;

// ─── Notification config (optional) ───
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const RESEND_KEY = process.env.RESEND_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Battericentralen <service@battericentralen.no>";

let twilio = null;
let resend = null;

if (TWILIO_SID && TWILIO_TOKEN) {
  twilio = require("twilio")(TWILIO_SID, TWILIO_TOKEN);
  console.log("✅ Twilio ready");
}

if (RESEND_KEY) {
  const { Resend } = require("resend");
  resend = new Resend(RESEND_KEY);
  console.log("✅ Resend ready");
}

// ─── Helpers ───
const genServiceNr = () =>
  "SRV-" +
  Date.now().toString(36).slice(-4).toUpperCase() +
  crypto.randomBytes(2).toString("hex").toUpperCase();

function sendError(res, status, msg, extra = {}) {
  return res.status(status).json({ error: msg, ...extra });
}

function normalizeText(v) {
  return (v || "").toString().trim().replace(/\s+/g, " ");
}

function normalizeDescription(v) {
  return normalizeText(v).toLowerCase();
}

async function findRecentAdminDuplicate(client, customerId, machineId, description) {
  const { rows } = await client.query(
    `SELECT id, service_nr, created_at
       FROM orders
      WHERE customer_id = $1
        AND machine_id = $2
        AND deleted_at IS NULL
        AND created_at >= NOW() - INTERVAL '5 minutes'
      ORDER BY created_at DESC
      LIMIT 10`,
    [customerId, machineId]
  );

  const normalized = normalizeDescription(description);
  return rows.find((row) => normalizeDescription(row.description) === normalized) || null;
}

async function findRecentPortalDuplicate(client, payload) {
  const { name, phone, email, model_code, serial, description } = payload;
  const { rows } = await client.query(
    `SELECT o.id, o.service_nr, o.created_at, o.description
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN machines m ON m.id = o.machine_id
      WHERE o.deleted_at IS NULL
        AND o.created_at >= NOW() - INTERVAL '10 minutes'
        AND LOWER(COALESCE(c.name, '')) = LOWER($1)
        AND LOWER(COALESCE(m.model_code, '')) = LOWER($2)
        AND LOWER(COALESCE(m.serial, '')) = LOWER($3)
        AND (
          ($4 <> '' AND regexp_replace(COALESCE(c.phone, ''), '\\s+', '', 'g') = regexp_replace($4, '\\s+', '', 'g'))
          OR ($5 <> '' AND LOWER(COALESCE(c.email, '')) = LOWER($5))
        )
      ORDER BY o.created_at DESC
      LIMIT 10`,
    [
      normalizeText(name),
      normalizeText(model_code),
      normalizeText(serial),
      normalizeText(phone),
      normalizeText(email),
    ]
  );

  const normalized = normalizeDescription(description);
  return rows.find((row) => normalizeDescription(row.description) === normalized) || null;
}

const STATUS_MSGS = {
  registered: "Vi har registrert din servicehenvendelse. Send eller lever maskinen til oss.",
  received: "Vi har mottatt maskinen din på verkstedet.",
  diagnosing: "Teknikeren undersøker nå maskinen for å finne feilen.",
  awaiting_parts: "Vi har funnet feilen og venter på reservedeler.",
  in_repair: "Maskinen er nå under reparasjon.",
  testing: "Reparasjonen er utført og maskinen testes.",
  ready: "Maskinen din er ferdig og klar til henting!",
  sent_to_customer: "Maskinen er sendt tilbake til deg.",
  delivered: "Takk for at du brukte oss!",
};

// ═══════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return sendError(res, 401, "Ikke autorisert");
  }

  try {
    req.admin = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return sendError(res, 401, "Ugyldig eller utløpt token");
  }
}

// ═══════════════════════════════════════
// INIT — Create tables + default admin
// ═══════════════════════════════════════
async function initDB() {
  const schema = fs.readFileSync(__dirname + "/schema.sql", "utf8");
  await pool.query(schema);

  const { rows } = await pool.query("SELECT id FROM admin_users LIMIT 1");
  if (rows.length === 0) {
    const hash = await bcrypt.hash("battericentralen2025", SALT_ROUNDS);
    await pool.query(
      "INSERT INTO admin_users (username, password_hash, name) VALUES ($1, $2, $3)",
      ["admin", hash, "Administrator"]
    );
    console.log("👤 Default admin created: admin / battericentralen2025");
  }

  console.log("🗄️ Database initialized");
}

// ═══════════════════════════════════════
// NOTIFICATION SENDING
// ═══════════════════════════════════════
async function sendNotification(cust, order, status, mach) {
  const msg = `Hei ${cust.name}!\n\n${STATUS_MSGS[status] || ""}\n\nMaskin: ${mach.brand} ${mach.model}\nServicenr: ${order.service_nr}\n\nMvh Battericentralen\nØstre Totenvei 128, Gjøvik\nTlf: 611 72 972`;
  const type = cust.email ? "email" : "sms";
  const to = cust.email || cust.phone;
  const subject = status === "ready"
    ? `Maskinen er klar! (${order.service_nr})`
    : `Status – ${order.service_nr}`;

  const inserted = await pool.query(
    `INSERT INTO notifications (order_id, customer_id, type, recipient, subject, message, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [order.id, cust.id, type, to, subject, msg, status]
  );

  const notificationId = inserted.rows[0].id;

  try {
    if (type === "sms" && twilio) {
      let phone = to.replace(/\s/g, "");
      if (!phone.startsWith("+")) phone = "+47" + phone;

      await twilio.messages.create({
        body: msg,
        from: TWILIO_FROM,
        to: phone,
      });

      await pool.query(
        "UPDATE notifications SET delivered=true, error=NULL WHERE id=$1",
        [notificationId]
      );

      console.log(`📱 SMS → ${phone}`);
    } else if (type === "email" && resend) {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: [to],
        subject,
        text: msg,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
          <div style="border-bottom:2px solid #1D4ED8;padding-bottom:10px;margin-bottom:16px">
            <strong style="font-size:16px">🔋 Battericentralen</strong>
            <span style="font-size:11px;color:#888;margin-left:8px">Service & Reparasjon</span>
          </div>
          <div style="white-space:pre-line;font-size:14px;line-height:1.6;color:#333">${msg.replace(/\n/g, "<br>")}</div>
          <div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#999">
            Battericentralen AS · Østre Totenvei 128, 2816 Gjøvik
          </div>
        </div>`,
      });

      await pool.query(
        "UPDATE notifications SET delivered=true, error=NULL WHERE id=$1",
        [notificationId]
      );

      console.log(`✉️ E-post → ${to}`);
    } else {
      await pool.query(
        "UPDATE notifications SET error=$1 WHERE id=$2",
        ["Ingen aktiv leverandør konfigurert for varsling", notificationId]
      );
    }
  } catch (err) {
    console.error(`❌ ${type} feil:`, err.message);

    await pool.query(
      "UPDATE notifications SET delivered=false, error=$1 WHERE id=$2",
      [err.message, notificationId]
    );
  }
}

// ═══════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendError(res, 400, "Mangler brukernavn eller passord");
  }

  const { rows } = await pool.query(
    "SELECT * FROM admin_users WHERE username = $1",
    [username]
  );

  if (rows.length === 0) {
    return sendError(res, 401, "Feil brukernavn eller passord");
  }

  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) {
    return sendError(res, 401, "Feil brukernavn eller passord");
  }

  const token = jwt.sign(
    { id: rows[0].id, username: rows[0].username, name: rows[0].name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  res.json({ token, name: rows[0].name, expiresIn: JWT_EXPIRES });
});

app.post("/api/change-password", auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return sendError(res, 400, "Nytt passord må være minst 8 tegn");
  }

  const { rows } = await pool.query(
    "SELECT password_hash FROM admin_users WHERE id = $1",
    [req.admin.id]
  );

  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!valid) {
    return sendError(res, 401, "Feil nåværende passord");
  }

  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await pool.query(
    "UPDATE admin_users SET password_hash = $1 WHERE id = $2",
    [hash, req.admin.id]
  );

  res.json({ ok: true });
});

// ═══════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════
app.get("/api/customers", auth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY created_at DESC"
  );
  res.json(rows);
});

app.post("/api/customers", auth, async (req, res) => {
  const { name, phone, email, address, zip, city } = req.body;

  if (!name || (!phone && !email)) {
    return sendError(res, 400, "Navn + telefon eller e-post kreves");
  }

  const { rows } = await pool.query(
    `INSERT INTO customers (name, phone, email, address, zip, city)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      name.trim(),
      phone?.trim() || null,
      email?.trim() || null,
      address?.trim() || null,
      zip?.trim() || null,
      city?.trim() || null,
    ]
  );

  res.json(rows[0]);
});

app.put("/api/customers/:id", auth, async (req, res) => {
  const { name, phone, email, address, zip, city } = req.body;

  const { rows } = await pool.query(
    `UPDATE customers
     SET name=$1, phone=$2, email=$3, address=$4, zip=$5, city=$6, updated_at=NOW()
     WHERE id=$7 AND deleted_at IS NULL
     RETURNING *`,
    [
      name,
      phone || null,
      email || null,
      address || null,
      zip || null,
      city || null,
      req.params.id
    ]
  );

  if (!rows.length) return sendError(res, 404, "Kunde ikke funnet");
  res.json(rows[0]);
});

app.delete("/api/customers/:id", auth, async (req, res) => {
  await pool.query(
    `UPDATE customers
     SET deleted_at=NOW(), name='[slettet]', phone=NULL, email=NULL, address=NULL, zip=NULL, city=NULL
     WHERE id=$1`,
    [req.params.id]
  );

  await pool.query(
    "INSERT INTO gdpr_log (action, subject_id, admin_id, details) VALUES ($1,$2,$3,$4)",
    ["data_delete", req.params.id, req.admin.id, "Customer soft-deleted by admin"]
  );

  res.json({ ok: true });
});

// ═══════════════════════════════════════
// MACHINES
// ═══════════════════════════════════════
app.get("/api/machines", auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.*, c.name as customer_name
     FROM machines m
     JOIN customers c ON m.customer_id = c.id
     WHERE c.deleted_at IS NULL
     ORDER BY m.created_at DESC`
  );

  res.json(rows);
});

app.post("/api/machines", auth, async (req, res) => {
  const { customer_id, brand, model, model_code, serial } = req.body;

  if (!customer_id || !model) {
    return sendError(res, 400, "Kunde og modell kreves");
  }

  const { rows } = await pool.query(
    `INSERT INTO machines (customer_id, brand, model, model_code, serial)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [customer_id, brand || "Gaggia", model, model_code || null, serial || null]
  );

  res.json(rows[0]);
});

// ═══════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════
app.get("/api/orders", auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email,
            m.brand as machine_brand, m.model as machine_model, m.model_code as machine_model_code, m.serial as machine_serial
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     JOIN machines m ON o.machine_id = m.id
     WHERE c.deleted_at IS NULL
       AND o.deleted_at IS NULL
     ORDER BY o.created_at DESC`
  );

  for (const o of rows) {
    const sh = await pool.query(
      "SELECT * FROM status_history WHERE order_id=$1 ORDER BY created_at",
      [o.id]
    );
    o.status_history = sh.rows;

    const up = await pool.query(
      "SELECT * FROM used_parts WHERE order_id=$1 ORDER BY created_at",
      [o.id]
    );
    o.used_parts = up.rows;

    const wl = await pool.query(
      "SELECT * FROM work_logs WHERE order_id=$1 ORDER BY created_at DESC",
      [o.id]
    );
    o.work_logs = wl.rows;
  }

  res.json(rows);
});

app.post("/api/orders", auth, async (req, res) => {
  const { customer_id, machine_id, description, delivery_method } = req.body;

  if (!customer_id || !machine_id) {
    return sendError(res, 400, "Kunde og maskin kreves");
  }

  const service_nr = genServiceNr();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const duplicate = await findRecentAdminDuplicate(client, customer_id, machine_id, description);
    if (duplicate) {
      await client.query("ROLLBACK");
      return sendError(
        res,
        409,
        `Det finnes allerede en nylig opprettet serviceordre for denne maskinen (${duplicate.service_nr}). Oppdater den eksisterende ordren i stedet.`,
        { duplicate_order_id: duplicate.id, duplicate_service_nr: duplicate.service_nr }
      );
    }

    const { rows } = await client.query(
      `INSERT INTO orders (service_nr, customer_id, machine_id, description, delivery_method)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [service_nr, customer_id, machine_id, description || null, delivery_method || null]
    );

    await client.query(
      "INSERT INTO status_history (order_id, status, note) VALUES ($1, 'registered', 'Ordre opprettet')",
      [rows[0].id]
    );

    await client.query("COMMIT");

    const cust = (await pool.query("SELECT * FROM customers WHERE id=$1", [customer_id])).rows[0];
    const mach = (await pool.query("SELECT * FROM machines WHERE id=$1", [machine_id])).rows[0];
    if (cust && mach) await sendNotification(cust, rows[0], "registered", mach);

    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    return sendError(res, 500, err.message);
  } finally {
    client.release();
  }
});

app.delete("/api/orders/:id", auth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE orders
        SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND deleted_at IS NULL
      RETURNING id, service_nr`,
    [req.params.id]
  );

  if (!rows.length) {
    return sendError(res, 404, "Ordre ikke funnet");
  }

  await pool.query(
    "INSERT INTO gdpr_log (action, subject_id, admin_id, details) VALUES ($1,$2,$3,$4)",
    ["order_delete", rows[0].id, req.admin.id, `Serviceordre ${rows[0].service_nr} soft-deleted by admin`]
  );

  res.json({ ok: true, id: rows[0].id, service_nr: rows[0].service_nr });
});

app.put("/api/orders/:id/status", auth, async (req, res) => {
  const { status, note } = req.body;
  if (!status) return sendError(res, 400, "Status kreves");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Ordre ikke funnet");
    }

    await client.query(
      "INSERT INTO status_history (order_id, status, note) VALUES ($1,$2,$3)",
      [req.params.id, status, note || null]
    );

    await client.query("COMMIT");

    const o = rows[0];
    const cust = (await pool.query("SELECT * FROM customers WHERE id=$1", [o.customer_id])).rows[0];
    const mach = (await pool.query("SELECT * FROM machines WHERE id=$1", [o.machine_id])).rows[0];
    if (cust && mach) await sendNotification(cust, o, status, mach);

    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    return sendError(res, 500, err.message);
  } finally {
    client.release();
  }
});

app.put("/api/orders/:id/faults", auth, async (req, res) => {
  const { fault_codes } = req.body;

  const { rows } = await pool.query(
    "UPDATE orders SET fault_codes=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
    [fault_codes || [], req.params.id]
  );

  res.json(rows[0]);
});

// ─── Used parts ───
app.post("/api/orders/:id/parts", auth, async (req, res) => {
  const { part_nr, name, price, qty } = req.body;

  const { rows } = await pool.query(
    `INSERT INTO used_parts (order_id, part_nr, name, price, qty)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [req.params.id, part_nr, name, price || 0, qty || 1]
  );

  res.json(rows[0]);
});

app.delete("/api/orders/:id/parts/:partId", auth, async (req, res) => {
  await pool.query(
    "DELETE FROM used_parts WHERE id=$1 AND order_id=$2",
    [req.params.partId, req.params.id]
  );

  res.json({ ok: true });
});

// ─── Work logs ───
app.post("/api/orders/:id/logs", auth, async (req, res) => {
  const { description, parts, minutes } = req.body;

  if (!description) return sendError(res, 400, "Beskrivelse kreves");

  const { rows } = await pool.query(
    `INSERT INTO work_logs (order_id, description, parts, minutes)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [req.params.id, description, parts || null, minutes || 0]
  );

  res.json(rows[0]);
});

// ═══════════════════════════════════════
// STOCK
// ═══════════════════════════════════════
app.get("/api/stock", auth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM stock");
  const map = {};
  rows.forEach((r) => {
    map[r.part_nr] = r.qty;
  });
  res.json(map);
});

app.put("/api/stock/:partNr", auth, async (req, res) => {
  const { qty } = req.body;

  await pool.query(
    `INSERT INTO stock (part_nr, qty, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (part_nr) DO UPDATE SET qty=$2, updated_at=NOW()`,
    [req.params.partNr, qty || 0]
  );

  res.json({ ok: true });
});

// ═══════════════════════════════════════
// NOTIFICATIONS LOG
// ═══════════════════════════════════════
app.get("/api/notifications", auth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM notifications ORDER BY sent_at DESC LIMIT 200"
  );
  res.json(rows);
});

// ═══════════════════════════════════════
// CUSTOMER PORTAL (public — no auth)
// ═══════════════════════════════════════
app.get("/api/portal/:serviceNr", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.service_nr, o.status, o.description, o.delivery_method, o.fault_codes, o.created_at,
            m.brand as machine_brand, m.model as machine_model, m.serial as machine_serial, m.model_code as machine_model_code
     FROM orders o
     JOIN machines m ON o.machine_id = m.id
     WHERE LOWER(o.service_nr) = LOWER($1)
       AND o.deleted_at IS NULL`,
    [req.params.serviceNr]
  );

  if (!rows.length) return sendError(res, 404, "Ordre ikke funnet");

  const o = rows[0];
  const sh = await pool.query(
    "SELECT status, note, created_at FROM status_history WHERE order_id=$1 ORDER BY created_at",
    [o.id]
  );
  o.status_history = sh.rows;

  delete o.id;
  res.json(o);
});

app.post("/api/portal/register", async (req, res) => {
  const {
    name, phone, email, address, zip, city,
    model_code, serial, description, symptoms, delivery_method
  } = req.body;

  if (!name || (!phone && !email) || !model_code) {
    return sendError(res, 400, "Mangler påkrevde felt");
  }

  const model_name = req.body.model_name || model_code;
  const service_nr = genServiceNr();

  let fullDesc = "";
  if (symptoms && symptoms.length > 0) {
    fullDesc = "Symptomer:\n" + symptoms.map((s) => "• " + s).join("\n");
  }
  if (description) {
    fullDesc += (fullDesc ? "\n\nTilleggsinformasjon:\n" : "") + description;
  }

  const addrStr = [address, zip, city]
    .filter(Boolean)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
  if (addrStr) fullDesc += "\n\nKundeadresse: " + addrStr;

  const deliveryLabels = {
    post: "Sendes per post",
    dropoff: "Leveres Gjøvik",
    partner: "Leveres ServiceKompaniet Oslo",
  };
  const deliveryNote = deliveryLabels[delivery_method] || delivery_method || "";
  if (deliveryNote) fullDesc += "\n\n📦 Leveringsmåte: " + deliveryNote;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const duplicate = await findRecentPortalDuplicate(client, {
      name,
      phone,
      email,
      model_code,
      serial,
      description: fullDesc,
    });

    if (duplicate) {
      await client.query("ROLLBACK");
      return sendError(
        res,
        409,
        `Denne registreringen ser ut til å være sendt inn allerede nylig (${duplicate.service_nr}). Vent litt og bruk eksisterende serviceordre hvis den finnes.`,
        { duplicate_order_id: duplicate.id, duplicate_service_nr: duplicate.service_nr }
      );
    }

    const cust = (await client.query(
      `INSERT INTO customers (name, phone, email, address, zip, city)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        name.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        address?.trim() || null,
        zip?.trim() || null,
        city?.trim() || null,
      ]
    )).rows[0];

    const mach = (await client.query(
      `INSERT INTO machines (customer_id, brand, model, model_code, serial)
       VALUES ($1,'Gaggia',$2,$3,$4)
       RETURNING *`,
      [cust.id, model_name, model_code, serial?.trim() || null]
    )).rows[0];

    const order = (await client.query(
      `INSERT INTO orders (service_nr, customer_id, machine_id, description, delivery_method)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [service_nr, cust.id, mach.id, fullDesc, delivery_method || null]
    )).rows[0];

    await client.query(
      "INSERT INTO status_history (order_id, status, note) VALUES ($1, 'registered', $2)",
      [order.id, "Registrert av kunde via portalen. " + deliveryNote]
    );

    await client.query(
      "INSERT INTO gdpr_log (action, subject_id, details, ip_address) VALUES ($1,$2,$3,$4)",
      ["consent_given", cust.id, "Samtykke gitt ved registrering via kundeportal", req.ip]
    );

    await client.query("COMMIT");

    await sendNotification(cust, order, "registered", mach);

    res.json({ service_nr, delivery_method });
  } catch (err) {
    await client.query("ROLLBACK");
    return sendError(res, 500, err.message);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════
// GDPR
// ═══════════════════════════════════════
app.get("/api/gdpr/export/:customerId", auth, async (req, res) => {
  const cid = req.params.customerId;

  const customer = (await pool.query(
    "SELECT * FROM customers WHERE id=$1",
    [cid]
  )).rows[0];

  if (!customer) return sendError(res, 404, "Kunde ikke funnet");

  const machines = (await pool.query(
    "SELECT * FROM machines WHERE customer_id=$1",
    [cid]
  )).rows;

  const orders = (await pool.query(
    "SELECT * FROM orders WHERE customer_id=$1",
    [cid]
  )).rows;

  const notifications = (await pool.query(
    "SELECT * FROM notifications WHERE customer_id=$1",
    [cid]
  )).rows;

  await pool.query(
    "INSERT INTO gdpr_log (action, subject_id, admin_id, details) VALUES ($1,$2,$3,$4)",
    ["data_export", cid, req.admin.id, "Full data export requested"]
  );

  res.json({ customer, machines, orders, notifications, exported_at: new Date().toISOString() });
});

app.delete("/api/gdpr/erase/:customerId", auth, async (req, res) => {
  const cid = req.params.customerId;

  await pool.query(
    `UPDATE customers
     SET name='[slettet]', phone=NULL, email=NULL, address=NULL, zip=NULL, city=NULL, deleted_at=NOW()
     WHERE id=$1`,
    [cid]
  );

  await pool.query(
    "INSERT INTO gdpr_log (action, subject_id, admin_id, details) VALUES ($1,$2,$3,$4)",
    ["data_delete", cid, req.admin.id, "Customer data erased (GDPR Art. 17)"]
  );

  res.json({ ok: true, message: "Kundedata anonymisert" });
});

app.get("/api/gdpr/log", auth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM gdpr_log ORDER BY created_at DESC LIMIT 100"
  );
  res.json(rows);
});

// ─── Health ───
app.get("/", (req, res) =>
  res.json({
    service: "Battericentralen Service API",
    sms: !!twilio,
    email: !!resend,
    time: new Date().toISOString(),
  })
);

// ─── Start ───
const PORT = process.env.PORT || 3001;

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`\n🔋 API running on port ${PORT}\n`));
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
