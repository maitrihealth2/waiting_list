require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

// Firebase SDK (Client SDK works with web config credentials; Admin SDK if service account provided)
const { initializeApp: initClientApp } = require("firebase/app");
const {
  getFirestore: getClientFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  arrayUnion,
  increment,
} = require("firebase/firestore");

/* ------------------------------------------------------------------ */
/* Environment Validation - ZERO Fallback Secrets                      */
/* ------------------------------------------------------------------ */

const requiredEnvVars = [
  "FIREBASE_PROJECT_ID",
  "SMTP_USER",
  "SMTP_PASS",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`[FATAL CONFIG ERROR] Missing required environment variable: '${envVar}' in .env`);
    process.exit(1);
  }
}

if (!process.env.FIREBASE_API_KEY && !process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  console.error("[FATAL CONFIG ERROR] Either FIREBASE_API_KEY or FIREBASE_SERVICE_ACCOUNT_PATH must be set in .env");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const PORT = parseInt(process.env.PORT || "3000", 10);
const WAITLIST_COLLECTION = process.env.WAITLIST_COLLECTION || "waitlist";
const EMAILS_COLLECTION = process.env.EMAILS_COLLECTION || "emails";
const SUBSCRIBERS_COLLECTION = process.env.SUBSCRIBERS_COLLECTION || "subscribers";
const ALL_EMAILS_DOC = process.env.ALL_EMAILS_DOC || "meta/all_emails";
const COUNTER_DOC = "meta/waitlistCounter";

const REFERENCE_PREFIX = process.env.REFERENCE_PREFIX || "WL-";
const REFERENCE_DIGITS = parseInt(process.env.REFERENCE_DIGITS || "5", 10);
const EMAIL_SUBJECT = process.env.EMAIL_SUBJECT || "You're on the Affyne Labs waiting list, {{name}}!";
const DATE_LOCALE = process.env.DATE_LOCALE || "en-IN";
const DATE_TIMEZONE = process.env.DATE_TIMEZONE || "Asia/Kolkata";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://affynelabs.com";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

const HTML_TEMPLATE_PATH = path.join(__dirname, "templates", "welcome.html");
const TEXT_TEMPLATE_PATH = path.join(__dirname, "templates", "welcome.txt");

/* ------------------------------------------------------------------ */
/* Firebase Initialization (Reads Exclusively from process.env)        */
/* ------------------------------------------------------------------ */

function getFirestoreInstance() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath && fs.existsSync(path.resolve(serviceAccountPath))) {
    try {
      const admin = require("firebase-admin");
      const serviceAccount = JSON.parse(
        fs.readFileSync(path.resolve(serviceAccountPath), "utf8")
      );
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      }
      console.log("[Firebase] Initialized with Service Account JSON.");
    } catch (err) {
      console.warn("[Firebase] Warning reading service account:", err.message);
    }
  }

  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID,
  };

  const app = initClientApp(firebaseConfig);
  const firestore = getClientFirestore(app);
  console.log(`[Firebase] Connected securely to project: ${firebaseConfig.projectId}`);
  return firestore;
}

const db = getFirestoreInstance();

function getDocRefFromPath(dbInstance, docPath) {
  const parts = docPath.split("/").filter(Boolean);
  if (parts.length % 2 !== 0) {
    throw new Error(`Invalid doc path: ${docPath}. Must have even segments (e.g. 'meta/all_emails').`);
  }
  return doc(dbInstance, parts[0], parts[1]);
}

/* ------------------------------------------------------------------ */
/* Mail (Google SMTP - Reads Exclusively from process.env)             */
/* ------------------------------------------------------------------ */

const smtpUser = process.env.SMTP_USER;
const smtpPass = (process.env.SMTP_PASS || "").replace(/\s+/g, "");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "465", 10),
  secure: (process.env.SMTP_SECURE || "true") === "true",
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

const FROM_ADDRESS = process.env.MAIL_FROM || `Affyne Labs <${smtpUser}>`;

transporter.verify().then(() => {
  console.log(`[SMTP] Verified successfully. Sender address: ${FROM_ADDRESS}`);
}).catch((err) => {
  console.error(`[SMTP] Verification failed:`, err.message);
});

