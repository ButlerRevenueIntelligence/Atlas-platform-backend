// backend/server.js
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

// Core routes
import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import integrationsRoutes from "./routes/integrations.js";
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

// Optional routes (only if these files exist in your project)
import accountsRoutes from "./routes/accounts.js";
import metricsRoutes from "./routes/metrics.js";
import meRoutes from "./routes/me.js";
import aiRoutes from "./routes/ai.js";
import seedRoutes from "./routes/seed.js";
import exportRoutes from "./routes/export.js";
import attributionRoutes from "./routes/attribution.js";

dotenv.config();

const app = express();

/** -------------------- CORS (FIXED FOR HTTPS + APP DOMAIN) -------------------- */
/**
 * IMPORTANT:
 * Your frontend is https://app.atlasrevenueai.com
 * Your backend is https://atlas-backend.onrender.com
 *
 * The browser will BLOCK requests unless the backend returns:
 *   Access-Control-Allow-Origin: https://app.atlasrevenueai.com
 *   Access-Control-Allow-Credentials: true
 *
 * Using origin:true is NOT reliable for credentialed requests on some setups.
 * This config explicitly whitelists your domains + supports local dev.
 */
const ALLOWED_ORIGINS = new Set([
  "https://app.atlasrevenueai.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

app.use(
  cors({
    origin: [
      "https://app.atlasrevenueai.com",
      "https://butler-dashboard.onrender.com",
      "http://localhost:5173",
      "http://localhost:3000"
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-org-id"]
  })
);

app.options("*", cors());

// Ensure preflight requests always get a response
app.options("*", cors());

/** -------------------- Body parsing -------------------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));

// If JSON parsing fails, return JSON (not HTML)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ ok: false, error: "Invalid JSON body" });
  }
  next(err);
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
app.use("/api/integrations", integrationsRoutes);
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

// ORG routes
app.use("/api/org", orgRoutes);
app.use("/api/organizations", organizationsRoutes);

// Optional other routes
app.use("/api/seed", seedRoutes);
app.use("/api/accounts", accountsRoutes);
app.use("/api/metrics", metricsRoutes);
app.use("/api/me", meRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/attribution", attributionRoutes);

/** -------------------- 404 fallback LAST -------------------- */
app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Not Found", path: req.originalUrl });
});

/** -------------------- Boot -------------------- */
const PORT = Number(process.env.PORT) || 5001;

// Accept either MONGO_URI or MONGODB_URI (handles naming differences)
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function start() {
  try {
    // Quick env debug (safe preview)
    console.log("ENV PORT:", PORT);
    console.log("ENV MONGO_URI exists?", !!MONGO_URI);
    console.log("ENV MONGO_URI preview:", MONGO_URI ? MONGO_URI.slice(0, 35) : "MISSING");

    if (!MONGO_URI) {
      console.error("❌ Missing MONGO_URI (or MONGODB_URI) in backend/.env");
      process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connected");
    console.log("Mongo readyState:", mongoose.connection.readyState);
    console.log("Mongo host:", mongoose.connection.host);
    console.log("Mongo DB:", mongoose.connection.name);

    app.listen(PORT, "0.0.0.0", () => {
      console.log("=====================================");
      console.log(`🚀 Server listening on http://localhost:${PORT}`);
      console.log("=====================================");
    });
  } catch (err) {
    console.error("❌ MongoDB connection error:", err?.message || err);
    process.exit(1);
  }
}

start();

// Process-level safety
process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));