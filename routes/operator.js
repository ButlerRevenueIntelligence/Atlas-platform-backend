import express from "express"
import { calculateOperatorSignals } from "../services/operatorEngine.js"

const router = express.Router()

router.get("/signals", async (req, res) => {

  try {

    const deals = [] // later from DB
    const metrics = { revenue30: 1200000 }

    const signals = calculateOperatorSignals({ deals, metrics })

    res.json(signals)

  } catch (err) {

    console.error(err)
    res.status(500).json({ error: "Operator signals failed" })

  }

})

export default router