/* ------------------------------------------------------------------ */
/* Template helpers                                                    */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fillTemplate(template, values, { escape = false } = {}) {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const v = values[key] === undefined ? "" : String(values[key]);
    return escape ? escapeHtml(v) : v;
  });
}

function readTemplate(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function formatDate(date) {
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    dateStyle: "long",
    timeZone: DATE_TIMEZONE,
  }).format(date);
}

function formatReference(n) {
  return `${REFERENCE_PREFIX}${String(n).padStart(REFERENCE_DIGITS, "0")}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanName(name) {
  return String(name || "")
    .replace(/<[^>]*>?/gm, "") // Strip any HTML tags
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function extractNameFromEmail(email) {
  if (!email || typeof email !== "string") return "Subscriber";

  // Extract local part (before @ and before +)
  let localPart = email.split("@")[0].split("+")[0];

  // Strip digits
  let cleaned = localPart.replace(/[0-9]+/g, "");
  if (!cleaned) cleaned = localPart;

  // Replace delimiters (., _, -) with spaces
  let formatted = cleaned.replace(/[\._\-]+/g, " ");

  // Split camelCase (e.g., keerthiVardhan -> keerthi Vardhan)
  formatted = formatted.replace(/([a-z])([A-Z])/g, "$1 $2");

  // If it is a single continuous word, check for well-known name splits
  if (!formatted.includes(" ")) {
    const lower = formatted.toLowerCase();

    if (lower.startsWith("keerthivardhan")) {
      const rest = lower.slice("keerthivardhan".length);
      formatted = "Keerthi Vardhan" + (rest ? " " + rest.toUpperCase() : "");
    } else {
      const knownCompoundRoots = [
        "vardhan", "kumar", "reddy", "sharma", "singh",
        "patel", "prasad", "chandra", "sekhar", "swamy"
      ];
      for (const root of knownCompoundRoots) {
        const idx = lower.indexOf(root);
        if (idx > 2) {
          const firstPart = formatted.slice(0, idx);
          const secondPart = formatted.slice(idx, idx + root.length);
          const remainder = formatted.slice(idx + root.length);
          formatted = firstPart + " " + secondPart + (remainder ? " " + remainder : "");
          break;
        }
      }
    }
  }

  // Capitalize each token
  const words = formatted.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Subscriber";

  return words.map((w) => {
    if (w.length === 1) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ");
}

function sanitizeString(input, maxLen = 100) {
  return String(input || "")
    .replace(/<[^>]*>?/gm, "")
    .trim()
    .slice(0, maxLen);
}

/* ------------------------------------------------------------------ */
/* Webhook Notifications (Slack / Discord / Custom)                   */
/* ------------------------------------------------------------------ */

async function dispatchWebhookNotification(user) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL || process.env.WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const isDiscord = webhookUrl.includes("discord.com");
    const isSlack = webhookUrl.includes("slack.com");

    let payload;
    if (isDiscord) {
      payload = {
        embeds: [
          {
            title: "🚀 New Waitlist Signup",
            color: 6513401,
            fields: [
              { name: "Subscriber", value: user.fullName || user.name, inline: true },
              { name: "Email", value: user.email, inline: true },
              { name: "Sequence", value: `#${user.waitlistNumber} (${user.referenceNumber})`, inline: true },
              { name: "Area of Interest", value: user.areaOfInterest || "General Early Access", inline: false },
              { name: "Referred By", value: user.referredBy || "Direct signup", inline: true },
            ],
            footer: { text: "Affyne Labs Waitlist Hub" },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    } else if (isSlack) {
      payload = {
        text: `🚀 *New Waitlist Registration*: *${user.fullName || user.name}* (<mailto:${user.email}|${user.email}>) reserved spot *#${user.waitlistNumber}* (${user.referenceNumber}).`,
      };
    } else {
      payload = {
        event: "waitlist.signup",
        user,
        timestamp: new Date().toISOString(),
      };
    }

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn("[Webhook] Failed to dispatch notification:", err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Startup sync helper for separate email storage                      */
/* ------------------------------------------------------------------ */

async function syncExistingEmailsToSeparateDoc() {
  try {
    const waitlistSnap = await getDocs(collection(db, WAITLIST_COLLECTION));
    const emails = [];

    waitlistSnap.forEach((d) => {
      const data = d.data();
      if (data && data.email) {
        const cleanEmail = String(data.email).trim().toLowerCase();
        if (!emails.includes(cleanEmail)) {
          emails.push(cleanEmail);
        }
      }
    });

    if (emails.length > 0) {
      // 1. Separate document holding all emails in array
      const allEmailsDocRef = getDocRefFromPath(db, ALL_EMAILS_DOC);
      const existingAll = await getDoc(allEmailsDocRef);
      const existingList = existingAll.exists() && Array.isArray(existingAll.data().emails)
        ? existingAll.data().emails
        : [];

      const combined = Array.from(new Set([...existingList, ...emails]));
      await setDoc(
        allEmailsDocRef,
        {
          emails: combined,
          totalCount: combined.length,
          lastUpdated: new Date().toISOString(),
          description: "Aggregated document containing all waitlist email IDs",
        },
        { merge: true }
      );

      // 2. Separate documents for each email in SUBSCRIBERS_COLLECTION
      for (const email of emails) {
        const subDocRef = doc(db, SUBSCRIBERS_COLLECTION, encodeURIComponent(email));
        await setDoc(
          subDocRef,
          {
            email,
            syncedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      }

      console.log(`[Sync] Stored ${combined.length} email IDs securely in separate doc (${ALL_EMAILS_DOC}).`);
    }
  } catch (err) {
    console.warn("[Sync] Initial sync notice:", err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Core Waitlist Logic                                                 */
/* ------------------------------------------------------------------ */

async function addToWaitlist({ name, email, areaOfInterest, source, referredBy }) {
  const cleanEmail = String(email).trim().toLowerCase();

  // 1. Check if email is already in the waitlist
  const q = query(
    collection(db, WAITLIST_COLLECTION),
    where("email", "==", cleanEmail)
  );
  const existingDocs = await getDocs(q);
  if (!existingDocs.empty) {
    const existing = existingDocs.docs[0].data();
    return { created: false, user: existing };
  }

  // 2. Get next sequential number
  const counterRef = getDocRefFromPath(db, COUNTER_DOC);
  let nextNumber = 1009;

  try {
    const counterSnap = await getDoc(counterRef);
    if (counterSnap.exists() && typeof counterSnap.data().count === "number") {
      nextNumber = counterSnap.data().count + 1;
    } else {
      // Detect max from existing docs
      const allWaitlist = await getDocs(collection(db, WAITLIST_COLLECTION));
      let maxNum = 1000;
      allWaitlist.forEach((d) => {
        const num = d.data().waitlistNumber || d.data().position;
        if (typeof num === "number" && num > maxNum) {
          maxNum = num;
        }
      });
      nextNumber = maxNum + 1;
    }
    await setDoc(
      counterRef,
      { count: nextNumber, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (err) {
    console.warn("Counter fallback:", err.message);
  }

  const referenceNumber = formatReference(nextNumber);
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const docId = `wl-${randomSuffix}`;
  const nowIso = new Date().toISOString();
  const referralUrl = `${FRONTEND_URL}?ref=${referenceNumber}`;

  const user = {
    id: docId,
    email: cleanEmail,
    fullName: name,
    name,
    referenceNumber,
    waitlistNumber: nextNumber,
    position: nextNumber,
    areaOfInterest: sanitizeString(areaOfInterest || "General Early Access", 80),
    source: sanitizeString(source || "website-waitlist", 80),
    status: "approved",
    emailStatus: "pending",
    referralCode: referenceNumber,
    referralUrl,
    referralCount: 0,
    referredBy: referredBy ? sanitizeString(referredBy, 30) : null,
    createdAt: nowIso,
  };

  // 3. Save to main waitlist collection
  const userDocRef = doc(db, WAITLIST_COLLECTION, docId);
  await setDoc(userDocRef, user);

  // 4. If referredBy provided, credit referrer
  if (referredBy) {
    try {
      const refQuery = query(
        collection(db, WAITLIST_COLLECTION),
        where("referenceNumber", "==", referredBy.toUpperCase())
      );
      const refSnap = await getDocs(refQuery);
      if (!refSnap.empty) {
        const referrerDoc = refSnap.docs[0];
        await updateDoc(doc(db, WAITLIST_COLLECTION, referrerDoc.id), {
          referralCount: increment(1),
        });
      }
    } catch (refErr) {
      console.warn("Could not credit referrer:", refErr.message);
    }
  }

  // 5. Store email ID in separate doc (e.g. meta/all_emails)
  try {
    const allEmailsRef = getDocRefFromPath(db, ALL_EMAILS_DOC);
    await setDoc(
      allEmailsRef,
      {
        emails: arrayUnion(cleanEmail),
        lastUpdated: nowIso,
      },
      { merge: true }
    );
    const updatedSnap = await getDoc(allEmailsRef);
    if (updatedSnap.exists() && Array.isArray(updatedSnap.data().emails)) {
      await updateDoc(allEmailsRef, {
        totalCount: updatedSnap.data().emails.length,
      });
    }
  } catch (err) {
    console.error("Error storing in separate all_emails doc:", err.message);
  }

  // 6. Store separate doc for this email in SUBSCRIBERS_COLLECTION
  try {
    const subRef = doc(db, SUBSCRIBERS_COLLECTION, encodeURIComponent(cleanEmail));
    await setDoc(
      subRef,
      {
        email: cleanEmail,
        fullName: name,
        referenceNumber,
        waitlistNumber: nextNumber,
        referralUrl,
        createdAt: nowIso,
      },
      { merge: true }
    );
  } catch (err) {
    console.error("Error storing in subscribers collection:", err.message);
  }

  // 7. Dispatch background webhook notification
  dispatchWebhookNotification(user).catch(() => {});

  return { created: true, user };
}

/* ------------------------------------------------------------------ */
/* Welcome Email Sender                                                */
/* ------------------------------------------------------------------ */

async function sendWelcomeEmail(user) {
  const now = new Date();
  const referralUrl = user.referralUrl || `${FRONTEND_URL}?ref=${user.referenceNumber}`;

  const values = {
    name: user.fullName || user.name,
    email: user.email,
    date: formatDate(now),
    referenceNumber: user.referenceNumber,
    referralCode: user.referenceNumber,
    referralUrl,
  };

  const htmlTemplate = readTemplate(HTML_TEMPLATE_PATH);
  const textTemplate = readTemplate(TEXT_TEMPLATE_PATH);
  if (!htmlTemplate && !textTemplate) {
    throw new Error("No email template found in /templates");
  }

  const subject = fillTemplate(EMAIL_SUBJECT, values);
  const html = htmlTemplate ? fillTemplate(htmlTemplate, values, { escape: true }) : undefined;
  const text = textTemplate ? fillTemplate(textTemplate, values) : undefined;

  const nowIso = now.toISOString();
  const baseLog = {
    to: user.email,
    from: FROM_ADDRESS,
    name: user.fullName || user.name,
    referenceNumber: user.referenceNumber,
    subject,
    createdAt: nowIso,
  };

  try {
    const info = await transporter.sendMail({
      from: FROM_ADDRESS,
      to: user.email,
      subject,
      html,
      text,
    });

    // Log to emails collection
    try {
      await addDoc(collection(db, EMAILS_COLLECTION), {
        ...baseLog,
        status: "sent",
        messageId: info.messageId,
      });
    } catch (logErr) {
      console.warn("Could not write to emails log collection:", logErr.message);
    }

    // Update waitlist doc
    try {
      const userRef = doc(db, WAITLIST_COLLECTION, user.id);
      await updateDoc(userRef, {
        emailStatus: "sent",
        emailSentAt: nowIso,
      });
    } catch (upErr) {
      console.warn("Could not update waitlist email status:", upErr.message);
    }

    return true;
  } catch (err) {
    console.error("Email send failed:", err.message);

    try {
      await addDoc(collection(db, EMAILS_COLLECTION), {
        ...baseLog,
        status: "failed",
        error: err.message,
      });
    } catch (logErr) {
      console.warn("Could not write failure to emails log collection:", logErr.message);
    }

    try {
      const userRef = doc(db, WAITLIST_COLLECTION, user.id);
      await updateDoc(userRef, {
        emailStatus: "failed",
        emailError: err.message,
      });
    } catch (upErr) {
      console.warn("Could not update waitlist failure status:", upErr.message);
    }

    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Auth Middleware (Strict Admin Protection)                          */
/* ------------------------------------------------------------------ */

function requireAdminAuth(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: "Access Denied: ADMIN_API_KEY is not configured on the server.",
    });
  }

  const providedKey = req.headers["x-admin-key"] || req.query.key;
  if (!providedKey || providedKey !== ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: "Access Denied: Invalid or missing administrative credentials.",
    });
  }

  next();
}

/* ------------------------------------------------------------------ */
/* HTTP server & Security Headers                                      */
/* ------------------------------------------------------------------ */

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by"); // Prevents server stack fingerprinting

// Security headers to shield against clickjacking, sniffing, and XSS
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.json({ limit: "10kb" }));

// Serve static frontend assets from public/
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

const allowedOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
  })
);

// Strict rate-limiting against DDoS and brute force scraping
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_PER_MINUTE || "60", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many requests, please try again later." },
  })
);

