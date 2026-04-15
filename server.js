require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const app = express();
app.set("trust proxy", 1);

const {
  PORT = 3000,
  MONGODB_URI,
  ADMIN_API_KEY,
  JWT_SECRET: JWT_SECRET_RAW,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  EMAIL_FROM,
  EMAIL_FROM_NAME,
  OWNER_EMAIL,
  PUBLIC_BASE_URL,
  GITHUB_PAGES_ORIGIN,
} = process.env;

const JWT_SECRET = String(JWT_SECRET_RAW || "").replace(/\s+/g, "").trim();

if (!MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI");
  process.exit(1);
}
if (!ADMIN_API_KEY) {
  console.error("❌ Missing ADMIN_API_KEY");
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("❌ Missing/weak JWT_SECRET (must be one line, 32+ chars)");
  process.exit(1);
}

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://eshetu70.github.io",
].filter(Boolean);

if (GITHUB_PAGES_ORIGIN) allowedOrigins.push(String(GITHUB_PAGES_ORIGIN).trim());

function isAllowed(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (allowedOrigins.includes(origin)) return true;
    if (u.protocol === "https:" && u.hostname === "eshetu70.github.io") return true;
    return false;
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isAllowed(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  })
);
app.options(/.*/, cors());

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    maxAge: "7d",
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cache-Control", "public, max-age=604800");
    },
  })
);

mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => console.log("✅ MongoDB connected"))
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
    category: {
      type: String,
      enum: ["breakfast", "lunch", "catering", "drink", "dessert"],
      default: "lunch",
    },
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
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "CafeUser", required: true, index: true },
    items: [
      {
        menuItemId: { type: String, required: true },
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
      method: { type: String, enum: ["cash", "card"], default: "cash" },
      status: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
    },
    status: {
      type: String,
      enum: ["placed", "confirmed", "preparing", "ready", "completed", "cancelled"],
      default: "placed",
    },
  },
  { timestamps: true }
);

const User = mongoose.model("CafeUser", userSchema, "cafe_users");
const MenuItem = mongoose.model("CafeMenuItem", menuItemSchema, "cafe_menu_items");
const Order = mongoose.model("CafeOrder", orderSchema, "cafe_orders");

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

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized (admin key required)" });
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

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only image files allowed (png/jpg/webp)"), ok);
  },
});

function getMailFrom() {
  const fromEmail = EMAIL_FROM || SMTP_USER || GMAIL_USER || "no-reply@communitykitchencafe.com";
  const fromName = EMAIL_FROM_NAME || "Community Kitchen Café";
  return `"${fromName}" <${fromEmail}>`;
}

async function createTransporter() {
  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: String(SMTP_SECURE || "").toLowerCase() === "true",
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }

  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }

  return null;
}

async function sendCustomerEmail({ to, subject, html, text }) {
  const transporter = await createTransporter();
  if (!transporter) return { ok: false, skipped: true, message: "Email not configured." };

  await transporter.sendMail({
    from: getMailFrom(),
    to,
    subject,
    text,
    html,
    replyTo: OWNER_EMAIL || undefined,
  });

  return { ok: true };
}

