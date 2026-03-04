import bcrypt from "bcrypt";

const run = async () => {
  const hash = await bcrypt.hash("Butler2026", 10);
  console.log("NEW HASH:", hash);
};

run();