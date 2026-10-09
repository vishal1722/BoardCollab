import http from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { connectDatabase } from "./config/db.js";
import Element from "./models/Element.js";
import Session from "./models/Session.js";
import { compareVersions } from "../shared/crdt.js";
import { requireAuth } from "./utils/auth.js";
import authRoutes from "./routes/auth.js";
import roomRoutes from "./routes/rooms.js";
import { persistBatch } from "./utils/persist.js";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const PORT = Number(process.env.PORT ?? 5000);
const JWT_SECRET = process.env.JWT_SECRET;
const MAX_BATCH = 100;
const MAX_ELEMENT_BYTES = 64 * 1024;
const ALLOWED_TYPES = new Set(["stroke", "rect", "circle", "text"]);
const clientOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be configured with at least 32 characters");
}

const app = express();
app.use(helmet());
app.use(cors({ origin: clientOrigins }));
app.use(express.json({ limit: "1mb" }));

const authenticate = requireAuth(JWT_SECRET);

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/auth", authRoutes(JWT_SECRET));
app.use("/api/rooms", roomRoutes(authenticate));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: clientOrigins },
  pingInterval: 30000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1024 * 1024,
});

let clockClient;
if (process.env.REDIS_URL) {
  const pubClient = new Redis(process.env.REDIS_URL);
  const subClient = pubClient.duplicate();
  pubClient.on("error", (error) => console.error("Redis publisher error", error));
  subClient.on("error", (error) => console.error("Redis subscriber error", error));
  io.adapter(createAdapter(pubClient, subClient));
  clockClient = pubClient;
  console.log("Socket.IO Redis adapter enabled");
}

const roomClocks = new Map();
const roomClockKey = (roomId) => `boardcollab:room-clock:${roomId}`;

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    socket.user = jwt.verify(token, JWT_SECRET);
    socket.data.user = socket.user;
    return next();
  } catch {
    return next(new Error("Invalid or expired token"));
  }
});

const pendingOperations = [];
const volatileOperations = new Map();
let flushTimer;
let flushInProgress = Promise.resolve();

async function flushOperations() {
  if (pendingOperations.length === 0) return;
  const batch = pendingOperations.splice(0, MAX_BATCH);
  flushInProgress = flushInProgress
    .catch(() => {})
    .then(async () => {
      await persistBatch(batch);
      if (clockClient) {
        const byRoom = new Map();
        for (const { roomId, operation } of batch) {
          if (!byRoom.has(roomId)) byRoom.set(roomId, []);
          byRoom.get(roomId).push(`${operation.actorId}:${operation.opId}`);
        }
        for (const [roomId, fields] of byRoom) {
          await clockClient.hdel(`boardcollab:pending:${roomId}`, ...fields);
        }
      }
      for (const { roomId, operation } of batch) {
        volatileOperations.delete(`${roomId}:${operation.opId}`);
      }
    })
    .catch((error) => {
      console.error("MongoDB operation batch failed; retrying", error);
      pendingOperations.unshift(...batch);
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flushOperations();
        }, 5000);
        flushTimer.unref?.();
      }
      throw error;
    });
  try {
    await flushInProgress;
  } catch {
    return;
  }
  if (pendingOperations.length > 0) void flushOperations();
}

function queueOperation(roomId, operation) {
  pendingOperations.push({ roomId, operation });
  volatileOperations.set(`${roomId}:${operation.opId}`, { roomId, operation });
  if (pendingOperations.length >= MAX_BATCH) {
    void flushOperations();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushOperations();
    }, 5000);
    flushTimer.unref?.();
  }
}

function validOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.opId !== "string" || value.opId.length > 100) return false;
  if (typeof value.elementId !== "string" || value.elementId.length > 100) return false;
  if (!ALLOWED_TYPES.has(value.type)) return false;
  if (!Number.isSafeInteger(value.clock) || value.clock < 0) return false;
  if (typeof value.deleted !== "boolean") return false;
  try {
    return Buffer.byteLength(JSON.stringify(value.data ?? {})) <= MAX_ELEMENT_BYTES;
  } catch {
    return false;
  }
}

const privateCodeHash = (code) => createHash("sha256").update(code).digest("hex");

