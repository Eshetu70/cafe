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

const {
  PORT = 3000,
  MONGODB_URI,
  ADMIN_API_KEY,
  JWT_SECRET: JWT_SECRET_RAW,

  // Email / SMTP
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS: SMTP_PASS_RAW,
  GMAIL_USER,
  GMAIL_APP_PASSWORD: GMAIL_APP_PASSWORD_RAW,
  EMAIL_FROM,
  EMAIL_FROM_NAME,
  OWNER_EMAIL,

  // PayPal
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_BASE_URL = "https://api-m.paypal.com",

  // Frontend / CORS
  PUBLIC_BASE_URL,
  GITHUB_PAGES_ORIGIN,
  FRONTEND_ORIGIN,
  CORS_ORIGINS,
} = process.env;

// Remove hidden spaces/newlines from secrets copied from Google/Render UI.
const JWT_SECRET = String(JWT_SECRET_RAW || "").replace(/\s+/g, "").trim();
const ADMIN_KEY = String(ADMIN_API_KEY || "").trim();
const SMTP_PASS = String(SMTP_PASS_RAW || "").replace(/\s+/g, "").trim();
const GMAIL_APP_PASSWORD = String(GMAIL_APP_PASSWORD_RAW || "").replace(/\s+/g, "").trim();
const PAYPAL_SECRET = String(PAYPAL_CLIENT_SECRET || "").replace(/\s+/g, "").trim();

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

const envCorsOrigins = String(CORS_ORIGINS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

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
  ...envCorsOrigins,
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
      (u.hostname === "communitykitchencafe.com" || u.hostname === "www.communitykitchencafe.com")
    ) return true;
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
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key", "Range"],
  exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length", "Content-Type"],
  credentials: true,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

let imageBucket;
mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    imageBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "cafe_images" });
    console.log("✅ MongoDB connected");
    console.log("✅ MongoDB GridFS image storage ready");
  })
  .catch((err) => {
    console.error("❌ MongoDB error:", err.message);
    process.exit(1);
  });

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
    category: { type: String, default: "lunch", trim: true },
    price: { type: Number, required: true },
    image: { type: String, default: "" },
    available: { type: Boolean, default: true },
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
    // Optional because PayPal checkout may be guest checkout.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "CafeUser", required: false, index: true },
    items: [
      {
        menuItemId: { type: String, default: "" },
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
      phone: { type: String, required: true },
      email: { type: String, default: "" },
      pickupTime: { type: String, default: "" },
      notes: { type: String, default: "" },
    },
    payment: {
      method: { type: String, enum: ["cash", "card", "paypal"], default: "paypal" },
      status: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
      paypalOrderId: { type: String, default: "" },
      paypalCaptureId: { type: String, default: "" },
      payerEmail: { type: String, default: "" },
    },
    status: {
      type: String,
      enum: ["placed", "confirmed", "preparing", "ready", "completed", "delivered", "cancelled"],
      default: "placed",
    },
  },
  { timestamps: true }
);


const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    type: { type: String, default: "Announcement", trim: true },
    message: { type: String, required: true, default: "" },
    mediaUrl: { type: String, default: "" },
    mediaType: { type: String, enum: ["image", "video", "none"], default: "none" },
    link: { type: String, default: "" },
    active: { type: Boolean, default: true },
    startDate: { type: String, default: "" },
    endDate: { type: String, default: "" },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const User = mongoose.model("CafeUser", userSchema, "cafe_users");
const MenuItem = mongoose.model("CafeMenuItem", menuItemSchema, "cafe_menu_items");
const Order = mongoose.model("CafeOrder", orderSchema, "cafe_orders");
const Announcement = mongoose.model("CafeAnnouncement", announcementSchema, "cafe_announcements");

function baseUrlFromReq(req) {
  if (PUBLIC_BASE_URL) return String(PUBLIC_BASE_URL).replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0].trim();
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

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(v) {
  return Number(v || 0).toFixed(2);
}

function requireAdmin(req, res, next) {
  const key = String(req.headers["x-admin-key"] || req.query.adminKey || "").trim();
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized (admin key required)" });
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only image files allowed (png/jpg/webp)"), ok);
  },
});

