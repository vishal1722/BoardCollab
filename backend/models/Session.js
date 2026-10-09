import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, maxlength: 80 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    isPrivate: { type: Boolean, default: false },
    inviteCodeHash: { type: String, select: false },
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model("Session", sessionSchema);
