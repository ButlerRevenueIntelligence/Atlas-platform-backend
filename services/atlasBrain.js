function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function analyzeMetrics(metrics = {}) {
  const revenue = safeNum(metrics.revenue30);
  const pipeline = safeNum(metrics.pipelineValue);
  const coverage = safeNum(metrics.coverage);
  const riskLevel = safeNum(metrics.riskLevel);
  const forecastConfidence = safeNum(metrics.forecastConfidence);

  const insights = [];
  const actions = [];
  const risks = [];

  if (coverage < 2) {
    risks.push("Pipeline coverage is critically low.");
    actions.push("Increase qualified pipeline generation immediately.");
  } else if (coverage < 4) {
    insights.push("Pipeline coverage is workable but still below elite forecast protection.");
    actions.push("Improve pipeline depth to strengthen forecast stability.");
  } else {
    insights.push("Pipeline coverage is strong and helping protect revenue outcomes.");
  }

  if (riskLevel > 70) {
    risks.push("Revenue forecast volatility is elevated.");
    actions.push("Stabilize late-stage opportunities and enforce next-step accountability.");
  } else if (riskLevel > 45) {
    insights.push("Revenue risk is present but still manageable with tighter execution.");
  } else {
    insights.push("Current revenue risk profile appears relatively controlled.");
  }

  if (pipeline > revenue * 3 && revenue > 0) {
    insights.push("Pipeline size is healthy relative to current revenue performance.");
  }

  if (forecastConfidence > 0) {
    insights.push(`Forecast confidence is currently modeled at ${forecastConfidence}%.`);
  }

  return { insights, actions, risks };
}

export function buildResponse(question = "", metrics = {}) {
  const { insights, actions, risks } = analyzeMetrics(metrics);

  let answer = "Atlas analyzed the current revenue signals.\n\n";

  if (question) {
    answer += `Question: ${question}\n\n`;
  }

  if (insights.length) {
    answer += "Key Observations:\n";
    insights.forEach((item) => {
      answer += `• ${item}\n`;
    });
  }

  if (risks.length) {
    answer += "\nRisks:\n";
    risks.forEach((item) => {
      answer += `• ${item}\n`;
    });
  }

  if (actions.length) {
    answer += "\nRecommended Actions:\n";
    actions.forEach((item) => {
      answer += `• ${item}\n`;
    });
  }

  answer += "\nAtlas will continue monitoring revenue signals and update recommendations as new data changes.";

  return answer;
}