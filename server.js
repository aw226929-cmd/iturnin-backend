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

// Stripe webhook needs raw body, everything else JSON
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
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

const readBookings = () =>
  JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8"));

const writeBookings = (data) =>
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2));

// ---------------- HELPERS ----------------
async function getMiles(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) return 0;

  const url = new URL(
    "https://maps.googleapis.com/maps/api/distancematrix/json"
  );
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

  if (event.type === "payment_intent.succeeded") {
    const bookingId = event.data?.object?.metadata?.bookingId;
    console.log("✅ payment_intent.succeeded bookingId:", bookingId);

    const bookings = readBookings();
    const booking = bookings.find((b) => b.bookingId === bookingId);

    const t = mailer();

    if (!t) {
      console.log("Mailer not configured. Missing SMTP_USER or SMTP_PASS.");
    } else if (!booking) {
      console.log("No booking found for bookingId:", bookingId);
    } else {
      const pickupTime =
        booking.pickupDateTimeISO ||
        booking.pickupDateTime ||
        booking.pickupDateTimeISOString ||
        "(time not provided)";

      // Email customer
      try {
        await t.sendMail({
          from: process.env.SMTP_USER,
          to: booking.email,
          subject: "I TURN IN Pickup Confirmed",
          text: `Your pickup is scheduled for ${pickupTime}.`
        });
        console.log("Customer email sent to:", booking.email);
      } catch (e) {
        console.error("Customer email FAILED:", e?.message || e);
      }

      // Email you (admin)
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
});
