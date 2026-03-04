const { MongoClient, ObjectId } = require("mongodb");

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI");

  const userId = new ObjectId("698e785aa1784e1b4fe5f992"); // your user _id
  const orgId  = new ObjectId("698e7113d7184f8a0cf18083"); // your orgId

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  const res = await db.collection("organizations").updateOne(
    { _id: orgId },
    {
      $set: {
        ownerId: userId,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      }
    }
  );

  console.log("matched:", res.matchedCount, "modified:", res.modifiedCount);
  console.log("org now:", await db.collection("organizations").findOne({ _id: orgId }));

  await client.close();
})();
