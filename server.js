require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { ObjectId } = require("mongodb");

const app = express();
app.set("trust proxy", 1);

/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */
const {
  PORT = 3000,
  MONGODB_URI,
  ADMIN_API_KEY,
  JWT_SECRET: JWT_SECRET_RAW,

  // PayPal
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_BASE_URL = "https://api-m.paypal.com",

  // Email / SMTP
  SMTP_HOST,
  SMTP_PORT = "465",
  SMTP_SECURE = "true",
  SMTP_USER,
  SMTP_PASS,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  EMAIL_FROM,
  EMAIL_FROM_NAME,
  OWNER_EMAIL,

  // Frontend / CORS
  PUBLIC_BASE_URL,
  GITHUB_PAGES_ORIGIN,
  FRONTEND_ORIGIN,
  CORS_ORIGINS,
} = process.env;

const JWT_SECRET = String(JWT_SECRET_RAW || "").replace(/\s+/g, "").trim();
const ADMIN_KEY = String(ADMIN_API_KEY || "").trim();

// Gmail App Password is sometimes copied as "abcd efgh ijkl mnop".
// This removes spaces automatically.
const CLEAN_SMTP_PASS = String(SMTP_PASS || "").replace(/\s+/g, "").trim();
const CLEAN_GMAIL_APP_PASSWORD = String(GMAIL_APP_PASSWORD || "").replace(/\s+/g, "").trim();

if (!MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI");
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.error("❌ Missing ADMIN_API_KEY");
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("❌ Missing/weak JWT_SECRET (must be one line, 32+ chars)");
  process.exit(1);
}

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

/* =========================================================
   CORS
   ========================================================= */
const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://eshetu70.github.io",
  "https://communitykitchencafe.com",
  "https://www.communitykitchencafe.com",
  GITHUB_PAGES_ORIGIN,
  FRONTEND_ORIGIN,
  ...(String(CORS_ORIGINS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)),
]
  .map((origin) => String(origin || "").trim().replace(/\/+$/, ""))
  .filter(Boolean);

function isAllowed(origin) {
  if (!origin) return true;

  try {
    const cleanOrigin = String(origin).trim().replace(/\/+$/, "");
    const u = new URL(cleanOrigin);

    if (allowedOrigins.includes(cleanOrigin)) return true;

    if (u.protocol === "https:" && u.hostname === "eshetu70.github.io") return true;

    if (
      u.protocol === "https:" &&
      (u.hostname === "communitykitchencafe.com" ||
        u.hostname === "www.communitykitchencafe.com")
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

const corsOptions = {
  origin: (origin, cb) => {
    if (isAllowed(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/* =========================================================
   MONGODB + GRIDFS IMAGE STORAGE
   ========================================================= */
let imageBucket;

mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    imageBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "cafe_images",
    });
    console.log("✅ MongoDB connected");
    console.log("✅ MongoDB GridFS image storage ready");
  })
  .catch((err) => {
    console.error("❌ MongoDB error:", err.message);
    process.exit(1);
  });

/* =========================================================
   SCHEMAS
   ========================================================= */
const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

const menuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    category: {
      type: String,
      default: "lunch",
    },
    price: { type: Number, required: true },
    image: { type: String, default: "" },
    available: { type: Boolean, default: true },

    emoji: { type: String, default: "🍽️" },
    ingredients: [{ type: String }],
    calories: { type: Number, default: 0 },
    allergens: [{ type: String }],

    nutrition: {
      protein: { type: String, default: "" },
      carbs: { type: String, default: "" },
      fat: { type: String, default: "" },
      sodium: { type: String, default: "" },
    },

    optionGroups: [
      {
        name: { type: String, default: "" },
        type: { type: String, enum: ["radio", "checkbox"], default: "radio" },
        required: { type: Boolean, default: false },
        options: [{ type: String }],
      },
    ],
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },

    // Optional so PayPal guest checkout can save orders without login.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "CafeUser", required: false, index: true },

    items: [
      {
        menuItemId: { type: String, default: "" },
        id: { type: String, default: "" },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        qty: { type: Number, required: true },
        image: { type: String, default: "" },
        selectedOptions: [
          {
            name: { type: String, default: "" },
            values: [{ type: String }],
          },
        ],
      },
    ],

    total: { type: Number, required: true },

    customer: {
      fullName: { type: String, required: true },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      pickupTime: { type: String, default: "" },
      notes: { type: String, default: "" },
    },

    payment: {
      method: { type: String, default: "paypal" },
      provider: { type: String, default: "paypal" },
      status: { type: String, enum: ["pending", "paid", "failed", "refunded"], default: "pending" },
      paypalOrderId: { type: String, default: "" },
      paypalCaptureId: { type: String, default: "" },
      payerEmail: { type: String, default: "" },
      raw: { type: Object, default: {} },
    },

    status: {
      type: String,
      enum: ["placed", "confirmed", "preparing", "ready", "completed", "delivered", "cancelled"],
      default: "placed",
    },
  },
  { timestamps: true }
);