io.on("connection", (socket) => {
  socket.on("join-room", async ({ roomId, inviteCode } = {}, acknowledge = () => {}) => {
    try {
      if (typeof roomId !== "string" || roomId.length > 100) {
        return acknowledge({ error: "Invalid room ID" });
      }
      const room = await Session.findOne({ roomId }).select("+inviteCodeHash");
      if (!room) return acknowledge({ error: "Room not found" });
      if (room.isPrivate && (!inviteCode || privateCodeHash(inviteCode) !== room.inviteCodeHash)) {
        return acknowledge({ error: "A valid room invite is required" });
      }

      await socket.join(roomId);
      socket.data.roomId = roomId;
      const [elements, sockets] = await Promise.all([
        Element.find({ roomId }).lean(),
        io.in(roomId).fetchSockets(),
      ]);
      const [distributedPending, localPending] = await Promise.all([
        clockClient ? clockClient.hvals(`boardcollab:pending:${roomId}`) : [],
        Promise.resolve([...volatileOperations.values()]
          .filter((entry) => entry.roomId === roomId)
          .map((entry) => entry.operation)),
      ]);
      const currentElements = new Map(elements.map((element) => [element.elementId, element]));
      const operations = [
        ...distributedPending.map((value) => JSON.parse(value)),
        ...localPending,
      ];
      for (const operation of distributedPending.map((value) => JSON.parse(value))) {
        if (!volatileOperations.has(`${roomId}:${operation.opId}`)) {
          queueOperation(roomId, operation);
        }
      }
      for (const operation of operations) {
        const current = currentElements.get(operation.elementId);
        if (!current || compareVersions(operation, current) > 0) {
          currentElements.set(operation.elementId, { roomId, ...operation });
        }
      }
      const currentState = [...currentElements.values()];
      const highestClock = currentState.reduce((highest, element) => Math.max(highest, element.clock ?? 0), 0);
      if (clockClient) {
        await clockClient.eval(
          "local current=redis.call('GET',KEYS[1]); if (not current) or tonumber(current)<tonumber(ARGV[1]) then redis.call('SET',KEYS[1],ARGV[1]); end; return redis.call('GET',KEYS[1])",
          1,
          roomClockKey(roomId),
          highestClock
        );
      } else {
        roomClocks.set(roomId, Math.max(roomClocks.get(roomId) ?? 0, highestClock));
      }
      const users = sockets.map((participant) => ({
        id: String(participant.data.user.sub),
        name: String(participant.data.user.name ?? "Collaborator"),
      })).filter((user, index, all) => all.findIndex((item) => item.id === user.id) === index);
      acknowledge({ room: { roomId, name: room.name }, elements: currentState, users });
      socket.to(roomId).emit("user-joined", {
        id: String(socket.user.sub),
        name: String(socket.user.name ?? "Collaborator"),
      });
    } catch (error) {
      console.error("Failed to join room", error);
      acknowledge({ error: "Unable to join room" });
    }
  });

  socket.on("draw-preview", (preview) => {
    const { roomId } = socket.data;
    if (!roomId || !preview || !Array.isArray(preview.points) || preview.points.length > 4096) return;
    socket.to(roomId).volatile.emit("draw-preview", {
      id: String(socket.user.sub),
      elementId: String(preview.elementId ?? "").slice(0, 100),
      type: ALLOWED_TYPES.has(preview.type) ? preview.type : "stroke",
      data: preview.data,
      points: preview.points,
      color: String(preview.color ?? "#222222").slice(0, 32),
      strokeWidth: Math.min(64, Math.max(1, Number(preview.strokeWidth) || 3)),
    });
  });

  socket.on("draw-operations", async (operations, acknowledge = () => {}) => {
    const { roomId } = socket.data;
    if (!roomId) return acknowledge({ error: "Join a room before editing" });
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_BATCH) {
      return acknowledge({ error: `Send between 1 and ${MAX_BATCH} operations` });
    }
    for (const candidate of operations) {
      if (!validOperation(candidate)) return acknowledge({ error: "Invalid drawing operation" });
    }

    const accepted = [];
    for (const candidate of operations) {
      let clock;
      try {
        if (clockClient) {
          clock = await clockClient.incr(roomClockKey(roomId));
        } else {
          clock = (roomClocks.get(roomId) ?? 0) + 1;
          roomClocks.set(roomId, clock);
        }
      } catch (error) {
        console.error("Unable to assign an operation version", error);
        return acknowledge({ error: "Unable to save this edit; retry after reconnecting" });
      }
      const operation = {
        opId: candidate.opId,
        elementId: candidate.elementId,
        type: candidate.type,
        data: candidate.data ?? {},
        deleted: candidate.deleted,
        clock,
        actorId: String(socket.user.sub),
      };
      accepted.push(operation);
      if (clockClient) {
        try {
          await clockClient.hset(
            `boardcollab:pending:${roomId}`,
            `${operation.actorId}:${operation.opId}`,
            JSON.stringify(operation)
          );
        } catch (error) {
          console.error("Unable to stage a collaborative edit", error);
          return acknowledge({ error: "Unable to save this edit; retry after reconnecting", accepted: accepted.length - 1 });
        }
      }
      queueOperation(roomId, operation);
      io.to(roomId).emit("draw-operation", operation);
      socket.emit("operation-ack", { opId: operation.opId });
    }
    acknowledge({ accepted: accepted.length });
  });

  socket.on("disconnect", () => {
    const { roomId } = socket.data;
    if (!roomId) return;
    void io.in(roomId).fetchSockets().then((remaining) => {
      if (!remaining.some((participant) => String(participant.data.user.sub) === String(socket.user.sub))) {
        socket.to(roomId).emit("user-left", { id: String(socket.user.sub) });
      }
    }).catch((error) => console.error("Unable to refresh room presence", error));
  });
});

await connectDatabase(process.env.MONGO_URI);
server.listen(PORT, () => console.log(`BoardCollab API listening on http://localhost:${PORT}`));

async function shutdown() {
  if (flushTimer) clearTimeout(flushTimer);
  await flushOperations();
  io.close();
  server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
