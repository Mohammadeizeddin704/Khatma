import jwt, { type Secret, type SignOptions } from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const AUTH_SECRET: Secret = process.env.AUTH_SECRET || "change-me";
const TOKEN_TTL: SignOptions["expiresIn"] = (process.env.AUTH_TOKEN_TTL || "30d") as SignOptions["expiresIn"];

export interface SessionPayload {
  userId: string;
  name: string | null;
  phone: string | null;
  isAdmin: boolean;
}

export interface AuthenticatedRequest extends Request {
  session: SessionPayload;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, AUTH_SECRET, { expiresIn: TOKEN_TTL });
}

export function verify(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).send("NO_TOKEN");
    const token = header.slice(7);
    const decoded = jwt.verify(token, AUTH_SECRET) as SessionPayload;
    (req as AuthenticatedRequest).session = decoded;
    next();
  } catch (error) {
    res.status(401).send("BAD_TOKEN");
  }
}
