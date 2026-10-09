import mongoose from "mongoose";

const elementSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },
    elementId: { type: String, required: true },
    type: { type: String, required: true, enum: ["stroke", "rect", "circle", "text"] },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    deleted: { type: Boolean, default: false },
    clock: { type: Number, required: true },
    actorId: { type: String, required: true },
    opId: { type: String, required: true },
  },
  { timestamps: true }
);

elementSchema.index({ roomId: 1, elementId: 1 }, { unique: true });
elementSchema.index({ roomId: 1, updatedAt: 1 });

export default mongoose.model("Element", elementSchema);
