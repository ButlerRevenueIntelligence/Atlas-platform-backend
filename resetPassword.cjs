const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI");

  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db();
  const users = db.collection("users");

  const email = "armon@testco.com";
  const newPassword = "Test1234!";

  const passwordHash = await bcrypt.hash(newPassword, 10);

  const res = await users.updateOne(
    { email },
    { $set: { passwordHash } }
  );

  console.log("matched:", res.matchedCount, "modified:", res.modifiedCount);

  await client.close();
})();