function buildCustomerEmailHtml({ customerName, orderId, status, paymentStatus }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:650px;margin:0 auto;padding:18px;border:1px solid #eee;border-radius:12px;">
    <h2 style="margin:0 0 10px;">Community Kitchen Café — Order Update</h2>
    <p>Hi ${escapeHtml(customerName || "Customer")},</p>
    <p>Your order has been updated.</p>
    <div style="background:#f7f7fb;border:1px solid #ececf3;border-radius:10px;padding:12px;">
      <div><b>Order ID:</b> ${escapeHtml(orderId)}</div>
      <div><b>Status:</b> ${escapeHtml(status)}</div>
      <div><b>Payment:</b> ${escapeHtml(paymentStatus)}</div>
    </div>
    <p style="margin-top:14px;">Thank you for ordering from Community Kitchen Café.</p>
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

app.get("/", (req, res) => {
  res.json({ ok: true, app: "Community Kitchen Café API", time: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "Community Kitchen Café API",
    time: new Date().toISOString(),
    origin: req.headers.origin || null,
    host: req.get("host"),
  });
});

app.get("/api/admin/ping", requireAdmin, (req, res) => {
  res.json({ ok: true, admin: true, time: new Date().toISOString() });
});

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
    if (!name || !price) return res.status(400).json({ error: "name and price required" });

    const image = req.file ? toAbsoluteUrl(req, `/uploads/${req.file.filename}`) : "";

    const item = await MenuItem.create({
      name: String(name).trim(),
      description: String(description || "").trim(),
      category: String(category).trim().toLowerCase(),
      price: Number(price),
      image,
      available: String(available) !== "false",

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

    const { name, description = "", category = "lunch", price, available = "true" } = req.body || {};
    if (!name || !price) return res.status(400).json({ error: "name and price required" });

    found.name = String(name).trim();
    found.description = String(description || "").trim();
    found.category = String(category).trim().toLowerCase();
    found.price = Number(price);
    found.available = String(available) !== "false";

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

    if (req.file) found.image = toAbsoluteUrl(req, `/uploads/${req.file.filename}`);

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
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: "Delete menu item failed", details: e.message });
  }
});

app.post("/api/orders", requireAuth, async (req, res) => {
  try {
    const { items, customer, payment } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Order items required" });
    }
    if (!customer?.fullName || !customer?.phone) {
      return res.status(400).json({ error: "Customer fullName and phone required" });
    }

    const normalizedItems = items.map((it) => ({
      menuItemId: String(it.menuItemId || it._id || ""),
      name: String(it.name || "").trim(),
      price: Number(it.price || 0),
      qty: Number(it.qty || 1),
      image: String(it.image || ""),
      selectedOptions: Array.isArray(it.selectedOptions)
        ? it.selectedOptions.map((group) => ({
            name: String(group?.name || "").trim(),
            values: Array.isArray(group?.values)
              ? group.values.map((x) => String(x).trim()).filter(Boolean)
              : [],
          }))
        : [],
    }));

    const total = normalizedItems.reduce((sum, it) => sum + it.price * it.qty, 0);

    const order = await Order.create({
      orderId: makeOrderId(),
      userId: req.user.userId,
      items: normalizedItems,
      total,
      customer: {
        fullName: String(customer.fullName || "").trim(),
        phone: String(customer.phone || "").trim(),
        email: String(customer.email || "").trim(),
        pickupTime: String(customer.pickupTime || "").trim(),
        notes: String(customer.notes || "").trim(),
      },
      payment: {
        method: ["cash", "card"].includes(String(payment?.method || "").toLowerCase())
          ? String(payment.method).toLowerCase()
          : "cash",
        status: "pending",
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

        await sendCustomerEmail({
          to: order.customer.email,
          subject: `Community Kitchen Café — Order Received (${order.orderId})`,
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

    if (status) order.status = status;
    if (paymentStatus) order.payment.status = paymentStatus;
    await order.save();

    if (order.customer.email) {
      sendEmailInBackground(async () => {
        const html = buildCustomerEmailHtml({
          customerName: order.customer.fullName,
          orderId: order.orderId,
          status: order.status,
          paymentStatus: order.payment.status,
        });

        await sendCustomerEmail({
          to: order.customer.email,
          subject: `Community Kitchen Café — Order Update (${order.orderId})`,
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

app.post("/api/admin/orders/:id/email", requireAdmin, async (req, res) => {
  try {
    const { subject, message } = req.body || {};
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.customer?.email) return res.status(400).json({ error: "Customer email missing" });

    const result = await sendCustomerEmail({
      to: order.customer.email,
      subject: subject || `Community Kitchen Café — Order Update (${order.orderId})`,
      text: message || "Your order has been updated.",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.5"><p>${escapeHtml(message || "Your order has been updated.")}</p></div>`,
    });

    if (!result.ok && result.skipped) return res.status(400).json(result);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Email failed", details: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Community Kitchen Café API running on port ${PORT}`);
});