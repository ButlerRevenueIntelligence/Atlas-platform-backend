import express from "express";

const router = express.Router();

router.post("/ask", async (req, res) => {

  try {

    const { question, metrics } = req.body;

    const coverage = metrics?.coverage || 0;
    const revenue = metrics?.revenue30 || 0;
    const pipeline = metrics?.pipelineValue || 0;

    let answer = "";

    if (question.toLowerCase().includes("pipeline")) {

      answer = `
Atlas Analysis:

Your pipeline coverage is ${coverage.toFixed(2)}x.

Recommended:
Aim for 4x coverage to stabilize forecasting.

Current pipeline value: $${pipeline.toLocaleString()}.
`;

    }

    else if (question.toLowerCase().includes("revenue")) {

      answer = `
Atlas Analysis:

30-day revenue is currently $${revenue.toLocaleString()}.

Pipeline suggests additional revenue potential of $${pipeline.toLocaleString()}.

Focus on closing late-stage deals.
`;

    }

    else {

      answer = `
Atlas Insight:

Based on current metrics, revenue momentum and pipeline health appear stable.

Recommended focus:
Improve deal velocity and optimize marketing channels.
`;

    }

    res.json({ answer });

  }

  catch (err) {

    res.status(500).json({
      error: err.message
    });

  }

});

export default router;