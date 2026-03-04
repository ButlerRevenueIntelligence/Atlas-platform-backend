const { MongoClient, ObjectId } = require("mongodb");

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error("Missing Mongo URI env var (MONGODB_URI / MONGO_URI / DATABASE_URL)");

  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db(); // uses DB from connection string
  const users = db.collection("users");

  const res = await users.updateOne(
    { _id: new ObjectId("698e785aa1784e1b4fe5f992") },
    { $set: { orgId: new ObjectId("698e7113d7184f8aacf18083"), role: "owner" } }
  );

  console.log("Matched:", res.matchedCount, "Modified:", res.modifiedCount);

  await client.close();
})();
