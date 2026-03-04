require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error("Missing Mongo URI env var (MONGODB_URI / MONGO_URI / DATABASE_URL)");

  const USER_ID = "698e785aa1784e1b4fe5f992";
  const CORRECT_ORG_ID = "698e7113d7184f8aacf18083";

  const client = new MongoClient(uri);
  await client.connect();

  // Uses DB name from your connection string
  const db = client.db();
  const users = db.collection("users");
  const memberships = db.collection("memberships");

  const u = await users.updateOne(
    { _id: new ObjectId(USER_ID) },
    { $set: { orgId: new ObjectId(CORRECT_ORG_ID), role: "owner" } }
  );

  const m = await memberships.updateMany(
    { userId: new ObjectId(USER_ID) },
    { $set: { organizationId: new ObjectId(CORRECT_ORG_ID), role: "owner" } }
  );

  console.log("Updated users:", u.modifiedCount);
  console.log("Updated memberships:", m.modifiedCount);

  await client.close();
})();