const User = mongoose.model("CafeUser", userSchema, "cafe_users");
const MenuItem = mongoose.model("CafeMenuItem", menuItemSchema, "cafe_menu_items");
const Order = mongoose.model("CafeOrder", orderSchema, "cafe_orders");

/* =========================================================
   HELPERS
   ========================================================= */
function baseUrlFromReq(req) {
  if (PUBLIC_BASE_URL) return String(PUBLIC_BASE_URL).replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http")
    .toString()
    .split(",")[0]
    .trim();
  const host = req.get("host");
  return `${proto}://${host}`;
}

function toAbsoluteUrl(req, maybeUrlOrPath) {
  if (!maybeUrlOrPath) return "";
  const v = String(maybeUrlOrPath);
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  const base = baseUrlFromReq(req);
  return v.startsWith("/") ? `${base}${v}` : `${base}/${v}`;
}

function makeOrderId() {
  return `CKC-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requireAdmin(req, res, next) {
  const key = String(req.headers["x-admin-key"] || "").trim();
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized (admin key required)" });
  }
  next();
}

function optionalAuth(req, _res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return next();

  try {
    req.user = jwt.verify(String(token).trim(), JWT_SECRET);
  } catch {
    // guest order still allowed
  }
  next();
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(String(token).trim(), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseOptionGroups(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((group) => ({
        name: String(group?.name || "").trim(),
        type: group?.type === "checkbox" ? "checkbox" : "radio",
        required: Boolean(group?.required),
        options: Array.isArray(group?.options)
          ? group.options.map((x) => String(x).trim()).filter(Boolean)
          : [],
      }))
      .filter((group) => group.name && group.options.length > 0);
  } catch {
    return [];
  }
}

/* =========================================================
   IMAGE UPLOAD
   ========================================================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only image files allowed (png/jpg/webp)"), ok);
  },
});

function getSafeImageExt(file) {
  const original = String(file?.originalname || "").toLowerCase();
  if (original.endsWith(".png")) return ".png";
  if (original.endsWith(".webp")) return ".webp";
  if (original.endsWith(".jpeg")) return ".jpeg";
  return ".jpg";
}

async function saveImageToMongo(req, file) {
  if (!file) return "";
  if (!imageBucket) throw new Error("Image storage is not ready yet");

  const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}${getSafeImageExt(file)}`;

  const fileId = await new Promise((resolve, reject) => {
    const uploadStream = imageBucket.openUploadStream(filename, {
      contentType: file.mimetype,
      metadata: {
        originalName: file.originalname || filename,
        uploadedAt: new Date(),
      },
    });

    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(file.buffer);
  });

  return toAbsoluteUrl(req, `/api/images/${fileId.toString()}`);
}

async function deleteImageFromMongoByUrl(imageUrl) {
  try {
    const match = String(imageUrl || "").match(/\/api\/images\/([a-fA-F0-9]{24})/);
    if (!match || !imageBucket) return;
    await imageBucket.delete(new ObjectId(match[1]));
  } catch (e) {
    console.warn("⚠️ Could not delete old image from MongoDB:", e.message);
  }
}

/* =========================================================
   EMAIL
   ========================================================= */
function getMailFrom() {
  const fromEmail = EMAIL_FROM || SMTP_USER || GMAIL_USER || "no-reply@communitykitchencafe.com";
  const fromName = EMAIL_FROM_NAME || "Community Kitchen Cafe";
  return `"${fromName}" <${fromEmail}>`;
}

async function createTransporter() {
  if (SMTP_HOST && SMTP_PORT && SMTP_USER && CLEAN_SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: String(SMTP_SECURE || "").toLowerCase() === "true",
      auth: { user: SMTP_USER, pass: CLEAN_SMTP_PASS },
    });
    return transporter;
  }

  if (GMAIL_USER && CLEAN_GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: CLEAN_GMAIL_APP_PASSWORD },
    });
  }

  return null;
}