// Root route - serves the Waitlist Hub web application
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Sanitized Health check endpoint (Zero internal configuration leaked)
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Safe Endpoint used by frontend to display live queue counter (No PII)
app.get("/api/waitlist/count", async (_req, res) => {
  try {
    const allEmailsRef = getDocRefFromPath(db, ALL_EMAILS_DOC);
    const snap = await getDoc(allEmailsRef);
    const count = snap.exists() && Array.isArray(snap.data().emails) ? snap.data().emails.length : 0;

    const counterRef = getDocRefFromPath(db, COUNTER_DOC);
    const counterSnap = await getDoc(counterRef);
    const nextNumber = counterSnap.exists() && typeof counterSnap.data().count === "number"
      ? counterSnap.data().count + 1
      : 1001 + count;

    return res.json({
      success: true,
      count,
      nextNumber,
    });
  } catch (err) {
    console.error("[Waitlist Count Error]:", err.message);
    return res.status(500).json({ success: false, error: "Unable to retrieve queue status." });
  }
});

// Protected Endpoint to view all stored email IDs (Requires x-admin-key)
app.get("/api/emails", requireAdminAuth, async (_req, res) => {
  try {
    const allEmailsRef = getDocRefFromPath(db, ALL_EMAILS_DOC);
    const snap = await getDoc(allEmailsRef);
    if (!snap.exists()) {
      return res.json({ success: true, count: 0, emails: [] });
    }
    const data = snap.data();
    return res.json({
      success: true,
      count: (data.emails || []).length,
      emails: data.emails || [],
      lastUpdated: data.lastUpdated || null,
    });
  } catch (err) {
    console.error("[Emails Retrieval Error]:", err.message);
    return res.status(500).json({ success: false, error: "Unable to retrieve email list." });
  }
});