// Separate upload handler for owner announcements.
// This supports larger images and videos so one admin upload shows on every device.
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const type = String(file.mimetype || "").toLowerCase();
    const ok = type.startsWith("image/") || type.startsWith("video/");
    cb(ok ? null : new Error("Only image or video files allowed"), ok);
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
      metadata: { originalName: file.originalname || filename, uploadedAt: new Date() },
    });
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(file.buffer);
  });
  return toAbsoluteUrl(req, `/api/images/${fileId.toString()}`);
}


function getSafeMediaExt(file) {
  const original = String(file?.originalname || "").toLowerCase();
  const mime = String(file?.mimetype || "").toLowerCase();
  if (original.endsWith(".png") || mime === "image/png") return ".png";
  if (original.endsWith(".webp") || mime === "image/webp") return ".webp";
  if (original.endsWith(".gif") || mime === "image/gif") return ".gif";
  if (original.endsWith(".avif") || mime === "image/avif") return ".avif";
  if (original.endsWith(".mp4") || mime === "video/mp4") return ".mp4";
  if (original.endsWith(".webm") || mime === "video/webm") return ".webm";
  if (original.endsWith(".ogg") || mime === "video/ogg") return ".ogg";
  if (original.endsWith(".mov") || mime === "video/quicktime") return ".mov";
  if (original.endsWith(".jpeg")) return ".jpeg";
  return ".jpg";
}

async function saveMediaToMongo(req, file) {
  if (!file) return "";
  if (!imageBucket) throw new Error("Media storage is not ready yet");
  const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}${getSafeMediaExt(file)}`;
  const fileId = await new Promise((resolve, reject) => {
    const uploadStream = imageBucket.openUploadStream(filename, {
      contentType: file.mimetype || "application/octet-stream",
      metadata: { originalName: file.originalname || filename, uploadedAt: new Date(), kind: "owner-post-media" },
    });
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(file.buffer);
  });
  return toAbsoluteUrl(req, `/api/media/${fileId.toString()}`);
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

function parseCsvList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
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
        options: Array.isArray(group?.options) ? group.options.map((x) => String(x).trim()).filter(Boolean) : [],
      }))
      .filter((group) => group.name && group.options.length > 0);
  } catch {
    return [];
  }
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      menuItemId: String(it.menuItemId || it._id || it.id || ""),
      name: String(it.name || "").trim(),
      price: Number(it.price || 0),
      qty: Math.max(1, Number(it.qty || it.quantity || 1)),
      image: String(it.image || ""),
      selectedOptions: Array.isArray(it.selectedOptions)
        ? it.selectedOptions.map((group) => ({
            name: String(group?.name || "").trim(),
            values: Array.isArray(group?.values) ? group.values.map((x) => String(x).trim()).filter(Boolean) : [],
          }))
        : [],
    }))
    .filter((it) => it.name && it.price >= 0 && it.qty > 0);
}

function getMailFrom() {
  const fromEmail = EMAIL_FROM || SMTP_USER || GMAIL_USER || "no-reply@communitykitchencafe.com";
  const fromName = EMAIL_FROM_NAME || "Community Kitchen Cafe";
  return `"${fromName}" <${fromEmail}>`;
}

function smtpConfigured() {
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

function paypalConfigured() {
  return Boolean(PAYPAL_CLIENT_ID && PAYPAL_SECRET && PAYPAL_BASE_URL);
}

async function createTransporter() {
  if (smtpConfigured()) {
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: String(SMTP_SECURE || "").toLowerCase() === "true",
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  }
  return null;
}

async function sendEmail({ to, subject, html, text, replyTo }) {
  const transporter = await createTransporter();
  if (!transporter) throw new Error("Email not configured. Check SMTP_HOST, SMTP_USER, SMTP_PASS, OWNER_EMAIL in Render.");
  if (!to) throw new Error("Email recipient missing.");
  await transporter.sendMail({ from: getMailFrom(), to, subject, text, html, replyTo: replyTo || OWNER_EMAIL || undefined });
  return { ok: true };
}

function buildItemsRows(items) {
  return (items || [])
    .map((item) => {
      const qty = Number(item.qty || 1);
      const price = Number(item.price || 0);
      const options = (item.selectedOptions || [])
        .map((g) => `${escapeHtml(g.name)}: ${escapeHtml((g.values || []).join(", "))}`)
        .join("<br>");
      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;">
            <b>${escapeHtml(item.name)}</b>${options ? `<br><small>${options}</small>` : ""}
          </td>
          <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;">${qty}</td>
          <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;">$${money(price)}</td>
          <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;">$${money(qty * price)}</td>
        </tr>`;
    })
    .join("");
}