async function sendEmail({ to, subject, html, text, replyTo }) {
  const transporter = await createTransporter();
  if (!transporter) {
    return { ok: false, skipped: true, message: "Email not configured." };
  }

  await transporter.sendMail({
    from: getMailFrom(),
    to,
    subject,
    text,
    html,
    replyTo: replyTo || OWNER_EMAIL || undefined,
  });

  return { ok: true };
}

async function verifyEmailConfig() {
  const transporter = await createTransporter();
  if (!transporter) return { ok: false, error: "Email not configured" };
  await transporter.verify();
  return { ok: true };
}

function buildItemsRows(items = []) {
  return items
    .map((item) => {
      const options = Array.isArray(item.selectedOptions)
        ? item.selectedOptions
            .map((g) => `${escapeHtml(g.name)}: ${(g.values || []).map(escapeHtml).join(", ")}`)
            .join("<br>")
        : "";

      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #eee;">
            <b>${escapeHtml(item.name)}</b>
            ${options ? `<div style="font-size:12px;color:#777;margin-top:4px;">${options}</div>` : ""}
          </td>
          <td style="padding:10px;border-bottom:1px solid #eee;text-align:center;">${Number(item.qty || 1)}</td>
          <td style="padding:10px;border-bottom:1px solid #eee;text-align:right;">$${money(item.price)}</td>
          <td style="padding:10px;border-bottom:1px solid #eee;text-align:right;">$${money(Number(item.price || 0) * Number(item.qty || 1))}</td>
        </tr>`;
    })
    .join("");
}

function buildOwnerOrderEmailHtml(order) {
  const itemsRows = buildItemsRows(order.items);

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:760px;margin:0 auto;padding:18px;border:1px solid #eee;border-radius:14px;">
    <h2 style="margin:0 0 8px;color:#5c2e0e;">🍽️ New Paid Order — Community Kitchen Cafe</h2>
    <p style="margin:0 0 16px;color:#555;">Order received from website checkout.</p>

    <div style="background:#fff8f0;border:1px solid #ede0d4;border-radius:12px;padding:14px;margin-bottom:16px;">
      <h3 style="margin:0 0 8px;color:#5c2e0e;">Customer Details</h3>
      <div><b>Name:</b> ${escapeHtml(order.customer?.fullName)}</div>
      <div><b>Phone:</b> ${escapeHtml(order.customer?.phone || "Not provided")}</div>
      <div><b>Email:</b> ${escapeHtml(order.customer?.email || "Not provided")}</div>
      <div><b>Pickup Time:</b> ${escapeHtml(order.customer?.pickupTime || "ASAP")}</div>
      <div><b>Notes:</b> ${escapeHtml(order.customer?.notes || "None")}</div>
    </div>

    <h3 style="margin:0 0 8px;color:#5c2e0e;">Food Order</h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #eee;">
      <thead>
        <tr style="background:#fdf6ee;">
          <th style="padding:10px;text-align:left;border-bottom:1px solid #eee;">Item</th>
          <th style="padding:10px;text-align:center;border-bottom:1px solid #eee;">Qty</th>
          <th style="padding:10px;text-align:right;border-bottom:1px solid #eee;">Price</th>
          <th style="padding:10px;text-align:right;border-bottom:1px solid #eee;">Total</th>
        </tr>
      </thead>
      <tbody>${itemsRows}</tbody>
    </table>

    <h2 style="text-align:right;margin:18px 0;color:#5c2e0e;">Total: $${money(order.total)}</h2>

    <div style="background:#f7f7fb;border:1px solid #ececf3;border-radius:12px;padding:14px;">
      <div><b>Order ID:</b> ${escapeHtml(order.orderId)}</div>
      <div><b>Payment Status:</b> ${escapeHtml(order.payment?.status || "paid")}</div>
      <div><b>PayPal Order ID:</b> ${escapeHtml(order.payment?.paypalOrderId || "")}</div>
      <div><b>PayPal Capture ID:</b> ${escapeHtml(order.payment?.paypalCaptureId || "")}</div>
      <div><b>Order Status:</b> ${escapeHtml(order.status || "placed")}</div>
      <div><b>Order Time:</b> ${new Date(order.createdAt || Date.now()).toLocaleString()}</div>
    </div>
  </div>`;
}

function buildCustomerReceiptEmailHtml(order) {
  const itemsRows = buildItemsRows(order.items);

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:720px;margin:0 auto;padding:18px;border:1px solid #eee;border-radius:14px;">
    <h2 style="margin:0 0 8px;color:#5c2e0e;">Thank you for your order</h2>
    <p>Hi ${escapeHtml(order.customer?.fullName || "Customer")}, your order has been received.</p>

    <table style="width:100%;border-collapse:collapse;border:1px solid #eee;">
      <thead>
        <tr style="background:#fdf6ee;">
          <th style="padding:10px;text-align:left;border-bottom:1px solid #eee;">Item</th>
          <th style="padding:10px;text-align:center;border-bottom:1px solid #eee;">Qty</th>
          <th style="padding:10px;text-align:right;border-bottom:1px solid #eee;">Price</th>
          <th style="padding:10px;text-align:right;border-bottom:1px solid #eee;">Total</th>
        </tr>
      </thead>
      <tbody>${itemsRows}</tbody>
    </table>

    <h2 style="text-align:right;margin:18px 0;color:#5c2e0e;">Total: $${money(order.total)}</h2>

    <div style="background:#f7f7fb;border:1px solid #ececf3;border-radius:12px;padding:14px;">
      <div><b>Order ID:</b> ${escapeHtml(order.orderId)}</div>
      <div><b>Status:</b> ${escapeHtml(order.status || "placed")}</div>
      <div><b>Payment:</b> ${escapeHtml(order.payment?.status || "paid")}</div>
      <div><b>Pickup Time:</b> ${escapeHtml(order.customer?.pickupTime || "ASAP")}</div>
    </div>

    <p style="margin-top:14px;">Community Kitchen Cafe will prepare your food shortly.</p>
  </div>`;
}

function buildCustomerEmailHtml({ customerName, orderId, status, paymentStatus }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:650px;margin:0 auto;padding:18px;border:1px solid #eee;border-radius:12px;">
    <h2 style="margin:0 0 10px;">Community Kitchen Cafe — Order Update</h2>
    <p>Hi ${escapeHtml(customerName || "Customer")},</p>
    <p>Your order has been updated.</p>
    <div style="background:#f7f7fb;border:1px solid #ececf3;border-radius:10px;padding:12px;">
      <div><b>Order ID:</b> ${escapeHtml(orderId)}</div>
      <div><b>Status:</b> ${escapeHtml(status)}</div>
      <div><b>Payment:</b> ${escapeHtml(paymentStatus)}</div>
    </div>
    <p style="margin-top:14px;">Thank you for ordering from Community Kitchen Cafe.</p>
  </div>`;
}

function sendEmailInBackground(fn) {
  setImmediate(async () => {
    try {
      await fn();
    } catch (e) {
      console.warn("⚠️ Background email failed:", e.message);
    }
  });
}

async function sendOwnerAndCustomerOrderEmails(order) {
  if (OWNER_EMAIL) {
    await sendEmail({
      to: OWNER_EMAIL,
      subject: `New Paid Order — ${order.orderId} — $${money(order.total)}`,
      html: buildOwnerOrderEmailHtml(order),
      text: `New paid order ${order.orderId} total $${money(order.total)}. Customer: ${order.customer?.fullName || ""}.`,
      replyTo: order.customer?.email || OWNER_EMAIL,
    });
  }

  if (order.customer?.email) {
    await sendEmail({
      to: order.customer.email,
      subject: `Community Kitchen Cafe — Order Receipt (${order.orderId})`,
      html: buildCustomerReceiptEmailHtml(order),
      text: `Thank you for your order ${order.orderId}. Total $${money(order.total)}.`,
    });
  }
}

/* =========================================================
   PAYPAL
   ========================================================= */
async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");
  }

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "PayPal token failed");
  }

  return data.access_token;
}