// Position check: Returns ONLY position number & reference number (Zero PII leaked)
app.get("/api/waitlist/position", async (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, error: "A valid email is required." });
  }

  try {
    const q = query(collection(db, WAITLIST_COLLECTION), where("email", "==", email));
    const snap = await getDocs(q);
    if (snap.empty) {
      return res.status(404).json({ success: false, error: "Subscriber not found on waitlist." });
    }
    const user = snap.docs[0].data();
    return res.json({
      success: true,
      waitlistNumber: user.waitlistNumber,
      referenceNumber: user.referenceNumber,
      status: user.status || "approved",
    });
  } catch (err) {
    console.error("[Position Check Error]:", err.message);
    return res.status(500).json({ success: false, error: "Unable to retrieve status." });
  }
});

// Resend confirmation email
app.post("/api/waitlist/resend", async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, error: "Valid email is required." });
  }

  try {
    const q = query(collection(db, WAITLIST_COLLECTION), where("email", "==", email));
    const snap = await getDocs(q);
    if (snap.empty) {
      return res.status(404).json({ success: false, error: "Email is not on the waiting list." });
    }
    const user = snap.docs[0].data();
    const emailSent = await sendWelcomeEmail(user);
    return res.json({
      success: true,
      message: "Welcome email has been re-dispatched.",
      emailSent,
    });
  } catch (err) {
    console.error("[Resend Error]:", err.message);
    return res.status(500).json({ success: false, error: "Unable to resend email at this time." });
  }
});

