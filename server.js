// backend/server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import billingRoutes from "./routes/billing.js";
import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import integrationsRoute from "./routes/integrations.js";
import pipelineRoutes from "./routes/pipeline.js";
import invitesRoutes from "./routes/invites.js";
import membersRoutes from "./routes/members.js";
import revenueStabilityRouter from "./routes/revenueStability.js";
import clientsRouter from "./routes/clients.js";
import dealsRouter from "./routes/deals.js";
import dealIntelRouter from "./routes/dealIntel.js";
import revenueIntelRouter from "./routes/revenueIntel.js";
import forecastRoutes from "./routes/forecast.js";
import partnersRoutes from "./routes/partners.js";
import orgRoutes from "./routes/org.js";
import organizationsRoutes from "./routes/organizations.js";
import atlasRoutes from "./routes/atlas.js";
import atlasOperator from "./routes/atlasOperator.js";
import operatorRoutes from "./routes/operator.js";
import accountsRoutes from "./routes/accounts.js";
import metricsRoutes from "./routes/metrics.js";
import meRoutes from "./routes/me.js";
import aiRoutes from "./routes/ai.js";
import seedRoutes from "./routes/seed.js";
import exportRoutes from "./routes/export.js";
import attributionRoutes from "./routes/attribution.js";
import stripeRoutes from "./routes/stripe.js";

const app = express();
app.set("trust proxy", 1);

/** -------------------- CORS (ONLY ONCE) -------------------- */
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "https://app.atlasrevenueai.com",
  "https://atlasrevenueai.com",
  "https://www.atlasrevenueai.com",
  "https://butler-platform-frontend.onrender.com",
  "https://butler-dashboard.onrender.com",
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-org-id",
    "X-Requested-With",
    "stripe-signature",
  ],
  exposedHeaders: ["x-org-id"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/** -------------------- STRIPE/BILLING ROUTES FIRST -------------------- */
/** billingRoutes contains /webhook and must load before express.json() */
app.use("/api/billing", billingRoutes);

/** -------------------- BODY PARSERS AFTER BILLING WEBHOOK -------------------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));

/** -------------------- Invalid JSON handler -------------------- */
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ ok: false, error: "Invalid JSON body" });
  }
  return next(err);
});

/** -------------------- Health check -------------------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mongoReadyState: mongoose.connection?.readyState ?? null,
    mongoHost: mongoose.connection?.host ?? null,
    mongoDb: mongoose.connection?.name ?? null,
  });
});

/** -------------------- Routes -------------------- */
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/integrations", integrationsRoute);
app.use("/api/pipeline", pipelineRoutes);

app.use("/api/invites", invitesRoutes);
app.use("/api/members", membersRoutes);

app.use("/api/revenue-stability", revenueStabilityRouter);
app.use("/api/revenue-intel", revenueIntelRouter);
app.use("/api/forecast", forecastRoutes);

app.use("/api/partners", partnersRoutes);
app.use("/api/clients", clientsRouter);
app.use("/api/deals", dealsRouter);
app.use("/api/deal-intel", dealIntelRouter);

app.use("/api/atlas", atlasRoutes);
app.use("/api/atlas", atlasOperator);

app.use("/api/org", orgRoutes);
app.use("/api/organizations", organizationsRoutes);

app.use("/api/seed", seedRoutes);
app.use("/api/accounts", accountsRoutes);
app.use("/api/metrics", metricsRoutes);
app.use("/api/me", meRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/attribution", attributionRoutes);
app.use("/api/operator", operatorRoutes);
app.use("/api/stripe", stripeRoutes);

/** -------------------- 404 fallback LAST -------------------- */
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: "Not Found",
    path: req.originalUrl,
  });
});

/** -------------------- Boot -------------------- */
const PORT = Number(process.env.PORT) || 5001;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function start() {
  try {
    console.log("ENV PORT:", PORT);
    console.log("ENV MONGO_URI exists?", !!MONGO_URI);
    console.log("ENV STRIPE_SECRET_KEY exists?", !!process.env.STRIPE_SECRET_KEY);
    console.log("ENV APP_BASE_URL:", process.env.APP_BASE_URL);
    console.log("Allowed origins:", allowedOrigins);

    if (!MONGO_URI) {
      console.error("❌ Missing MONGO_URI (or MONGODB_URI) in backend/.env");
      process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connected");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ MongoDB connection error:", err?.message || err);
    process.exit(1);
  }
}

start();

process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});