function normalizeCheckoutItems(items = [], cart = []) {
  const source = Array.isArray(items) && items.length ? items : cart;
  return (source || [])
    .map((it) => ({
      menuItemId: String(it.menuItemId || it._id || it.id || ""),
      id: String(it.id || it.menuItemId || it._id || ""),
      name: String(it.name || "Menu item").trim(),
      price: Number(it.price || 0),
      qty: Math.max(1, Number(it.qty || it.quantity || 1)),
      image: String(it.image || ""),
      selectedOptions: Array.isArray(it.selectedOptions)
        ? it.selectedOptions.map((group) => ({
            name: String(group?.name || "").trim(),
            values: Array.isArray(group?.values)
              ? group.values.map((x) => String(x).trim()).filter(Boolean)
              : [],
          }))
        : [],
    }))
    .filter((it) => it.name && it.price >= 0 && it.qty > 0);
}

function paypalItemsFromCart(items) {
  return items.slice(0, 100).map((item) => ({
    name: item.name.slice(0, 127),
    quantity: String(item.qty),
    unit_amount: {
      currency_code: "USD",
      value: money(item.price),
    },
  }));
}

function normalizeCustomer(customer = {}) {
  return {
    fullName: String(customer.fullName || customer.name || "Guest Customer").trim(),
    phone: String(customer.phone || "").trim(),
    email: String(customer.email || "").trim(),
    pickupTime: String(customer.pickupTime || "").trim(),
    notes: String(customer.notes || customer.instructions || "").trim(),
  };
}

