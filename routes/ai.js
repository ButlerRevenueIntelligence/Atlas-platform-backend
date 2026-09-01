import React, { useEffect, useMemo, useState } from "react";
import {
  analyzeWithAtlas,
  getDashboard,
  searchGraphIQOrganizations,
} from "../api";
import RevenueRiskAlerts from "../components/atlas/RevenueRiskAlerts";
import RecommendedActions from "../components/atlas/RecommendedActions";
import {
  alerts as atlasAlerts,
  briefing as atlasBriefing,
} from "../data/AtlasMockData.js";
import ExecutiveBriefing from "../components/atlas/ExecutiveBriefing";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

const pieColors = ["#67e8f9", "#93c5fd", "#86efac", "#facc15"];
const axisTick = { fill: "#94a3b8", fontSize: 11 };

const tooltipStyle = {
  background: "rgba(7,11,24,0.98)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "12px",
  color: "#fff",
  boxShadow: "0 16px 32px rgba(0,0,0,0.35)",
};

const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const moneyCompact = (num) => {
  const n = safeNum(num);
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
  return `$${n}`;
};

const styles = {
  page: {
    minHeight: "100vh",
    color: "#fff",
    padding: "14px 16px 24px",
    background:
      "radial-gradient(900px 500px at 15% 0%, rgba(37,99,235,0.18), transparent 55%), radial-gradient(900px 500px at 85% 0%, rgba(124,92,255,0.14), transparent 55%), linear-gradient(180deg, #050814 0%, #070b18 100%)",
  },
  wrap: {
    maxWidth: 1380,
    margin: "0 auto",
    display: "grid",
    gap: 12,
  },
  hero: {
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 20,
    padding: "18px 20px",
    background:
      "linear-gradient(135deg, rgba(30,64,175,0.18), rgba(37,99,235,0.10), rgba(255,255,255,0.02))",
    boxShadow: "0 12px 30px rgba(0,0,0,0.18)",
  },
  heroTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "flex-start",
  },
  eyebrow: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.18em",
    color: "rgba(125,211,252,0.88)",
    fontWeight: 800,
  },
  h1: {
    margin: "6px 0 0",
    fontSize: 28,
    lineHeight: 1.05,
    letterSpacing: -0.6,
    fontWeight: 900,
    color: "#ffffff",
  },
  heroText: {
    marginTop: 8,
    maxWidth: 760,
    fontSize: 14,
    lineHeight: 1.55,
    color: "rgba(226,232,240,0.90)",
  },
  badgeWrap: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignContent: "flex-start",
  },
  badge: {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.05)",
    fontSize: 11,
    fontWeight: 700,
    color: "#e2e8f0",
    whiteSpace: "nowrap",
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 10,
  },
  statCard: {
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: "14px 14px 13px",
    minHeight: 126,
    background: "rgba(255,255,255,0.032)",
    boxShadow: "0 8px 20px rgba(0,0,0,0.12)",
  },
  statLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    color: "rgba(148,163,184,0.88)",
    fontWeight: 800,
  },
  statValue: {
    marginTop: 10,
    fontSize: 26,
    fontWeight: 900,
    color: "#fff",
    lineHeight: 1.05,
  },
  statNote: {
    marginTop: 7,
    fontSize: 12,
    color: "rgba(203,213,225,0.76)",
    lineHeight: 1.45,
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "1.08fr 0.92fr",
    gap: 12,
  },
  section: {
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 18,
    background: "rgba(255,255,255,0.03)",
    overflow: "hidden",
    boxShadow: "0 10px 24px rgba(0,0,0,0.15)",
  },
  sectionHead: {
    padding: "12px 14px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 800,
    letterSpacing: -0.35,
    color: "#fff",
  },
  sectionSub: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.16em",
    color: "rgba(148,163,184,0.75)",
    fontWeight: 700,
    marginBottom: 4,
  },
  sectionBody: { padding: 14 },
  summaryList: { display: "grid", gap: 8 },
  summaryItem: {
    border: "1px solid rgba(255,255,255,0.07)",
    background: "rgba(4,10,24,0.34)",
    borderRadius: 14,
    padding: "12px 13px",
    fontSize: 13,
    lineHeight: 1.55,
    color: "#dbe4f0",
  },
  chartShell: {
    height: 260,
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    background: "rgba(4,10,24,0.72)",
    padding: 10,
  },
  promptGrid: { display: "grid", gap: 10 },
  feedGrid: { display: "grid", gap: 10 },
  feedCard: {
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: 13,
    background: "rgba(4,10,24,0.34)",
  },
  feedTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: "#fff",
  },
  feedBody: {
    marginTop: 7,
    fontSize: 13,
    lineHeight: 1.55,
    color: "#dbe4f0",
  },
  askPanel: {
    display: "grid",
    gap: 12,
  },
  askInputWrap: {
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    background: "rgba(4,10,24,0.45)",
    padding: 12,
  },
  askTextarea: {
    width: "100%",
    minHeight: 110,
    resize: "vertical",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    background: "rgba(255,255,255,0.03)",
    color: "#fff",
    padding: 14,
    fontSize: 14,
    lineHeight: 1.6,
    outline: "none",
    boxSizing: "border-box",
  },
  askActionRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: 12,
  },
  askButton: {
    border: "1px solid rgba(56,189,248,0.35)",
    background: "linear-gradient(135deg, rgba(37,99,235,0.28), rgba(56,189,248,0.16))",
    color: "#fff",
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 800,
    cursor: "pointer",
  },
  askButtonSecondary: {
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    color: "#dbe4f0",
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  askMuted: {
    fontSize: 12,
    color: "rgba(203,213,225,0.72)",
  },
  askResponse: {
    border: "1px solid rgba(56,189,248,0.20)",
    borderRadius: 16,
    padding: 14,
    background:
      "linear-gradient(135deg, rgba(56,189,248,0.10), rgba(255,255,255,0.025))",
  },
  askResponseTitle: {
    fontSize: 12,
    fontWeight: 800,
    color: "#bfefff",
    marginBottom: 8,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  askResponseBody: {
    fontSize: 14,
    lineHeight: 1.7,
    color: "#e7f1fb",
    whiteSpace: "pre-wrap",
  },
  askPromptButton: {
    width: "100%",
    textAlign: "left",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: "13px 14px",
    background: "rgba(4,10,24,0.34)",
    color: "#dbe4f0",
    fontSize: 13,
    lineHeight: 1.55,
    cursor: "pointer",
  },
  emptyState: {
    minHeight: 180,
    border: "1px dashed rgba(255,255,255,0.12)",
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    color: "rgba(226,232,240,0.78)",
    fontSize: 14,
    lineHeight: 1.6,
    textAlign: "center",
    background: "rgba(4,10,24,0.34)",
  },
  errorBox: {
    border: "1px solid rgba(255,120,120,0.35)",
    background: "rgba(255,0,0,0.10)",
    color: "#FFD7D7",
    borderRadius: 14,
    padding: 16,
    fontSize: 14,
  },
};

function Section({ title, subtitle, children }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHead}>
        <div>
          {subtitle ? <div style={styles.sectionSub}>{subtitle}</div> : null}
          <div style={styles.sectionTitle}>{title}</div>
        </div>
      </div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  );
}

