import bcrypt from "bcryptjs";

const hash = await bcrypt.hash("Atlas123!", 10);
console.log(hash);