/* =========================================================
   BASIC ROUTES
   ========================================================= */
app.get("/", (req, res) => {
  res.json({ ok: true, app: "Community Kitchen Cafe API", time: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "Community Kitchen Cafe API",
    time: new Date().toISOString(),
    origin: req.headers.origin || null,
    host: req.get("host"),
    paypalConfigured: Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET),
    smtpConfigured: Boolean((SMTP_HOST && SMTP_USER && CLEAN_SMTP_PASS) || (GMAIL_USER && CLEAN_GMAIL_APP_PASSWORD)),
    ownerEmailConfigured: Boolean(OWNER_EMAIL),
    smtpUser: SMTP_USER || GMAIL_USER || null,
    ownerEmail: OWNER_EMAIL || null,
  });
});

app.get("/api/admin/ping", requireAdmin, (req, res) => {
  res.json({ ok: true, admin: true, time: new Date().toISOString() });
});

// Supports both GET and POST so browser testing is easier.
app.get("/api/admin/test-email", requireAdmin, async (req, res) => {
  try {
    await verifyEmailConfig();

    const to = OWNER_EMAIL || SMTP_USER || GMAIL_USER;
    if (!to) return res.status(400).json({ ok: false, error: "OWNER_EMAIL missing" });

    const result = await sendEmail({
      to,
      subject: "Community Kitchen Cafe — Test Email",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <h2>✅ Test email successful</h2>
          <p>Your website backend can send email.</p>
          <p><b>Time:</b> ${new Date().toLocaleString()}</p>
        </div>`,
      text: "Test email successful. Your website backend can send email.",
    });

    res.json({ ok: true, sent: true, result });
  } catch (e) {
    console.error("❌ Test email failed:", e);
    res.status(500).json({
      ok: false,
      error: "Email test failed",
      details: e.message,
      code: e.code || null,
      command: e.command || null,
      response: e.response || null,
      smtpConfigured: Boolean((SMTP_HOST && SMTP_USER && CLEAN_SMTP_PASS) || (GMAIL_USER && CLEAN_GMAIL_APP_PASSWORD)),
      ownerEmailConfigured: Boolean(OWNER_EMAIL),
    });
  }
});

app.post("/api/admin/test-email", requireAdmin, async (req, res) => {
  try {
    await verifyEmailConfig();

    const to = OWNER_EMAIL || SMTP_USER || GMAIL_USER;
    if (!to) return res.status(400).json({ ok: false, error: "OWNER_EMAIL missing" });

    const result = await sendEmail({
      to,
      subject: "Community Kitchen Cafe — Test Email",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <h2>✅ Test email successful</h2>
          <p>Your website backend can send email.</p>
          <p><b>Time:</b> ${new Date().toLocaleString()}</p>
        </div>`,
      text: "Test email successful. Your website backend can send email.",
    });

    res.json({ ok: true, sent: true, result });
  } catch (e) {
    console.error("❌ Test email failed:", e);
    res.status(500).json({
      ok: false,
      error: "Email test failed",
      details: e.message,
      code: e.code || null,
      command: e.command || null,
      response: e.response || null,
      smtpConfigured: Boolean((SMTP_HOST && SMTP_USER && CLEAN_SMTP_PASS) || (GMAIL_USER && CLEAN_GMAIL_APP_PASSWORD)),
      ownerEmailConfigured: Boolean(OWNER_EMAIL),
    });
  }
});

/* =========================================================
   AUTH ROUTES
   ========================================================= */
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password } = req.body || {};
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: "fullName, email, password required" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const exists = await User.findOne({ email: cleanEmail }).lean();
    if (exists) return res.status(409).json({ error: "Email already registered" });

    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.create({
      fullName: String(fullName).trim(),
      email: cleanEmail,
      passwordHash,
    });

    const token = jwt.sign(
      { userId: String(user._id), email: user.email },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: String(user._id),
        fullName: user.fullName,
        email: user.email,
      },
    });
  } catch (e) {
    res.status(500).json({ error: "Register failed", details: e.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password required" });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { userId: String(user._id), email: user.email },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: String(user._id),
        fullName: user.fullName,
        email: user.email,
      },
    });
  } catch (e) {
    res.status(500).json({ error: "Login failed", details: e.message });
  }
});