function SmallStat({ label, value, note }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
      {note ? <div style={styles.statNote}>{note}</div> : null}
    </div>
  );
}

function EmptyState({ text }) {
  return <div style={styles.emptyState}>{text}</div>;
}

export default function AtlasAIOperator() {
  const [question, setQuestion] = useState("");
  const [atlasResponse, setAtlasResponse] = useState("");
  const [asking, setAsking] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [externalIntelUsed, setExternalIntelUsed] = useState(false);
  const [externalCompanyCount, setExternalCompanyCount] = useState(0);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        setLoading(true);
        setLoadError("");
        const res = await getDashboard();
        if (!mounted) return;
        setDashboard(res || null);
      } catch (err) {
        console.error(err);
        if (!mounted) return;
        setLoadError(err?.message || "Failed to load Atlas AI Operator");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const workspaceMode = String(dashboard?.workspaceMode || "demo").toLowerCase();
  const isDemo = workspaceMode === "demo";
  const orgName = dashboard?.activeWorkspace?.name || "Workspace";
  const orgId =
    dashboard?.activeWorkspace?._id ||
    dashboard?.activeWorkspace?.id ||
    "";
  const summary = dashboard?.summary || {};
  const revenue30 = safeNum(summary.revenue, 0);
  const pipelineValue = safeNum(summary.pipelineValue, 0);
  const openDeals = safeNum(summary.openDeals, 0);
  const wonDeals = safeNum(summary.wonDeals, 0);
  const lostDeals = safeNum(summary.lostDeals, 0);
  const forecast90d = safeNum(summary.forecast90d, 0);
  const metrics = Array.isArray(dashboard?.metrics) ? dashboard.metrics : [];
  const hasLiveData =
    revenue30 > 0 || pipelineValue > 0 || openDeals > 0 || metrics.length > 0;

  const forecastTrend = useMemo(() => {
    if (isDemo) {
      return [
        { period: "30D", baseline: 640000, projected: 710000 },
        { period: "60D", baseline: 1180000, projected: 1320000 },
        { period: "90D", baseline: 1760000, projected: 2010000 },
        { period: "120D", baseline: 2290000, projected: 2620000 },
      ];
    }

    return [
      { period: "30D", baseline: Math.round(revenue30 * 0.4), projected: Math.round(revenue30 * 0.45) },
      { period: "60D", baseline: Math.round(revenue30 * 0.7), projected: Math.round(revenue30 * 0.8) },
      { period: "90D", baseline: Math.round(revenue30), projected: Math.round(forecast90d) },
      { period: "120D", baseline: Math.round(revenue30 * 1.3), projected: Math.round(forecast90d * 1.18) },
    ];
  }, [isDemo, revenue30, forecast90d]);

  const riskBreakdown = useMemo(() => {
    if (isDemo) {
      return [
        { name: "Pipeline", value: 82 },
        { name: "Forecast", value: 74 },
        { name: "Accounts", value: 61 },
        { name: "Channels", value: 57 },
      ];
    }

    const pipelineRisk =
      pipelineValue > 0 && revenue30 > 0
        ? Math.max(20, Math.min(90, 90 - Math.round((pipelineValue / Math.max(revenue30, 1)) * 10)))
        : 65;

    const forecastRisk =
      forecast90d > 0 && revenue30 > 0
        ? Math.max(20, Math.min(90, 80 - Math.round((forecast90d / Math.max(revenue30, 1)) * 5)))
        : 60;

    const accountRisk = openDeals > 0 ? Math.max(20, 70 - openDeals * 3) : 58;
    const channelRisk = metrics.length > 0 ? 48 : 55;

    return [
      { name: "Pipeline", value: pipelineRisk },
      { name: "Forecast", value: forecastRisk },
      { name: "Accounts", value: accountRisk },
      { name: "Channels", value: channelRisk },
    ];
  }, [isDemo, pipelineValue, revenue30, forecast90d, openDeals, metrics.length]);

  const operatorMix = useMemo(() => {
    if (isDemo) {
      return [
        { label: "Forecast", value: 34 },
        { label: "Pipeline", value: 28 },
        { label: "Growth", value: 22 },
        { label: "Expansion", value: 16 },
      ];
    }

    return [
      { label: "Forecast", value: 30 },
      { label: "Pipeline", value: 32 },
      { label: "Growth", value: 22 },
      { label: "Expansion", value: 16 },
    ];
  }, [isDemo]);

  const operatorFeed = useMemo(() => {
    if (isDemo) {
      return [
        {
          title: "Forecast Pressure",
          body: "Three active deals currently represent a disproportionate share of near-term forecast exposure.",
        },
        {
          title: "Growth Opportunity",
          body: "Organic and paid search signals continue to show stronger revenue efficiency than lower-converting awareness campaigns.",
        },
        {
          title: "Pipeline Risk",
          body: "Late-stage deal timing remains one of the biggest threats to forecast stability this cycle.",
        },
        {
          title: "Expansion Signal",
          body: "Top accounts are showing stronger engagement patterns, increasing cross-sell and upsell potential.",
        },
      ];
    }

    if (!hasLiveData) {
      return [
        {
          title: "Live Mode Active",
          body: "This workspace is in live mode and no longer using hardcoded operator demo numbers.",
        },
        {
          title: "Awaiting Revenue Signals",
          body: "Atlas AI Operator will become more precise once live deals, metrics, and forecast inputs are flowing into the workspace.",
        },
        {
          title: "Pipeline Visibility Needed",
          body: "Connect CRM and opportunity data so Operator can measure real forecast pressure and stage risk.",
        },
        {
          title: "Execution Readiness",
          body: "As soon as revenue and pipeline data exist, Atlas will surface operator alerts and decision pressure here.",
        },
      ];
    }

    return [
      {
        title: "Forecast Pressure",
        body: `Atlas is monitoring a ${moneyCompact(forecast90d)} 90-day forecast against ${moneyCompact(pipelineValue)} in pipeline value.`,
      },
      {
        title: "Growth Opportunity",
        body: `Current 30-day revenue of ${moneyCompact(revenue30)} suggests live upside if pipeline momentum is protected.`,
      },
      {
        title: "Pipeline Risk",
        body: `${openDeals} open opportunities are currently shaping near-term operator confidence and execution pressure.`,
      },
      {
        title: "Execution Signal",
        body: `${wonDeals} won deals and ${lostDeals} lost deals are influencing forecast reliability for this workspace.`,
      },
    ];
  }, [isDemo, hasLiveData, forecast90d, pipelineValue, revenue30, openDeals, wonDeals, lostDeals]);

  const strategicPrompts = [
    "What is the highest-risk forecast scenario right now?",
    "Which accounts should leadership prioritize this week?",
    "Find companies that provide revenue intelligence software.",
    "Find companies that could be good targets for our business.",
  ];

  const liveCoverage = useMemo(() => {
    if (!revenue30) return 0;
    return Number((pipelineValue / revenue30).toFixed(1));
  }, [pipelineValue, revenue30]);

  const liveRiskLevel = useMemo(() => {
    const highest = Math.max(...riskBreakdown.map((item) => item.value), 0);
    if (highest >= 80) return "High";
    if (highest >= 60) return "Moderate";
    return "Controlled";
  }, [riskBreakdown]);

  const activeAlerts = useMemo(() => {
    if (isDemo) return atlasAlerts;

    const alerts = [];

    if (!hasLiveData) {
      alerts.push({
        title: "No live revenue inputs yet",
        body: "Atlas AI Operator is active, but this workspace does not have enough live data to generate risk-grade decisioning yet.",
        severity: "low",
      });
      return alerts;
    }

    if (liveCoverage < 2.5) {
      alerts.push({
        title: "Pipeline coverage is thin",
        body: `Current coverage is ${liveCoverage}x, which may not fully support forecast confidence.`,
        severity: "high",
      });
    }

    if (lostDeals > wonDeals && lostDeals > 0) {
      alerts.push({
        title: "Loss pressure is elevated",
        body: `Lost deals (${lostDeals}) currently exceed won deals (${wonDeals}) in this tracked period.`,
        severity: "medium",
      });
    }

    if (openDeals === 0) {
      alerts.push({
        title: "No active pipeline",
        body: "There are no open opportunities currently feeding Operator forecasting.",
        severity: "high",
      });
    }

    if (!alerts.length) {
      alerts.push({
        title: "Operator status stable",
        body: "Atlas is tracking live signals and no critical operator alerts are currently elevated.",
        severity: "low",
      });
    }

    return alerts;
  }, [isDemo, hasLiveData, liveCoverage, lostDeals, wonDeals, openDeals]);

  const operatorMoves = useMemo(() => {
    if (isDemo) {
      return [
        {
          title: "Reduce forecast dependency",
          description:
            "Accelerate second-tier pipeline opportunities to reduce near-term dependence on a small group of late-stage deals.",
        },
        {
          title: "Escalate high-value accounts",
          description:
            "Direct leadership attention toward expansion-ready accounts showing stronger engagement and buying momentum.",
        },
        {
          title: "Tighten weak channel allocation",
          description:
            "Move budget away from lower-efficiency activity and protect spend behind the best-performing revenue motions.",
        },
        {
          title: "Force cleaner decision timelines",
          description:
            "Push the sales team to establish explicit next-step timing on late-stage opportunities at risk of slipping.",
        },
      ];
    }

    if (!hasLiveData) {
      return [
        {
          title: "Connect CRM and revenue inputs",
          description:
            "Operator needs live deals, stages, and revenue inputs to generate decision-quality recommendations.",
        },
        {
          title: "Start metric ingestion",
          description:
            "Bring in spend, lead, and revenue data so Atlas can measure live operator pressure and forecast confidence.",
        },
        {
          title: "Populate open opportunities",
          description:
            "Without active opportunities, Operator cannot model real execution pressure or slippage risk.",
        },
      ];
    }

    return [
      {
        title: "Protect pipeline coverage",
        description:
          liveCoverage < 2.5
            ? `Coverage is currently ${liveCoverage}x. Leadership should reinforce pipeline creation to stabilize forecast quality.`
            : `Coverage is ${liveCoverage}x. Continue protecting the strongest opportunity sources to maintain forecast stability.`,
      },
      {
        title: "Escalate the right opportunities",
        description:
          `${openDeals} open opportunities are driving near-term operator confidence. Tighten next steps on the highest-value deals.`,
      },
      {
        title: "Improve revenue efficiency",
        description:
          `Current 30-day revenue is ${moneyCompact(revenue30)}. Atlas recommends focusing effort where live revenue momentum is already present.`,
      },
    ];
  }, [isDemo, hasLiveData, liveCoverage, openDeals, revenue30]);

  const summaryStats = useMemo(
    () => [
      {
        label: "Forecast Confidence",
        value: hasLiveData ? `${Math.max(40, 100 - Math.max(...riskBreakdown.map((r) => r.value)))}%` : isDemo ? "78%" : "0%",
        note: hasLiveData ? "Live modeled outlook" : isDemo ? "Current modeled outlook" : "Waiting for live inputs",
      },
      {
        label: "Active Risk Alerts",
        value: String(activeAlerts.length),
        note: hasLiveData ? "Requiring leadership review" : isDemo ? "Requiring leadership review" : "Current live signal count",
      },
      {
        label: "Recommended Actions",
        value: String(operatorMoves.length),
        note: "Priority operator moves",
      },
      {
        label: "Operator Mode",
        value: isDemo ? "Demo" : "Live",
        note: isDemo ? "Monitoring simulated data" : "Monitoring workspace data",
      },
    ],
    [hasLiveData, isDemo, riskBreakdown, activeAlerts.length, operatorMoves.length]
  );

  const summaryPoints = useMemo(() => {
    if (isDemo) {
      return [
        `Pipeline coverage is currently holding around ${liveCoverage || 2.8}x, which keeps the operator focused on forecast quality and stage progression.`,
        `${liveRiskLevel} risk is concentrated across forecast and pipeline categories, with leadership attention needed on late-stage execution.`,
        "Paid and organic performance still support upside when allocation stays disciplined.",
        "Atlas Operator should be used as a decision system, not just a reporting screen.",
      ];
    }

    if (!hasLiveData) {
      return [
        "Atlas AI Operator is active in live mode, but there is not enough live data yet to generate executive-grade decisioning.",
        "Once revenue, pipeline, and opportunity movement are flowing into this workspace, Operator will surface real forecast pressure.",
        "This workspace is no longer using hardcoded demo operator metrics.",
        "Connect live systems so Atlas can turn signals into recommendations leadership can act on.",
      ];
    }

    return [
      `Pipeline coverage is currently holding around ${liveCoverage}x based on ${moneyCompact(pipelineValue)} in pipeline and ${moneyCompact(revenue30)} in 30-day revenue.`,
      `${liveRiskLevel} risk is concentrated across the categories Atlas is actively monitoring for ${orgName}.`,
      `${openDeals} open opportunities are shaping forecast confidence and execution pressure in this workspace.`,
      "Atlas Operator should be used as a live decision system, not just a reporting screen.",
    ];
  }, [isDemo, hasLiveData, liveCoverage, liveRiskLevel, pipelineValue, revenue30, orgName, openDeals]);

  const operatorMetrics = useMemo(
    () => ({
      coverage: liveCoverage,
      revenue30,
      pipelineValue,
      forecast90d,
      riskLevel: liveRiskLevel,
      activeRiskAlerts: activeAlerts.length,
      recommendedActions: operatorMoves.length,
      openDeals,
      wonDeals,
      lostDeals,
      workspaceMode,
      orgName,
    }),
    [
      liveCoverage,
      revenue30,
      pipelineValue,
      forecast90d,
      liveRiskLevel,
      activeAlerts.length,
      operatorMoves.length,
      openDeals,
      wonDeals,
      lostDeals,
      workspaceMode,
      orgName,
    ]
  );

  function shouldUseGraphIQ(questionText) {
    const text = String(questionText || "").toLowerCase();

    const externalTerms = [
      "find companies",
      "find organizations",
      "find businesses",
      "companies that",
      "organizations that",
      "businesses that",
      "companies like",
      "who sells",
      "who provides",
      "who makes",
      "suppliers",
      "vendors",
      "manufacturers",
      "companies in",
      "businesses in",
      "market opportunities",
      "target companies",
      "prospects",
      "potential customers",
    ];

    return externalTerms.some((term) => text.includes(term));
  }

  function cleanGraphIQQuery(questionText) {
    return String(questionText || "")
      .replace(/find companies (that )?/i, "")
      .replace(/find organizations (that )?/i, "")
      .replace(/find businesses (that )?/i, "")
      .replace(/show me companies (that )?/i, "")
      .replace(/companies that /i, "")
      .replace(/organizations that /i, "")
      .replace(/businesses that /i, "")
      .replace(/who (sells|provides|makes) /i, "")
      .trim();
  }

  async function handleAsk(customQuestion) {
    const finalQuestion = (customQuestion ?? question).trim();
    if (!finalQuestion || asking) return;

    try {
      setAsking(true);
      setAtlasResponse("");
      setExternalIntelUsed(false);
      setExternalCompanyCount(0);

      let graphiqContext = null;

      if (shouldUseGraphIQ(finalQuestion)) {
        try {
          const graphiqQuery =
            cleanGraphIQQuery(finalQuestion) || finalQuestion;

          const graphiqResponse = await searchGraphIQOrganizations({
            capabilities: [graphiqQuery],
          });

          const rawGraphIQ =
            graphiqResponse?.data ?? graphiqResponse;

          const organizations = Array.isArray(rawGraphIQ)
            ? rawGraphIQ
            : rawGraphIQ?.entities ||
              rawGraphIQ?.organizations ||
              rawGraphIQ?.results ||
              rawGraphIQ?.items ||
              rawGraphIQ?.data ||
              [];

          const limitedOrganizations = Array.isArray(organizations)
            ? organizations.slice(0, 10)
            : [];

          graphiqContext = {
            source: "GraphIQ",
            query: graphiqQuery,
            totalMatches:
              Number(rawGraphIQ?.total_count) ||
              Number(rawGraphIQ?.totalCount) ||
              limitedOrganizations.length,
            organizations: limitedOrganizations.map((org) => ({
              name:
                org?.name ||
                org?.organizationName ||
                org?.legalName ||
                org?.title ||
                "Unknown organization",
              website:
                org?.website ||
                org?.websiteUrl ||
                org?.domain ||
                org?.url ||
                "",
              description:
                org?.description ||
                org?.summary ||
                org?.overview ||
                "",
              industries: Array.isArray(org?.industries)
                ? org.industries
                : org?.industry
                ? [org.industry]
                : [],
              capabilities: Array.isArray(org?.capabilities)
                ? org.capabilities
                : [],
              locations: Array.isArray(org?.locations)
                ? org.locations
                : org?.location
                ? [org.location]
                : [],
            })),
          };

          setExternalIntelUsed(true);
          setExternalCompanyCount(limitedOrganizations.length);
        } catch (graphiqError) {
          console.error(
            "Atlas Operator GraphIQ lookup failed:",
            graphiqError
          );
        }
      }

      const res = await analyzeWithAtlas({
        orgId,
        question: finalQuestion,
        metrics: operatorMetrics,
        context: {
          workspaceMode,
          hasLiveData,
          orgName,
          summary,
          alerts: activeAlerts,
          actions: operatorMoves,
          externalCompanyIntelligence: graphiqContext,
          operatorInstructions: graphiqContext
            ? "Use the GraphIQ external company intelligence included in this context when answering. Clearly distinguish external company intelligence from Atlas internal revenue data. Do not invent information that is not present in the supplied GraphIQ results."
            : "Answer using the internal Atlas revenue and operator context supplied.",
        },
      });

      setAtlasResponse(
        res?.result ||
          "Atlas could not generate a response right now. Please try again."
      );
      setQuestion(finalQuestion);
    } catch (err) {
      console.error(err);
      setAtlasResponse(
        err?.message ||
          "Atlas ran into an issue while analyzing your request. Please try again."
      );
    } finally {
      setAsking(false);
    }
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.wrap}>
          <div style={styles.hero}>
            <h1 style={styles.h1}>Loading Atlas AI Operator...</h1>
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={styles.page}>
        <div style={styles.wrap}>
          <div style={styles.errorBox}>{loadError}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <div style={styles.hero}>
          <div style={styles.heroTop}>
            <div>
              <div style={styles.eyebrow}>Revenue Intelligence Copilot</div>
              <h1 style={styles.h1}>Atlas AI Operator</h1>
              <div style={styles.heroText}>
                Atlas AI Operator turns revenue signals into decisions. It monitors
                forecast risk, surfaces execution pressure, and recommends what
                leadership should act on next for <b>{orgName}</b>.
              </div>
            </div>

            <div style={styles.badgeWrap}>
              {[
                isDemo ? "Operator Demo" : "Operator Live",
                hasLiveData ? "Monitoring Forecast" : "Awaiting Signals",
                "External Intelligence Active",
                "Atlas AI Active",
              ].map((item) => (
                <div key={item} style={styles.badge}>
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={styles.statsGrid}>
          {summaryStats.map((item) => (
            <SmallStat
              key={item.label}
              label={item.label}
              value={item.value}
              note={item.note}
            />
          ))}
        </div>

        <div style={styles.twoCol}>
          <Section title="Forecast Trend" subtitle="Modeled Outlook">
            <div style={styles.chartShell}>
              {!isDemo && !hasLiveData ? (
                <EmptyState text="No live forecast trend data yet. Connect revenue and pipeline sources to activate Operator forecasting." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={forecastTrend}
                    margin={{ top: 6, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="4 4" stroke="rgba(255,255,255,0.08)" />
                    <XAxis dataKey="period" tick={axisTick} stroke="#94a3b8" />
                    <YAxis
                      tick={axisTick}
                      stroke="#94a3b8"
                      tickFormatter={(v) => moneyCompact(v)}
                    />
                    <Tooltip
                      formatter={(value, name) => [moneyCompact(value), name]}
                      contentStyle={tooltipStyle}
                      labelStyle={{ color: "#fff" }}
                    />
                    <Line
                      type="monotone"
                      dataKey="baseline"
                      name="Baseline"
                      stroke="#93c5fd"
                      strokeWidth={3}
                      dot={{ r: 3, fill: "#93c5fd", strokeWidth: 0 }}
                      activeDot={{ r: 6 }}
                      animationDuration={1400}
                      animationEasing="ease-out"
                    />
                    <Line
                      type="monotone"
                      dataKey="projected"
                      name="Projected"
                      stroke="#86efac"
                      strokeWidth={3}
                      dot={{ r: 3, fill: "#86efac", strokeWidth: 0 }}
                      activeDot={{ r: 6 }}
                      animationDuration={1700}
                      animationEasing="ease-out"
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </Section>

          <Section title="Operator Signal Distribution" subtitle="Signal Mix">
            <div style={styles.chartShell}>
              {!isDemo && !hasLiveData ? (
                <EmptyState text="No live operator signal mix yet." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={operatorMix}
                      dataKey="value"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      outerRadius={82}
                      innerRadius={48}
                      paddingAngle={3}
                      animationBegin={0}
                      animationDuration={1500}
                      animationEasing="ease-out"
                    >
                      {operatorMix.map((entry, index) => (
                        <Cell key={entry.label} fill={pieColors[index % pieColors.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => [`${value}%`, "Signal Share"]}
                      contentStyle={tooltipStyle}
                      labelStyle={{ color: "#fff" }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </Section>
        </div>

        <div style={styles.twoCol}>
          <Section title="Risk Severity by Category" subtitle="Risk Model">
            <div style={styles.chartShell}>
              {!isDemo && !hasLiveData ? (
                <EmptyState text="No live risk severity model yet." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={riskBreakdown}
                    margin={{ top: 6, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="4 4" stroke="rgba(255,255,255,0.08)" />
                    <XAxis dataKey="name" tick={axisTick} stroke="#94a3b8" />
                    <YAxis tick={axisTick} stroke="#94a3b8" domain={[0, 100]} />
                    <Tooltip
                      formatter={(value) => [`${value}/100`, "Severity"]}
                      contentStyle={tooltipStyle}
                      labelStyle={{ color: "#fff" }}
                    />
                    <Bar
                      dataKey="value"
                      fill="#facc15"
                      radius={[10, 10, 0, 0]}
                      animationDuration={1500}
                      animationEasing="ease-out"
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </Section>

          <Section title="Revenue Risk Alerts" subtitle="Flags">
            <RevenueRiskAlerts alerts={activeAlerts} />
          </Section>
        </div>

        <div style={styles.twoCol}>
          <Section title="Executive Briefing" subtitle="Narrative">
            <ExecutiveBriefing
              text={
                isDemo
                  ? atlasBriefing
                  : hasLiveData
                  ? `Atlas AI Operator is currently tracking ${moneyCompact(pipelineValue)} in pipeline, ${moneyCompact(revenue30)} in 30-day revenue, and a ${moneyCompact(forecast90d)} 90-day forecast for ${orgName}. Operator risk is currently assessed as ${liveRiskLevel.toLowerCase()}, with ${activeAlerts.length} active alert${activeAlerts.length === 1 ? "" : "s"} influencing leadership attention.`
                  : `Atlas AI Operator is active for ${orgName}, but there is not enough live revenue and pipeline data yet to generate a full executive narrative. Once live inputs are connected, this briefing will convert from empty-state guidance into decision-grade operator intelligence.`
              }
            />
          </Section>

          <Section title="Operator Feed" subtitle="Live Notes">
            <div style={styles.feedGrid}>
              {operatorFeed.map((item) => (
                <div key={item.title} style={styles.feedCard}>
                  <div style={styles.feedTitle}>{item.title}</div>
                  <div style={styles.feedBody}>{item.body}</div>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <div style={styles.twoCol}>
          <Section title="Next Best Operator Moves" subtitle="Priorities">
            <RecommendedActions actions={operatorMoves} />
          </Section>

          <Section title="Ask Atlas" subtitle="Copilot">
            <div style={styles.askPanel}>
              <div style={styles.askInputWrap}>
                <textarea
                  style={styles.askTextarea}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask about your revenue, pipeline, accounts, or market — or ask Atlas to find companies based on what they make, sell, or provide..."
                />

                <div style={styles.askActionRow}>
                  <button
                    style={styles.askButton}
                    onClick={() => handleAsk()}
                    disabled={asking || !orgId}
                  >
                    {asking ? "Analyzing..." : "Ask Atlas"}
                  </button>

                  <button
                    style={styles.askButtonSecondary}
                    onClick={() => {
                      setQuestion("");
                      setAtlasResponse("");
                    }}
                    disabled={asking}
                  >
                    Clear
                  </button>

                  <div style={styles.askMuted}>
                    Atlas can combine your internal revenue data with external company intelligence from GraphIQ.
                    {externalIntelUsed && externalCompanyCount > 0
                      ? ` ${externalCompanyCount} external companies were used in this answer.`
                      : ""}
                  </div>
                </div>
              </div>

              {atlasResponse ? (
                <div style={styles.askResponse}>
                  <div style={styles.askResponseTitle}>Atlas Response</div>
                  <div style={styles.askResponseBody}>{atlasResponse}</div>
                </div>
              ) : null}
            </div>
          </Section>
        </div>

        <div style={styles.twoCol}>
          <Section title="Executive Summary" subtitle="Overview">
            <div style={styles.summaryList}>
              {summaryPoints.map((point) => (
                <div key={point} style={styles.summaryItem}>
                  {point}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Strategic Prompt Library" subtitle="Questions">
            <div style={styles.promptGrid}>
              {strategicPrompts.map((prompt) => (
                <button
                  key={prompt}
                  style={styles.askPromptButton}
                  onClick={() => {
                    setQuestion(prompt);
                    handleAsk(prompt);
                  }}
                  disabled={asking || !orgId}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
