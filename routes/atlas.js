import express from "express";
import { buildResponse } from "../services/atlasBrain.js";

const router = express.Router();

router.post("/ask", async (req, res) => {
  try {

    const { question, metrics } = req.body;

    const answer = buildResponse(question, metrics);

    res.json({
      answer,
      confidence: 0.86,
      generatedBy: "Atlas AI Operator"
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Atlas AI failed to analyze request"
    });

  }
});

export default router;