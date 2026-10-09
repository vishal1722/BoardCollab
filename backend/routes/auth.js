import { Router } from "express";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { createToken } from "../utils/auth.js";

export default function authRoutes(secret) {
  const router = Router();

  router.post("/register", async (req, res, next) => {
    try {
      const { name, email, password } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 60) {
        return res.status(400).json({ error: "Name must be between 2 and 60 characters" });
      }
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      if (typeof password !== "string" || password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: "Password must be between 8 and 128 characters" });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await User.create({ name: name.trim(), email: email.toLowerCase(), passwordHash });
      return res.status(201).json({
        token: createToken(user, secret),
        user: { id: String(user._id), name: user.name, email: user.email },
      });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: "Email is already registered" });
      return next(error);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "Email and password are required" });
      }
      const user = await User.findOne({ email: email.toLowerCase() }).select("+passwordHash");
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      return res.json({
        token: createToken(user, secret),
        user: { id: String(user._id), name: user.name, email: user.email },
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