/* =========================================================
   IMAGE ROUTES
   ========================================================= */
app.get("/api/images/:id", async (req, res) => {
  try {
    if (!imageBucket) return res.status(503).json({ error: "Image storage not ready" });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid image id" });

    const fileId = new ObjectId(req.params.id);
    const files = await mongoose.connection.db
      .collection("cafe_images.files")
      .find({ _id: fileId })
      .limit(1)
      .toArray();

    if (!files.length) return res.status(404).json({ error: "Image not found" });

    const file = files[0];
    res.setHeader("Content-Type", file.contentType || "image/jpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const downloadStream = imageBucket.openDownloadStream(fileId);
    downloadStream.on("error", () => {
      if (!res.headersSent) res.status(404).json({ error: "Image not found" });
      else res.end();
    });
    downloadStream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: "Failed to load image", details: e.message });
  }
});

/* =========================================================
   MENU ROUTES
   ========================================================= */
app.get("/api/menu", async (req, res) => {
  try {
    const { category, q } = req.query || {};
    const filter = {};

    if (category && category !== "all") filter.category = String(category).toLowerCase();

    if (q) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { description: rx }, { category: rx }];
    }

    const items = await MenuItem.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to load menu", details: e.message });
  }
});

app.post("/api/menu", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { name, description = "", category = "lunch", price, available = "true", emoji = "🍽️" } = req.body || {};
    if (!name || price === undefined || price === "") return res.status(400).json({ error: "name and price required" });

    const image = req.file ? await saveImageToMongo(req, req.file) : "";

    const item = await MenuItem.create({
      name: String(name).trim(),
      description: String(description || "").trim(),
      category: String(category).trim().toLowerCase(),
      price: Number(price),
      image,
      available: String(available) !== "false",
      emoji: String(emoji || "🍽️").trim(),

      ingredients: parseCsvList(req.body.ingredients),
      calories: Number(req.body.calories || 0),
      allergens: parseCsvList(req.body.allergens),

      nutrition: {
        protein: String(req.body.protein || "").trim(),
        carbs: String(req.body.carbs || "").trim(),
        fat: String(req.body.fat || "").trim(),
        sodium: String(req.body.sodium || "").trim(),
      },

      optionGroups: parseOptionGroups(req.body.optionGroups),
    });

    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: "Create menu item failed", details: e.message });
  }
});

app.put("/api/menu/:id", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const found = await MenuItem.findById(id);
    if (!found) return res.status(404).json({ error: "Menu item not found" });

    const { name, description = "", category = "lunch", price, available = "true", emoji = "🍽️" } = req.body || {};
    if (!name || price === undefined || price === "") return res.status(400).json({ error: "name and price required" });

    found.name = String(name).trim();
    found.description = String(description || "").trim();
    found.category = String(category).trim().toLowerCase();
    found.price = Number(price);
    found.available = String(available) !== "false";
    found.emoji = String(emoji || found.emoji || "🍽️").trim();

    found.ingredients = parseCsvList(req.body.ingredients);
    found.calories = Number(req.body.calories || 0);
    found.allergens = parseCsvList(req.body.allergens);

    found.nutrition = {
      protein: String(req.body.protein || "").trim(),
      carbs: String(req.body.carbs || "").trim(),
      fat: String(req.body.fat || "").trim(),
      sodium: String(req.body.sodium || "").trim(),
    };

    found.optionGroups = parseOptionGroups(req.body.optionGroups);

    if (req.file) {
      await deleteImageFromMongoByUrl(found.image);
      found.image = await saveImageToMongo(req, req.file);
    }

    await found.save();
    res.json({ ok: true, item: found });
  } catch (e) {
    res.status(500).json({ error: "Update menu item failed", details: e.message });
  }
});

app.delete("/api/menu/:id", requireAdmin, async (req, res) => {
  try {
    const deleted = await MenuItem.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Menu item not found" });
    await deleteImageFromMongoByUrl(deleted.image);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: "Delete menu item failed", details: e.message });
  }
});

/* =========================================================
   PAYPAL CHECKOUT ROUTES
   ========================================================= */

