import mongoose from "mongoose";

export async function connectDatabase(uri) {
  if (!uri) throw new Error("MONGO_URI is required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log("Connected to MongoDB");
}
