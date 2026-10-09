import jwt from "jsonwebtoken";

export function createToken(user, secret) {
  return jwt.sign({ sub: String(user._id), name: user.name }, secret, { expiresIn: "7d" });
}

export function requireAuth(secret) {
  return (req, res, next) => {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Authentication required" });
    try {
      req.user = jwt.verify(token, secret);
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}