// Professional backend-created PayPal order.
// Frontend may call this route before rendering PayPal approval.
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const normalizedItems = normalizeCheckoutItems(req.body.items, req.body.cart);
    if (!normalizedItems.length) return res.status(400).json({ error: "Cart items required" });

    const total = normalizedItems.reduce((sum, it) => sum + Number(it.price) * Number(it.qty), 0);

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            description: "Community Kitchen Cafe Online Food Order",
            amount: {
              currency_code: "USD",
              value: money(total),
              breakdown: {
                item_total: {
                  currency_code: "USD",
                  value: money(total),
                },
              },
            },
            items: paypalItemsFromCart(normalizedItems),
          },
        ],
        application_context: {
          brand_name: "Community Kitchen Cafe",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
        },
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(500).json({ error: "PayPal create order failed", details: data });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Create PayPal order failed", details: e.message });
  }
});

// Captures PayPal payment, saves order, emails owner/customer.
app.post("/api/paypal/capture-order", optionalAuth, async (req, res) => {
  try {
    const { orderID, paypalOrderId } = req.body || {};
    const orderIdToCapture = String(orderID || paypalOrderId || "").trim();

    if (!orderIdToCapture) return res.status(400).json({ error: "PayPal orderID required" });

    const normalizedItems = normalizeCheckoutItems(req.body.items, req.body.cart);
    if (!normalizedItems.length) return res.status(400).json({ error: "Cart items required" });

    const customer = normalizeCustomer(req.body.customer);
    const total = normalizedItems.reduce((sum, it) => sum + Number(it.price) * Number(it.qty), 0);

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderIdToCapture}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({ error: "PayPal capture failed", details: data });
    }

    const capture = data?.purchase_units?.[0]?.payments?.captures?.[0] || {};
    const captureId = capture.id || "";
    const paypalStatus = capture.status || data.status || "COMPLETED";
    const payerEmail = data?.payer?.email_address || customer.email || "";

    const order = await Order.create({
      orderId: makeOrderId(),
      userId: req.user?.userId || undefined,
      items: normalizedItems,
      total,
      customer: {
        ...customer,
        email: customer.email || payerEmail,
      },
      payment: {
        method: "paypal",
        provider: "paypal",
        status: paypalStatus === "COMPLETED" ? "paid" : "pending",
        paypalOrderId: orderIdToCapture,
        paypalCaptureId: captureId,
        payerEmail,
        raw: data,
      },
      status: "placed",
    });

    // Send emails in background so checkout page does not fail if email is slow.
    sendEmailInBackground(async () => {
      await sendOwnerAndCustomerOrderEmails(order);
    });

    res.json({ ok: true, order, paypal: data });
  } catch (e) {
    console.error("❌ PayPal capture/order email failed:", e);
    res.status(500).json({ error: "Capture PayPal order failed", details: e.message });
  }
});

// Browser PayPal checkout fallback:
// Frontend captures payment in browser, then posts paid order here for DB/email.
app.post("/api/orders/paid", optionalAuth, async (req, res) => {
  try {
    const normalizedItems = normalizeCheckoutItems(req.body.items, req.body.cart);
    if (!normalizedItems.length) return res.status(400).json({ error: "Order items required" });

    const customer = normalizeCustomer(req.body.customer);
    const total = Number(req.body.total || normalizedItems.reduce((sum, it) => sum + Number(it.price) * Number(it.qty), 0));

    const paymentPayload = req.body.payment || req.body.paypal || {};
    const paypalOrderId = String(paymentPayload.paypalOrderId || paymentPayload.orderID || req.body.orderID || "").trim();
    const paypalCaptureId = String(paymentPayload.paypalCaptureId || paymentPayload.captureID || "").trim();

    const order = await Order.create({
      orderId: makeOrderId(),
      userId: req.user?.userId || undefined,
      items: normalizedItems,
      total,
      customer,
      payment: {
        method: "paypal",
        provider: "paypal",
        status: "paid",
        paypalOrderId,
        paypalCaptureId,
        payerEmail: String(paymentPayload.payerEmail || customer.email || ""),
        raw: paymentPayload,
      },
      status: "placed",
    });

    sendEmailInBackground(async () => {
      await sendOwnerAndCustomerOrderEmails(order);
    });

    res.json({ ok: true, order });
  } catch (e) {
    console.error("❌ Save paid order failed:", e);
    res.status(500).json({ error: "Save paid order failed", details: e.message });
  }
});

/* =========================================================
   ORDER ROUTES
   ========================================================= */
