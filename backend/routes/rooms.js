import { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Element from "../models/Element.js";
import Session from "../models/Session.js";

const hashInviteCode = (code) => createHash("sha256").update(code).digest("hex");

export default function roomRoutes(authenticate) {
  const router = Router();
  router.use(authenticate);

  router.post("/", async (req, res, next) => {
    try {
      const { name = "Untitled board", isPrivate = false } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 80) {
        return res.status(400).json({ error: "Room name must be between 1 and 80 characters" });
      }
      if (typeof isPrivate !== "boolean") return res.status(400).json({ error: "isPrivate must be a boolean" });
      const roomId = randomUUID();
      const inviteCode = isPrivate ? randomBytes(18).toString("base64url") : undefined;
      const room = await Session.create({
        roomId,
        name: name.trim(),
        owner: req.user.sub,
        isPrivate,
        inviteCodeHash: inviteCode ? hashInviteCode(inviteCode) : undefined,
      });
      return res.status(201).json({
        room: { roomId: room.roomId, name: room.name, isPrivate: room.isPrivate },
        ...(inviteCode ? { inviteCode } : {}),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const room = await Session.findOne({ roomId: req.params.id }).select("+inviteCodeHash");
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (room.isPrivate) {
        const code = req.get("x-room-invite");
        if (!code || hashInviteCode(code) !== room.inviteCodeHash) {
          return res.status(403).json({ error: "A valid room invite is required" });
        }
      }
      const elements = await Element.find({ roomId: room.roomId })
        .sort({ updatedAt: 1 })
        .lean();
      return res.json({
        room: { roomId: room.roomId, name: room.name, isPrivate: room.isPrivate },
        elements,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