function buildOwnerOrderEmailHtml(order) {
  const customer = order.customer || {};
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:760px;margin:0 auto;padding:18px;border:1px solid #eee;border-radius:12px;">
    <h2 style="margin:0 0 10px;color:#5c2e0e;">New Customer Order — Community Kitchen Cafe</h2>
    <p style="margin:0 0 14px;"><b>Order ID:</b> ${escapeHtml(order.orderId)}</p>

    <div style="background:#fff8f0;border:1px solid #ede0d4;border-radius:10px;padding:14px;margin-bottom:14px;">
      <h3 style="margin:0 0 8px;">Customer Details</h3>
      <p><b>Name:</b> ${escapeHtml(customer.fullName || "")}</p>
      <p><b>Phone:</b> ${escapeHtml(customer.phone || "")}</p>
      <p><b>Email:</b> ${escapeHtml(customer.email || "")}</p>
      <p><b>Pickup Time:</b> ${escapeHtml(customer.pickupTime || "ASAP")}</p>
      <p><b>Notes:</b> ${escapeHtml(customer.notes || "None")}</p>
    </div>

    <h3>Food Order</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f7f3ec;">
          <th style="text-align:left;padding:10px;border-bottom:2px solid #ddd;">Item</th>
          <th style="text-align:left;padding:10px;border-bottom:2px solid #ddd;">Qty</th>
          <th style="text-align:left;padding:10px;border-bottom:2px solid #ddd;">Price</th>
          <th style="text-align:left;padding:10px;border-bottom:2px solid #ddd;">Total</th>
        </tr>
      </thead>
      <tbody>${buildItemsRows(order.items)}</tbody>
    </table>

    <h2 style="margin-top:16px;">Total: $${money(order.total)}</h2>
    <p><b>Payment:</b> ${escapeHtml(order.payment?.status || "pending")} via ${escapeHtml(order.payment?.method || "")}</p>
    ${order.payment?.paypalOrderId ? `<p><b>PayPal Order ID:</b> ${escapeHtml(order.payment.paypalOrderId)}</p>` : ""}
    ${order.payment?.paypalCaptureId ? `<p><b>PayPal Capture ID:</b> ${escapeHtml(order.payment.paypalCaptureId)}</p>` : ""}
    <p><b>Status:</b> ${escapeHtml(order.status || "placed")}</p>
  </div>`;
}

function buildCustomerReceiptHtml(order) {
  const customer = order.customer || {};
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:700px;margin:0 auto;padding:18px;border:1px solid #eee;border-radius:12px;">
    <h2 style="color:#5c2e0e;margin:0 0 10px;">Thank you for your order</h2>
    <p>Hi ${escapeHtml(customer.fullName || "Customer")}, your order has been received.</p>
    <p><b>Order ID:</b> ${escapeHtml(order.orderId)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead><tr style="background:#f7f3ec;"><th style="text-align:left;padding:10px;">Item</th><th style="text-align:left;padding:10px;">Qty</th><th style="text-align:left;padding:10px;">Price</th><th style="text-align:left;padding:10px;">Total</th></tr></thead>
      <tbody>${buildItemsRows(order.items)}</tbody>
    </table>
    <h3>Total: $${money(order.total)}</h3>
    <p><b>Status:</b> ${escapeHtml(order.status || "placed")}</p>
    <p>Pickup at Community Kitchen Cafe, 811 N Charlotte Ave, Monroe NC.</p>
  </div>`;
}

async function sendOwnerOrderEmail(order) {
  if (!OWNER_EMAIL) throw new Error("OWNER_EMAIL is missing in Render.");
  await sendEmail({
    to: OWNER_EMAIL,
    subject: `New Customer Order — ${order.orderId}`,
    html: buildOwnerOrderEmailHtml(order),
    text: `New order ${order.orderId} from ${order.customer?.fullName || "customer"}. Total: $${money(order.total)}.`,
  });
}

async function sendCustomerReceiptEmail(order) {
  const to = order.customer?.email;
  if (!to) return { skipped: true, message: "Customer email missing." };
  return sendEmail({
    to,
    subject: `Community Kitchen Cafe — Order Received (${order.orderId})`,
    html: buildCustomerReceiptHtml(order),
    text: `Your order ${order.orderId} has been received. Total: $${money(order.total)}.`,
  });
}