app.post("/api/orders", optionalAuth, async (req, res) => {
  try {
    const { items, customer, payment } = req.body || {};
    const normalizedItems = normalizeCheckoutItems(items, req.body.cart);

    if (!normalizedItems.length) {
      return res.status(400).json({ error: "Order items required" });
    }

    const normalizedCustomer = normalizeCustomer(customer);
    if (!normalizedCustomer.fullName || !normalizedCustomer.phone) {
      return res.status(400).json({ error: "Customer fullName and phone required" });
    }

    const total = normalizedItems.reduce((sum, it) => sum + it.price * it.qty, 0);

    const order = await Order.create({
      orderId: makeOrderId(),
      userId: req.user?.userId || undefined,
      items: normalizedItems,
      total,
      customer: normalizedCustomer,
      payment: {
        method: String(payment?.method || "cash").toLowerCase(),
        provider: String(payment?.provider || payment?.method || "cash").toLowerCase(),
        status: String(payment?.status || "pending").toLowerCase(),
      },
      status: "placed",
    });

    if (order.customer.email) {
      sendEmailInBackground(async () => {
        const html = buildCustomerEmailHtml({
          customerName: order.customer.fullName,
          orderId: order.orderId,
          status: order.status,
          paymentStatus: order.payment.status,
        });

        await sendEmail({
          to: order.customer.email,
          subject: `Community Kitchen Cafe — Order Received (${order.orderId})`,
          html,
          text: `Your order ${order.orderId} has been placed.`,
        });
      });
    }

    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: "Create order failed", details: e.message });
  }
});

app.get("/api/orders/my", requireAuth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.userId }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ error: "Failed to load orders", details: e.message });
  }
});

// Guest order lookup by email + phone for "My Orders" without login.
app.get("/api/orders/lookup", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const phone = String(req.query.phone || "").trim();

    if (!email && !phone) {
      return res.status(400).json({ error: "email or phone required" });
    }

    const filter = {};
    if (email) filter["customer.email"] = email;
    if (phone) filter["customer.phone"] = phone;

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ error: "Order lookup failed", details: e.message });
  }
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find({}).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ error: "Failed to load admin orders", details: e.message });
  }
});

app.put("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const { status, paymentStatus } = req.body || {};
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (status) order.status = String(status);
    if (paymentStatus) order.payment.status = String(paymentStatus);
    await order.save();

    if (order.customer.email) {
      sendEmailInBackground(async () => {
        const html = buildCustomerEmailHtml({
          customerName: order.customer.fullName,
          orderId: order.orderId,
          status: order.status,
          paymentStatus: order.payment.status,
        });

        await sendEmail({
          to: order.customer.email,
          subject: `Community Kitchen Cafe — Order Update (${order.orderId})`,
          html,
          text: `Your order ${order.orderId} is now ${order.status}.`,
        });
      });
    }

    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: "Order update failed", details: e.message });
  }
});

app.delete("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const removableStatuses = ["completed", "delivered", "cancelled"];
    if (!removableStatuses.includes(String(order.status))) {
      return res.status(400).json({
        error: "Only completed, delivered, or cancelled orders can be removed.",
        currentStatus: order.status,
      });
    }

    await Order.findByIdAndDelete(req.params.id);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: "Delete order failed", details: e.message });
  }
});

app.post("/api/admin/orders/:id/email", requireAdmin, async (req, res) => {
  try {
    const { subject, message } = req.body || {};
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.customer?.email) return res.status(400).json({ error: "Customer email missing" });

    const result = await sendEmail({
      to: order.customer.email,
      subject: subject || `Community Kitchen Cafe — Order Update (${order.orderId})`,
      text: message || "Your order has been updated.",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.5"><p>${escapeHtml(message || "Your order has been updated.")}</p></div>`,
    });

    if (!result.ok && result.skipped) return res.status(400).json(result);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Email failed", details: e.message });
  }
});

/* =========================================================
   ERROR HANDLING
   ========================================================= */
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  if (String(err.message || "").startsWith("CORS blocked")) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: "Server error", details: err.message });
});

app.listen(PORT, () => {
  console.log(`✅ Community Kitchen Cafe API running on port ${PORT}`);
  console.log("✅ PayPal configured:", Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET));
  console.log("✅ SMTP configured:", Boolean((SMTP_HOST && SMTP_USER && CLEAN_SMTP_PASS) || (GMAIL_USER && CLEAN_GMAIL_APP_PASSWORD)));
  console.log("✅ Owner email:", OWNER_EMAIL || "(missing)");
});
