export function calculateOperatorSignals({ deals = [], metrics = {} }) {

  const pipelineValue = deals.reduce((sum, d) => {
    const amt = Number(d.amount || 0)
    const prob = Number(d.probability || 0)
    return sum + amt * prob
  }, 0)

  const revenue30 = metrics.revenue30 || 0

  const coverage = revenue30 > 0 ? pipelineValue / revenue30 : 0

  let forecastConfidence = 80

  if (coverage < 2) forecastConfidence -= 20
  if (coverage < 1.5) forecastConfidence -= 10

  const riskLevel =
    forecastConfidence > 75
      ? "Low"
      : forecastConfidence > 60
      ? "Moderate"
      : "High"

  return {
    pipelineValue,
    revenue30,
    coverage: Number(coverage.toFixed(2)),
    forecastConfidence,
    riskLevel
  }

}