function sendEmailInBackground(fn) {
  setImmediate(async () => {
    try { await fn(); } catch (e) { console.warn("⚠️ Background email failed:", e.message); }
  });
}

async function savePaidOrder({ items, customer, paypalOrderId = "", paypalCaptureId = "", payerEmail = "", userId = null }) {
  const normalizedItems = normalizeItems(items);
  if (!normalizedItems.length) throw new Error("Order items required");
  if (!customer?.fullName || !customer?.phone) throw new Error("Customer fullName and phone required");
  const total = normalizedItems.reduce((sum, it) => sum + it.price * it.qty, 0);

  // Prevent duplicate save from repeated frontend callbacks.
  if (paypalOrderId) {
    const existing = await Order.findOne({ "payment.paypalOrderId": paypalOrderId });
    if (existing) return existing;
  }

  const order = await Order.create({
    orderId: makeOrderId(),
    userId: userId || undefined,
    items: normalizedItems,
    total,
    customer: {
      fullName: String(customer.fullName || customer.name || "").trim(),
      phone: String(customer.phone || "").trim(),
      email: String(customer.email || payerEmail || "").trim(),
      pickupTime: String(customer.pickupTime || "").trim(),
      notes: String(customer.notes || "").trim(),
    },
    payment: {
      method: "paypal",
      status: "paid",
      paypalOrderId,
      paypalCaptureId,
      payerEmail,
    },
    status: "placed",
  });

  sendEmailInBackground(async () => sendOwnerOrderEmail(order));
  sendEmailInBackground(async () => sendCustomerReceiptEmail(order));
  return order;
}

async function getPayPalAccessToken() {
  if (!paypalConfigured()) throw new Error("PayPal not configured. Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL.");
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_BASE_URL.replace(/\/+$/, "")}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "PayPal auth failed");
  return data.access_token;
}

