const { MongoClient, ObjectId } = require("mongodb");

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error("Missing Mongo URI env var");

  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db();
  const users = db.collection("users");

  const res = await users.updateOne(
    { _id: new ObjectId("698e785aa1784e1b4fe5f992") },
    { $set: { orgId: new ObjectId("698e7113d7184f8a0cf18083") } }
  );

  console.log("matched:", res.matchedCount, "modified:", res.modifiedCount);

  await client.close();
})();
