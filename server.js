// backend/server.js
import dotenv from "dotenv";
dotenv.config();

console.log("SMTP USER:", process.env.SMTP_USER);
console.log("SMTP PASS EXISTS:", !!process.env.SMTP_PASS);

import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import { requirePlan } from "./middleware/requirePlan.js";
import { startIntegrationAutoSync } from "./jobs/integrationAutoSync.js";

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
import workspaceRoutes from "./routes/workspaces.js";
import trialRoutes from "./routes/trial.js";
import hubspotSyncRoutes from "./routes/hubspotSync.js";
import importsRoutes from "./routes/imports.js";
import ghlRoutes from "./routes/ghl.js";
import pipedriveRoutes from "./routes/pipedrive.js";
import linkedinAdsRoutes from "./routes/linkedinAds.js";
import graphiqRoutes from "./routes/graphiq.js";

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
    "x-workspace-id",
    "X-Requested-With",
    "stripe-signature",
  ],
  exposedHeaders: ["x-org-id"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/** -------------------- STRIPE/BILLING ROUTES FIRST -------------------- */
/** These must be mounted before express.json() so raw webhook bodies still work */
app.use("/api/billing", billingRoutes);
app.use("/api/stripe", stripeRoutes);

/** -------------------- BODY PARSERS AFTER WEBHOOK ROUTES -------------------- */
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
    env: process.env.NODE_ENV || "development",
  });
});

/** -------------------- Routes -------------------- */
app.use("/api/auth", authRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/trial", trialRoutes);
app.use("/api/hubspot", hubspotSyncRoutes);
app.use("/api/imports", importsRoutes);
app.use("/api/integrations/linkedin_ads", linkedinAdsRoutes);

app.use("/api/dashboard", requirePlan("CORE"), dashboardRoutes);
app.use("/api/integrations/pipedrive", pipedriveRoutes);
app.use("/api/integrations", requirePlan("CORE"), integrationsRoute);
app.use("/api/pipeline", requirePlan("CORE"), pipelineRoutes);
app.use("/api/integrations/ghl", requirePlan("CORE"), ghlRoutes);

app.use("/api/invites", requirePlan("CORE"), invitesRoutes);
app.use("/api/members", requirePlan("CORE"), membersRoutes);

app.use("/api/revenue-stability", requirePlan("CORE"), revenueStabilityRouter);
app.use("/api/revenue-intel", requirePlan("CORE"), revenueIntelRouter);
app.use("/api/forecast", requirePlan("GROWTH"), forecastRoutes);

app.use("/api/partners", requirePlan("CORE"), partnersRoutes);
app.use("/api/clients", requirePlan("CORE"), clientsRouter);
app.use("/api/deals", requirePlan("CORE"), dealsRouter);
app.use("/api/deal-intel", requirePlan("GROWTH"), dealIntelRouter);

app.use("/api/atlas", requirePlan("CORE"), atlasRoutes);
app.use("/api/atlas", requirePlan("ENTERPRISE"), atlasOperator);

app.use("/api/org", requirePlan("CORE"), orgRoutes);
app.use("/api/organizations", requirePlan("CORE"), organizationsRoutes);

app.use("/api/seed", requirePlan("ENTERPRISE"), seedRoutes);
app.use("/api/accounts", requirePlan("CORE"), accountsRoutes);
app.use("/api/graphiq", requirePlan("CORE"), graphiqRoutes);
app.use("/api/metrics", requirePlan("GROWTH"), metricsRoutes);
app.use("/api/me", meRoutes);
app.use("/api/ai", requirePlan("CORE"), aiRoutes);
app.use("/api/export", requirePlan("GROWTH"), exportRoutes);
app.use("/api/attribution", requirePlan("GROWTH"), attributionRoutes);
app.use("/api/operator", requirePlan("ENTERPRISE"), operatorRoutes);

/** -------------------- 404 fallback LAST -------------------- */
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: "Not Found",
    path: req.originalUrl,
  });
});

/** -------------------- Global error handler -------------------- */
app.use((err, req, res, next) => {
  console.error("❌ Express error:", err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(err.status || 500).json({
    ok: false,
    message: err.message || "Internal Server Error",
  });
});

/** -------------------- Boot -------------------- */
const PORT = Number(process.env.PORT) || 5001;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

let server;

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

    server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);

  // 🚀 Start integration auto-sync AFTER server + DB are ready
  startIntegrationAutoSync();
  console.log("✅ Integration auto-sync started");
});
  } catch (err) {
    console.error("❌ MongoDB connection error:", err?.message || err);
    process.exit(1);
  }
}

start();

/** -------------------- Process safety -------------------- */
process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});

async function shutdown(signal) {
  try {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      console.log("✅ HTTP server closed");
    }

    await mongoose.connection.close();
    console.log("✅ MongoDB connection closed");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
