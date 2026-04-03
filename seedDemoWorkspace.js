import Deal from "../models/Deal.js";
import Account from "../models/Account.js";

export async function seedDemoWorkspace({ orgId }) {
  try {
    // Prevent duplicate seeding
    const existing = await Deal.findOne({ orgId });
    if (existing) return;

    // DEMO DEALS
    const deals = [
      {
        orgId,
        name: "Enterprise SaaS Expansion",
        amount: 120000,
        stage: "Closed Won",
        region: "United States",
        source: "demo",
      },
      {
        orgId,
        name: "EU Manufacturing Contract",
        amount: 85000,
        stage: "Proposal",
        region: "Germany",
        source: "demo",
      },
      {
        orgId,
        name: "Asia Distribution Deal",
        amount: 54000,
        stage: "Negotiation",
        region: "Singapore",
        source: "demo",
      },
    ];

    // DEMO ACCOUNTS
    const accounts = [
      {
        orgId,
        name: "Apex Manufacturing",
        industry: "Manufacturing",
        region: "United States",
        source: "demo",
      },
      {
        orgId,
        name: "EuroTech Systems",
        industry: "Technology",
        region: "Germany",
        source: "demo",
      },
    ];

    await Deal.insertMany(deals);
    await Account.insertMany(accounts);

    console.log("✅ Demo workspace seeded");
  } catch (err) {
    console.error("❌ Demo seed failed:", err);
  }
}