async function createPayPalOrderFromCart(items) {
  const normalizedItems = normalizeItems(items);
  if (!normalizedItems.length) throw new Error("Cart items required");
  const total = normalizedItems.reduce((sum, it) => sum + it.price * it.qty, 0);
  const accessToken = await getPayPalAccessToken();
  const paypalItems = normalizedItems.map((it) => ({
    name: it.name.slice(0, 127),
    quantity: String(it.qty),
    unit_amount: { currency_code: "USD", value: money(it.price) },
  }));
  const response = await fetch(`${PAYPAL_BASE_URL.replace(/\/+$/, "")}/v2/checkout/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        description: "Community Kitchen Cafe Online Food Order",
        amount: {
          currency_code: "USD",
          value: money(total),
          breakdown: { item_total: { currency_code: "USD", value: money(total) } },
        },
        items: paypalItems,
      }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.details?.[0]?.description || "PayPal create order failed");
  return data;
}

async function capturePayPalOrder(orderID) {
  if (!orderID) throw new Error("PayPal orderID required");
  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL.replace(/\/+$/, "")}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.details?.[0]?.description || "PayPal capture failed");
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base / health / admin test
// ─────────────────────────────────────────────────────────────────────────────
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
    smtpConfigured: smtpConfigured() || Boolean(GMAIL_USER && GMAIL_APP_PASSWORD),
    ownerEmailConfigured: Boolean(OWNER_EMAIL),
    paypalConfigured: paypalConfigured(),
    smtpUser: SMTP_USER || GMAIL_USER || null,
    ownerEmail: OWNER_EMAIL || null,
  });
});

app.get("/api/admin/ping", requireAdmin, (req, res) => {
  res.json({ ok: true, admin: true, time: new Date().toISOString() });
});

async function handleTestEmail(req, res) {
  try {
    if (!OWNER_EMAIL) throw new Error("OWNER_EMAIL missing in Render.");
    await sendEmail({
      to: OWNER_EMAIL,
      subject: "Community Kitchen Cafe — Test Email",
      html: `<h2>Test Email Successful</h2><p>Your website email setup is working.</p><p>Orders will be sent to ${escapeHtml(OWNER_EMAIL)}.</p>`,
      text: "Community Kitchen Cafe test email successful.",
    });
    res.json({ ok: true, message: "Test email sent", to: OWNER_EMAIL });
  } catch (e) {
    console.error("❌ Test email failed:", e.message);
    res.status(500).json({ ok: false, error: "Email test failed", details: e.message });
  }
}
app.post("/api/admin/test-email", requireAdmin, handleTestEmail);
app.get("/api/admin/test-email", requireAdmin, handleTestEmail);

// ─────────────────────────────────────────────────────────────────────────────
// Images
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/images/:id", async (req, res) => {
  try {
    if (!imageBucket) return res.status(503).json({ error: "Image storage not ready" });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid image id" });
    const fileId = new ObjectId(req.params.id);
    const files = await mongoose.connection.db.collection("cafe_images.files").find({ _id: fileId }).limit(1).toArray();
    if (!files.length) return res.status(404).json({ error: "Image not found" });
    const file = files[0];
    res.setHeader("Content-Type", file.contentType || "image/jpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    const downloadStream = imageBucket.openDownloadStream(fileId);
    downloadStream.on("error", () => { if (!res.headersSent) res.status(404).json({ error: "Image not found" }); else res.end(); });
    downloadStream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: "Failed to load image", details: e.message });
  }
});

// Public media endpoint for announcement images and videos, with Range support for videos.
app.get("/api/media/:id", async (req, res) => {
  try {
    if (!imageBucket) return res.status(503).json({ error: "Media storage not ready" });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid media id" });

    const fileId = new ObjectId(req.params.id);
    const files = await mongoose.connection.db.collection("cafe_images.files").find({ _id: fileId }).limit(1).toArray();
    if (!files.length) return res.status(404).json({ error: "Media not found" });

    const file = files[0];
    const contentType = file.contentType || "application/octet-stream";
    const fileSize = Number(file.length || 0);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Type", contentType);

    const range = req.headers.range;
    if (range && fileSize > 0) {
      const parts = String(range).replace(/bytes=/, "").split("-");
      const start = Math.max(0, parseInt(parts[0], 10) || 0);
      const end = parts[1] ? Math.min(fileSize - 1, parseInt(parts[1], 10)) : fileSize - 1;
      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
        return res.end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", String(end - start + 1));
      return imageBucket.openDownloadStream(fileId, { start, end: end + 1 }).pipe(res);
    }

    res.setHeader("Content-Length", String(fileSize));
    imageBucket.openDownloadStream(fileId).pipe(res);
  } catch (e) {
    res.status(500).json({ error: "Failed to load media", details: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password } = req.body || {};
    if (!fullName || !email || !password) return res.status(400).json({ error: "fullName, email, password required" });
    const cleanEmail = String(email).trim().toLowerCase();
    const exists = await User.findOne({ email: cleanEmail }).lean();
    if (exists) return res.status(409).json({ error: "Email already registered" });
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.create({ fullName: String(fullName).trim(), email: cleanEmail, passwordHash });
    const token = jwt.sign({ userId: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ ok: true, token, user: { id: String(user._id), fullName: user.fullName, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: "Register failed", details: e.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email and password required" });
    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ userId: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ ok: true, token, user: { id: String(user._id), fullName: user.fullName, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: "Login failed", details: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────────────────────────
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
    const { name, description = "", category = "lunch", price, available = "true" } = req.body || {};
    if (!name || price === undefined || price === "") return res.status(400).json({ error: "name and price required" });
    const image = req.file ? await saveImageToMongo(req, req.file) : "";
    const item = await MenuItem.create({
      name: String(name).trim(), description: String(description || "").trim(), category: String(category).trim().toLowerCase(), price: Number(price), image,
      available: String(available) !== "false", ingredients: parseCsvList(req.body.ingredients), calories: Number(req.body.calories || 0), allergens: parseCsvList(req.body.allergens),
      nutrition: { protein: String(req.body.protein || "").trim(), carbs: String(req.body.carbs || "").trim(), fat: String(req.body.fat || "").trim(), sodium: String(req.body.sodium || "").trim() },
      optionGroups: parseOptionGroups(req.body.optionGroups),
    });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: "Create menu item failed", details: e.message });
  }
});

app.put("/api/menu/:id", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const found = await MenuItem.findById(req.params.id);
    if (!found) return res.status(404).json({ error: "Menu item not found" });
    const { name, description = "", category = "lunch", price, available = "true" } = req.body || {};
    if (!name || price === undefined || price === "") return res.status(400).json({ error: "name and price required" });
    found.name = String(name).trim();
    found.description = String(description || "").trim();
    found.category = String(category).trim().toLowerCase();
    found.price = Number(price);
    found.available = String(available) !== "false";
    found.ingredients = parseCsvList(req.body.ingredients);
    found.calories = Number(req.body.calories || 0);
    found.allergens = parseCsvList(req.body.allergens);
    found.nutrition = { protein: String(req.body.protein || "").trim(), carbs: String(req.body.carbs || "").trim(), fat: String(req.body.fat || "").trim(), sodium: String(req.body.sodium || "").trim() };
    found.optionGroups = parseOptionGroups(req.body.optionGroups);
    if (req.file) { await deleteImageFromMongoByUrl(found.image); found.image = await saveImageToMongo(req, req.file); }
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

// ─────────────────────────────────────────────────────────────────────────────
// Owner Posts / Announcements
// ─────────────────────────────────────────────────────────────────────────────
function cleanAnnouncementPayload(req) {
  const body = req.body || {};
  const uploadedUrl = req.file ? null : "";
  const mediaUrl = String(body.mediaUrl || body.image || uploadedUrl || "").trim();
  const fileType = req.file?.mimetype?.startsWith("video/") ? "video" : req.file?.mimetype?.startsWith("image/") ? "image" : "";
  const guessedType = String(body.mediaType || "").toLowerCase() === "video" || /\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(mediaUrl) ? "video" : mediaUrl ? "image" : "none";
  return {
    title: String(body.title || "").trim(),
    type: String(body.type || body.category || "Announcement").trim(),
    message: String(body.message || body.text || "").trim(),
    mediaUrl,
    mediaType: fileType || guessedType,
    link: String(body.link || body.buttonLink || "").trim(),
    active: String(body.active ?? "true") !== "false",
    startDate: String(body.startDate || "").slice(0, 10),
    endDate: String(body.endDate || "").slice(0, 10),
    sortOrder: Number(body.sortOrder || 0),
  };
}

function announcementToClient(post) {
  const p = post.toObject ? post.toObject() : post;
  return {
    _id: String(p._id),
    id: String(p._id),
    title: p.title || "Announcement",
    type: p.type || "Announcement",
    message: p.message || "",
    image: p.mediaUrl || "",
    mediaUrl: p.mediaUrl || "",
    mediaType: p.mediaType || (p.mediaUrl ? "image" : "none"),
    link: p.link || "",
    active: p.active !== false,
    startDate: p.startDate || "",
    endDate: p.endDate || "",
    sortOrder: Number(p.sortOrder || 0),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function publicAnnouncementFilter() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    active: true,
    $and: [
      { $or: [{ startDate: "" }, { startDate: { $exists: false } }, { startDate: { $lte: today } }] },
      { $or: [{ endDate: "" }, { endDate: { $exists: false } }, { endDate: { $gte: today } }] },
    ],
  };
}

async function handleCreateAnnouncement(req, res) {
  try {
    const payload = cleanAnnouncementPayload(req);
    if (!payload.title || !payload.message) return res.status(400).json({ error: "title and message required" });
    if (req.file) {
      payload.mediaUrl = await saveMediaToMongo(req, req.file);
      payload.mediaType = req.file.mimetype.startsWith("video/") ? "video" : "image";
    }
    const post = await Announcement.create(payload);
    res.json({ ok: true, post: announcementToClient(post), announcement: announcementToClient(post) });
  } catch (e) {
    console.error("❌ Create announcement failed:", e.message);
    res.status(500).json({ ok: false, error: "Create announcement failed", details: e.message });
  }
}

async function handleUpdateAnnouncement(req, res) {
  try {
    const post = await Announcement.findById(req.params.id);
    if (!post) return res.status(404).json({ error: "Announcement not found" });
    const oldMediaUrl = post.mediaUrl;
    const payload = cleanAnnouncementPayload(req);
    if (!payload.title || !payload.message) return res.status(400).json({ error: "title and message required" });
    if (req.file) {
      payload.mediaUrl = await saveMediaToMongo(req, req.file);
      payload.mediaType = req.file.mimetype.startsWith("video/") ? "video" : "image";
    }
    Object.assign(post, payload);
    await post.save();
    if (req.file && oldMediaUrl && oldMediaUrl !== post.mediaUrl) await deleteImageFromMongoByUrl(oldMediaUrl);
    res.json({ ok: true, post: announcementToClient(post), announcement: announcementToClient(post) });
  } catch (e) {
    console.error("❌ Update announcement failed:", e.message);
    res.status(500).json({ ok: false, error: "Update announcement failed", details: e.message });
  }
}

app.get("/api/announcements", async (req, res) => {
  try {
    const posts = await Announcement.find(publicAnnouncementFilter()).sort({ sortOrder: -1, createdAt: -1 }).lean();
    res.json({ ok: true, posts: posts.map(announcementToClient), announcements: posts.map(announcementToClient) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to load announcements", details: e.message });
  }
});

// Alias used by some frontend versions.
app.get("/api/posts", async (req, res) => {
  try {
    const posts = await Announcement.find(publicAnnouncementFilter()).sort({ sortOrder: -1, createdAt: -1 }).lean();
    res.json({ ok: true, posts: posts.map(announcementToClient) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to load posts", details: e.message });
  }
});

app.get("/api/admin/announcements", requireAdmin, async (req, res) => {
  try {
    const posts = await Announcement.find({}).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, posts: posts.map(announcementToClient), announcements: posts.map(announcementToClient) });
  } catch (e) {
    res.status(500).json({ error: "Failed to load admin announcements", details: e.message });
  }
});

app.get("/api/admin/posts", requireAdmin, async (req, res) => {
  try {
    const posts = await Announcement.find({}).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, posts: posts.map(announcementToClient) });
  } catch (e) {
    res.status(500).json({ error: "Failed to load admin posts", details: e.message });
  }
});

app.post("/api/admin/announcements", requireAdmin, mediaUpload.single("media"), handleCreateAnnouncement);
app.post("/api/admin/posts", requireAdmin, mediaUpload.single("media"), handleCreateAnnouncement);

app.put("/api/admin/announcements/:id", requireAdmin, mediaUpload.single("media"), handleUpdateAnnouncement);
app.put("/api/admin/posts/:id", requireAdmin, mediaUpload.single("media"), handleUpdateAnnouncement);

app.delete("/api/admin/announcements/:id", requireAdmin, async (req, res) => {
  try {
    const post = await Announcement.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ error: "Announcement not found" });
    await deleteImageFromMongoByUrl(post.mediaUrl);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: "Delete announcement failed", details: e.message });
  }
});
app.delete("/api/admin/posts/:id", requireAdmin, async (req, res) => {
  try {
    const post = await Announcement.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });
    await deleteImageFromMongoByUrl(post.mediaUrl);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: "Delete post failed", details: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PayPal routes
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const items = req.body?.items || req.body?.cart || [];
    const data = await createPayPalOrderFromCart(items);
    res.json(data);
  } catch (e) {
    console.error("❌ PayPal create-order failed:", e.message);
    res.status(500).json({ ok: false, error: "PayPal create-order failed", details: e.message });
  }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID, paypalOrderId, items, cart, customer } = req.body || {};
    const id = orderID || paypalOrderId;
    const capture = await capturePayPalOrder(id);
    const captureId = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id || "";
    const payerEmail = capture?.payer?.email_address || customer?.email || "";
    const order = await savePaidOrder({ items: items || cart || [], customer: customer || {}, paypalOrderId: id, paypalCaptureId: captureId, payerEmail });
    res.json({ ok: true, capture, order });
  } catch (e) {
    console.error("❌ PayPal capture-order failed:", e.message);
    res.status(500).json({ ok: false, error: "PayPal capture-order failed", details: e.message });
  }
});

// Browser-side PayPal checkout can call this after payment success to save order and email owner.
app.post("/api/orders/paid", async (req, res) => {
  try {
    const { items, cart, customer, paypalOrderId, paypalCaptureId, payerEmail } = req.body || {};
    const order = await savePaidOrder({ items: items || cart || [], customer: customer || {}, paypalOrderId, paypalCaptureId, payerEmail });
    res.json({ ok: true, order });
  } catch (e) {
    console.error("❌ Save paid order failed:", e.message);
    res.status(500).json({ ok: false, error: "Save paid order failed", details: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/orders", requireAuth, async (req, res) => {
  try {
    const { items, customer, payment } = req.body || {};
    const normalizedItems = normalizeItems(items);
    if (!normalizedItems.length) return res.status(400).json({ error: "Order items required" });
    if (!customer?.fullName || !customer?.phone) return res.status(400).json({ error: "Customer fullName and phone required" });
    const total = normalizedItems.reduce((sum, it) => sum + it.price * it.qty, 0);
    const order = await Order.create({
      orderId: makeOrderId(), userId: req.user.userId, items: normalizedItems, total,
      customer: { fullName: String(customer.fullName || "").trim(), phone: String(customer.phone || "").trim(), email: String(customer.email || "").trim(), pickupTime: String(customer.pickupTime || "").trim(), notes: String(customer.notes || "").trim() },
      payment: { method: ["cash", "card", "paypal"].includes(String(payment?.method || "").toLowerCase()) ? String(payment.method).toLowerCase() : "cash", status: String(payment?.status || "pending").toLowerCase() === "paid" ? "paid" : "pending" },
      status: "placed",
    });
    sendEmailInBackground(async () => sendOwnerOrderEmail(order));
    sendEmailInBackground(async () => sendCustomerReceiptEmail(order));
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

// Optional customer lookup for guest orders.
app.get("/api/orders/lookup", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const phone = String(req.query.phone || "").trim();
    if (!email && !phone) return res.status(400).json({ error: "email or phone required" });
    const filter = email ? { "customer.email": email } : { "customer.phone": phone };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(25).lean();
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ error: "Failed to lookup orders", details: e.message });
  }
});


async function findOrderByAnyId(id) {
  const clean = String(id || "").trim();
  if (!clean) return null;
  if (mongoose.Types.ObjectId.isValid(clean)) {
    const byMongoId = await Order.findById(clean);
    if (byMongoId) return byMongoId;
  }
  return Order.findOne({ orderId: clean });
}

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
    const order = await findOrderByAnyId(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (status) order.status = status;
    if (paymentStatus) order.payment.status = paymentStatus;
    await order.save();
    if (order.customer.email) sendEmailInBackground(async () => sendCustomerReceiptEmail(order));
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: "Order update failed", details: e.message });
  }
});


app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status, paymentStatus } = req.body || {};
    const order = await findOrderByAnyId(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (status) order.status = status;
    if (paymentStatus) order.payment.status = paymentStatus;
    await order.save();
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: "Order status update failed", details: e.message });
  }
});

app.delete("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const order = await findOrderByAnyId(req.params.id);
    if (!order) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }

    // Admin requested: after reviewing an order, owner can choose to keep it or remove it.
    // We do NOT block deletion by status anymore, because the frontend may show delivered locally
    // even if the backend status update failed or used a different status value.
    await Order.deleteOne({ _id: order._id });

    res.json({
      ok: true,
      deleted: true,
      removedOrderId: order.orderId,
      removedMongoId: String(order._id),
    });
  } catch (e) {
    console.error("❌ Delete order failed:", e);
    res.status(500).json({ ok: false, error: "Delete order failed", details: e.message });
  }
});

app.post("/api/admin/orders/:id/remove", requireAdmin, async (req, res) => {
  try {
    const order = await findOrderByAnyId(req.params.id);
    if (!order) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }
    await Order.deleteOne({ _id: order._id });
    res.json({ ok: true, deleted: true, removedOrderId: order.orderId, removedMongoId: String(order._id) });
  } catch (e) {
    console.error("❌ Remove order failed:", e);
    res.status(500).json({ ok: false, error: "Remove order failed", details: e.message });
  }
});

app.post("/api/admin/orders/:id/email", requireAdmin, async (req, res) => {
  try {
    const { subject, message } = req.body || {};
    const order = await findOrderByAnyId(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.customer?.email) return res.status(400).json({ error: "Customer email missing" });
    await sendEmail({
      to: order.customer.email,
      subject: subject || `Community Kitchen Cafe — Order Update (${order.orderId})`,
      text: message || "Your order has been updated.",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.5"><p>${escapeHtml(message || "Your order has been updated.")}</p></div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Email failed", details: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Community Kitchen Cafe API running on port ${PORT}`);
  console.log(`✅ SMTP configured: ${smtpConfigured() || Boolean(GMAIL_USER && GMAIL_APP_PASSWORD)}`);
  console.log(`✅ Owner email: ${OWNER_EMAIL || "missing"}`);
  console.log(`✅ PayPal configured: ${paypalConfigured()}`);
});