// Protected Endpoint to export waitlist CSV (Requires x-admin-key)
app.get("/api/waitlist/export", requireAdminAuth, async (_req, res) => {
  try {
    const snap = await getDocs(collection(db, WAITLIST_COLLECTION));
    const records = [];
    snap.forEach((d) => records.push(d.data()));

    records.sort((a, b) => (a.waitlistNumber || 0) - (b.waitlistNumber || 0));

    const csvRows = [
      ["Waitlist Number", "Reference Number", "Full Name", "Email", "Area of Interest", "Referrals", "Status", "Email Status", "Date Joined"].join(","),
    ];

    for (const r of records) {
      const row = [
        r.waitlistNumber || "",
        `"${(r.referenceNumber || "").replace(/"/g, '""')}"`,
        `"${(r.fullName || r.name || "").replace(/"/g, '""')}"`,
        `"${(r.email || "").replace(/"/g, '""')}"`,
        `"${(r.areaOfInterest || "").replace(/"/g, '""')}"`,
        r.referralCount || 0,
        `"${(r.status || "").replace(/"/g, '""')}"`,
        `"${(r.emailStatus || "").replace(/"/g, '""')}"`,
        `"${(r.createdAt || "").replace(/"/g, '""')}"`,
      ];
      csvRows.push(row.join(","));
    }

    const csvContent = csvRows.join("\n");
    const filename = `waitlist-export-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  } catch (err) {
    console.error("[Export Error]:", err.message);
    return res.status(500).json({ success: false, error: "Failed to generate export." });
  }
});

// Contact inquiry endpoint
app.post("/api/contact", async (req, res) => {
  const { fullName, email, organization, subject, message } = req.body || {};
  if (!fullName || !email || !EMAIL_RE.test(email) || !message) {
    return res.status(400).json({ success: false, error: "Full name, valid email, and message are required." });
  }

  try {
    const contactRef = collection(db, "inquiries");
    await addDoc(contactRef, {
      fullName: cleanName(fullName),
      email: String(email).trim().toLowerCase(),
      organization: organization ? sanitizeString(organization, 100) : null,
      subject: sanitizeString(subject || "General Inquiry", 120),
      message: sanitizeString(message, 2000),
      createdAt: new Date().toISOString(),
      status: "new",
    });

    // Send auto-acknowledgement email
    try {
      await transporter.sendMail({
        from: FROM_ADDRESS,
        to: email,
        subject: `We've received your inquiry - Affyne Labs`,
        text: `Hi ${cleanName(fullName)},\n\nThank you for contacting Affyne Labs. We have received your inquiry and our team will get back to you shortly.\n\nBest regards,\nAffyne Labs Team\n${FROM_ADDRESS}`,
      });
    } catch (mailErr) {
      console.warn("Contact auto-acknowledgement email failed:", mailErr.message);
    }

    return res.status(201).json({
      success: true,
      message: "Your inquiry has been received. Our team will get back to you shortly.",
    });
  } catch (err) {
    console.error("[Contact Error]:", err.message);
    return res.status(500).json({ success: false, error: "Unable to submit inquiry at this time." });
  }
});

