import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();
app.use(cors());

// ✅ Stripe webhook raw body ONLY on this route
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
// ✅ Everything else JSON
app.use(express.json({ limit: "1mb" }));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---------------- PRICING ----------------
const BASE_PRICE_CENTS = 1000; // $10
const BASE_MILES = 5;
const PER_MILE_CENTS = 100; // $1 per mile

// ---------------- SUPPLIES ----------------
const SUPPLY_PRICES = {
  box: 300,
  mailer: 100,
  tape: 50,
  labelPrint: 50
};

// ---------------- LOCATION ----------------
const BUSINESS_ORIGIN_ADDRESS =
  process.env.BUSINESS_ORIGIN_ADDRESS ||
  "415 Pisgah Church Rd, Greensboro, NC 27455";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ---------------- STORAGE ----------------
const DATA_DIR = path.join(process.cwd(), "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(BOOKINGS_FILE)) fs.writeFileSync(BOOKINGS_FILE, "[]");

const readBookings = () => JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8"));
const writeBookings = (data) =>
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2));

// ---------------- HELPERS ----------------
async function getMiles(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) return 0;

  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", origin);
  url.searchParams.set("destinations", destination);
  url.searchParams.set("units", "imperial");
  url.searchParams.set("key", GOOGLE_MAPS_API_KEY);

  const r = await fetch(url);
  const j = await r.json();
  const meters = j?.rows?.[0]?.elements?.[0]?.distance?.value || 0;
  return meters / 1609.34;
}

function calculatePrice(miles, supplies) {
  const extraMiles = Math.max(0, miles - BASE_MILES);
  let total = BASE_PRICE_CENTS + Math.ceil(extraMiles * PER_MILE_CENTS);

  if (supplies?.box) total += SUPPLY_PRICES.box;
  if (supplies?.mailer) total += SUPPLY_PRICES.mailer;
  if (supplies?.tape) total += SUPPLY_PRICES.tape;
  if (supplies?.labelPrint) total += SUPPLY_PRICES.labelPrint;

  return total;
}

function mailer() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

// ---------------- ROUTES ----------------
app.get("/health", (req, res) => {
  res.json({ ok: true, origin: BUSINESS_ORIGIN_ADDRESS });
});
// ✅ List all bookings (for Calendar/Admin)
app.get("/api/bookings", (req, res) => {
  try {
    const bookings = readBookings();
    res.json(bookings);
  } catch (err) {
    console.error("GET /api/bookings error:", err);
    res.status(500).json({ error: "Failed to load bookings" });
  }
});
// ✅ Get one booking by id
app.get("/api/bookings/:bookingId", (req, res) => {
  try {
    const bookings = readBookings();
    const booking = bookings.find((b) => b.bookingId === req.params.bookingId);
    if (!booking) return res.status(404).json({ error: "Not found" });
    res.json(booking);
  } catch (err) {
    console.error("GET /api/bookings/:bookingId error:", err);
    res.status(500).json({ error: "Failed to load booking" });
  }
});
// ✅ Create booking + PaymentIntent
app.post("/api/bookings", async (req, res) => {
  try {
    const bookingId = uuidv4();

    const miles = await getMiles(BUSINESS_ORIGIN_ADDRESS, req.body.address);
    const amount = calculatePrice(miles, req.body.supplies);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      metadata: { bookingId }
    });

    // Save pickup time in a predictable field
    const pickupDateTimeISO =
      req.body.pickupDateTimeISO || req.body.pickupDateTime || null;

    const bookings = readBookings();
    bookings.push({
      bookingId,
      status: "pending",
      createdAtISO: new Date().toISOString(),
      ...req.body,
      pickupDateTimeISO,
      miles,
      amountCents: amount
    });
    writeBookings(bookings);

    res.json({
      bookingId,
      clientSecret: paymentIntent.client_secret,
      amountCents: amount
    });
  } catch (err) {
    console.error("POST /api/bookings error:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

// ✅ Webhook: mark paid + send emails
app.post("/api/stripe/webhook", async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "payment_intent.succeeded") {
      const bookingId = event.data?.object?.metadata?.bookingId;
      console.log("✅ payment_intent.succeeded bookingId:", bookingId);

      const bookings = readBookings();
      const idx = bookings.findIndex((b) => b.bookingId === bookingId);
      const booking = idx >= 0 ? bookings[idx] : null;

      if (booking) {
        bookings[idx] = { ...booking, status: "paid", paidAtISO: new Date().toISOString() };
        writeBookings(bookings);
      }

      const t = mailer();

      if (!t) {
        console.log("Mailer not configured. Missing SMTP_USER or SMTP_PASS.");
      } else if (!booking) {
        console.log("No booking found for bookingId:", bookingId);
      } else {
        const pickupTime =
          booking.pickupDateTimeISO || booking.pickupDateTime || "(time not provided)";

        // Customer email
        try {
          await t.sendMail({
            from: process.env.SMTP_USER,
            to: booking.email,
            subject: "I TURN IN Pickup Confirmed",
            text: `Your pickup is scheduled for ${pickupTime}.
Address: ${booking.address}
Notes: ${booking.notes || "(none)"}`
          });
          console.log("Customer email sent to:", booking.email);
        } catch (e) {
          console.error("Customer email FAILED:", e?.message || e);
        }

        // Admin email
        try {
          await t.sendMail({
            from: process.env.SMTP_USER,
            to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
            subject: "✅ New Pickup Booked (Paid)",
            text: `NEW PAID PICKUP

Name: ${booking.firstName} ${booking.lastName}
Email: ${booking.email}
Phone: ${booking.phone}
Address: ${booking.address}
Time: ${pickupTime}
Total: $${(booking.amountCents / 100).toFixed(2)}

BookingId: ${booking.bookingId}`
          });
          console.log("Admin email sent to:", process.env.ADMIN_EMAIL || process.env.SMTP_USER);
        } catch (e) {
          console.error("Admin email FAILED:", e?.message || e);
        }
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
});

app.listen(process.env.PORT || 4000, () => {
  console.log("I TURN IN backend running");
});