// Main waitlist submission endpoint
app.post("/api/waitlist", async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const areaOfInterest = req.body && req.body.areaOfInterest;
  const source = req.body && req.body.source;
  const referredBy = req.body && req.body.referredBy ? String(req.body.referredBy).trim() : null;

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ success: false, error: "A valid email is required." });
  }

  // Derive name automatically from email if not provided in input
  let name = cleanName(req.body && (req.body.name || req.body.fullName));
  if (!name) {
    name = extractNameFromEmail(email);
  }

  try {
    const { created, user } = await addToWaitlist({ name, email, areaOfInterest, source, referredBy });

    if (!created) {
      return res.status(409).json({
        success: false,
        error: "This email is already registered on the waiting list.",
        referenceNumber: user.referenceNumber,
        waitlistNumber: user.waitlistNumber,
      });
    }

    const emailSent = await sendWelcomeEmail(user);

    return res.status(201).json({
      success: true,
      message: "You have been added to the waiting list.",
      referenceNumber: user.referenceNumber,
      waitlistNumber: user.waitlistNumber,
      referralUrl: user.referralUrl,
      emailSent,
    });
  } catch (err) {
    console.error("Waitlist error:", err.message);
    return res.status(500).json({ success: false, error: "Something went wrong. Please try again." });
  }
});

app.listen(PORT, async () => {
  console.log(`Waitlist server running securely on port ${PORT}`);
  await syncExistingEmailsToSeparateDoc();
});
