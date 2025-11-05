import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import type { PoolClient } from "pg";
import { randomUUID } from "crypto";
import { pool } from "./db.js";
import { verify, signSession, type AuthenticatedRequest } from "./auth.js";

const PORT = Number(process.env.PORT || 8080);
const DEFAULT_ADMIN_NAME = (process.env.DEFAULT_ADMIN_NAME || "محمد عز الدين").trim();
const DEFAULT_ADMIN_PHONE = normalizePhone(process.env.DEFAULT_ADMIN_PHONE || "");
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.WEB_ORIGIN || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const ADMIN_PHONE_LIST = (process.env.ADMIN_PHONES || "+971523783612")
  .split(",")
  .map((v) => normalizePhone(v))
  .filter(Boolean);

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, "");
  if (!cleaned.startsWith("+")) return `+${cleaned.replace(/^\+/, "")}`;
  return cleaned;
}

const app = express();
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  }),
);
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : "*",
  },
});

io.on("connection", (socket) => {
  socket.on("join-week", (weekId: string) => {
    if (weekId) socket.join(weekId);
  });
});

type DbUserRow = {
  id: string;
  firebase_uid: string;
  name: string | null;
  phone: string | null;
  is_admin: boolean;
};

type PartRow = {
  number: number;
  claimed_by: string | null;
  claimed_name: string | null;
  claimed_is_admin: boolean | null;
};

function computeAdminFlag(name: string | null, phone: string | null, current = false): boolean {
  const matchName = !!DEFAULT_ADMIN_NAME && !!name && name === DEFAULT_ADMIN_NAME;
  const matchPhone = !!phone && ADMIN_PHONE_LIST.includes(phone);
  return current || matchName || matchPhone;
}

async function loginUser(nameInput: string, phoneInput: string): Promise<DbUserRow> {
  const name = nameInput.trim() || null;
  const phone = normalizePhone(phoneInput);
  if (!phone) {
    throw new Error("PHONE_REQUIRED");
  }

  const existing = await pool.query<DbUserRow>(
    "select id, firebase_uid, name, phone, is_admin from users where phone=$1",
    [phone],
  );

  if (existing.rowCount) {
    const current = existing.rows[0];
    const updatedAdmin = computeAdminFlag(name || current.name, phone, current.is_admin);
    const { rows } = await pool.query<DbUserRow>(
      `
      update users
      set
        name = $2,
        phone = $3,
        is_admin = $4
      where id=$1
      returning id, firebase_uid, name, phone, is_admin
      `,
      [current.id, name || current.name, phone, updatedAdmin],
    );
    return rows[0];
  }

  const authKey = randomUUID();
  const isAdmin = computeAdminFlag(name, phone);
  const { rows } = await pool.query<DbUserRow>(
    `
    insert into users (firebase_uid, name, phone, is_admin)
    values ($1, $2, $3, $4)
    returning id, firebase_uid, name, phone, is_admin
    `,
    [authKey, name, phone, isAdmin],
  );
  return rows[0];
}

async function getUserById(id: string): Promise<DbUserRow> {
  const { rows } = await pool.query<DbUserRow>(
    "select id, firebase_uid, name, phone, is_admin from users where id=$1",
    [id],
  );
  if (!rows.length) {
    throw new Error("USER_NOT_FOUND");
  }
  return rows[0];
}

async function updateUserProfile(userId: string, profile: { name?: string; phone?: string }): Promise<DbUserRow> {
  const existing = await getUserById(userId);
  const name = profile.name?.trim() || existing.name;
  const phone = normalizePhone(profile.phone || existing.phone);
  const isAdmin = computeAdminFlag(name, phone, existing.is_admin);
  const { rows } = await pool.query<DbUserRow>(
    `
    update users
    set name=$2, phone=$3, is_admin=$4
    where id=$1
    returning id, firebase_uid, name, phone, is_admin
    `,
    [userId, name, phone, isAdmin],
  );
  return rows[0];
}

async function ensureWeek(client: PoolClient, weekKey: string): Promise<string> {
  const existing = await client.query<{ id: string }>("select id from weeks where week_key=$1", [weekKey]);
  if (existing.rowCount) return existing.rows[0].id;

  const inserted = await client.query<{ id: string }>(
    "insert into weeks (week_key) values ($1) returning id",
    [weekKey],
  );
  const weekId = inserted.rows[0].id;
  await client.query("insert into parts (week_id, number) select $1, n from generate_series(1,30) as n", [weekId]);
  return weekId;
}

async function getWeek(client: PoolClient, weekKey: string): Promise<{ id: string; key: string }> {
  const week = await client.query<{ id: string; week_key: string }>(
    "select id, week_key from weeks where week_key=$1",
    [weekKey],
  );
  if (week.rowCount) return { id: week.rows[0].id, key: week.rows[0].week_key };
  const id = await ensureWeek(client, weekKey);
  return { id, key: weekKey };
}

async function fetchParts(weekId: string): Promise<PartRow[]> {
  const { rows } = await pool.query<PartRow>(
    `
    select
      p.number,
      p.claimed_by,
      p.claimed_name,
      u.is_admin as claimed_is_admin
    from parts p
    left join users u on u.id = p.claimed_by
    where p.week_id=$1
    order by p.number asc
    `,
    [weekId],
  );
  return rows;
}

function broadcastPartUpdate(weekId: string, payload: PartRow) {
  io.to(weekId).emit("part:update", payload);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  const { name, phone } = (req.body || {}) as { name?: string; phone?: string };
  if (!name || !phone) {
    return res.status(400).json({ error: "NAME_AND_PHONE_REQUIRED" });
  }

  try {
    const user = await loginUser(name, phone);
    const token = signSession({
      userId: user.id,
      name: user.name,
      phone: user.phone,
      isAdmin: user.is_admin,
    });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        isAdmin: user.is_admin,
      },
    });
  } catch (error) {
    console.error("auth login error", error);
    res.status(500).json({ error: "LOGIN_FAILED" });
  }
});

app.post("/api/profile", verify, async (req: Request, res: Response) => {
  try {
    const session = req as AuthenticatedRequest;
    const { name, phone } = (req.body || {}) as { name?: string; phone?: string };
    const user = await updateUserProfile(session.session.userId, { name, phone });
    const token = signSession({
      userId: user.id,
      name: user.name,
      phone: user.phone,
      isAdmin: user.is_admin,
    });
    res.json({
      token,
      userId: user.id,
      name: user.name,
      phone: user.phone,
      isAdmin: user.is_admin,
    });
  } catch (error) {
    console.error("profile error", error);
    res.status(500).json({ error: "PROFILE_FAILED" });
  }
});

app.get("/api/weeks/:weekKey", async (req, res) => {
  const { weekKey } = req.params;
  if (!weekKey) return res.status(400).json({ error: "WEEK_REQUIRED" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const week = await getWeek(client, weekKey);
    await client.query("COMMIT");

    const parts = await fetchParts(week.id);
    res.json({ weekId: week.id, weekKey: week.key, parts });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("week fetch error", error);
    res.status(500).json({ error: "WEEK_FETCH_FAILED" });
  } finally {
    client.release();
  }
});

app.post("/api/weeks/:weekId/parts/:number/claim", verify, async (req: Request, res: Response) => {
  const { weekId, number } = req.params;
  const n = Number(number);
  if (!weekId || Number.isNaN(n)) return res.status(400).json({ error: "BAD_REQUEST" });
  const profile = (req.body?.profile || {}) as { name?: string; phone?: string };

  const client = await pool.connect();
  try {
    const session = req as AuthenticatedRequest;
    let user = await getUserById(session.session.userId);
    if (profile.name || profile.phone) {
      user = await updateUserProfile(user.id, profile);
    }
    await client.query("BEGIN");
    const existing = await client.query<{ claimed_by: string | null }>(
      "select claimed_by from parts where week_id=$1 and number=$2 for update",
      [weekId, n],
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "PART_NOT_FOUND" });
    }
    if (existing.rows[0].claimed_by) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "ALREADY_CLAIMED" });
    }

    const claimedName = profile.name?.trim() || user.name || null;

    await client.query(
      "update parts set claimed_by=$3, claimed_name=$4, claimed_at=now() where week_id=$1 and number=$2",
      [weekId, n, user.id, claimedName],
    );
    await client.query("COMMIT");

    const payload: PartRow = {
      number: n,
      claimed_by: user.id,
      claimed_name: claimedName,
      claimed_is_admin: user.is_admin,
    };
    broadcastPartUpdate(weekId, payload);
    res.json(payload);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("claim error", error);
    res.status(500).json({ error: "CLAIM_FAILED" });
  } finally {
    client.release();
  }
});

app.post("/api/weeks/:weekId/parts/:number/release", verify, async (req: Request, res: Response) => {
  const { weekId, number } = req.params;
  const n = Number(number);
  if (!weekId || Number.isNaN(n)) return res.status(400).json({ error: "BAD_REQUEST" });

  const client = await pool.connect();
  try {
    const session = req as AuthenticatedRequest;
    const user = await getUserById(session.session.userId);
    await client.query("BEGIN");
    const existing = await client.query<{ claimed_by: string | null }>(
      "select claimed_by from parts where week_id=$1 and number=$2 for update",
      [weekId, n],
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "PART_NOT_FOUND" });
    }
    if (!existing.rows[0].claimed_by || existing.rows[0].claimed_by !== user.id) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "NOT_OWNER" });
    }

    await client.query(
      "update parts set claimed_by=null, claimed_name=null, claimed_at=null where week_id=$1 and number=$2",
      [weekId, n],
    );
    await client.query("COMMIT");

    const payload: PartRow = { number: n, claimed_by: null, claimed_name: null, claimed_is_admin: null };
    broadcastPartUpdate(weekId, payload);
    res.json(payload);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("release error", error);
    res.status(500).json({ error: "RELEASE_FAILED" });
  } finally {
    client.release();
  }
});

app.post("/api/weeks/:weekKey/reset", verify, async (req: Request, res: Response) => {
  const { weekKey } = req.params;
  if (!weekKey) return res.status(400).json({ error: "WEEK_REQUIRED" });

  const profile = (req.body?.profile || {}) as { name?: string; phone?: string };
  const client = await pool.connect();
  try {
    const session = req as AuthenticatedRequest;
    let user = await getUserById(session.session.userId);
    if (profile.name || profile.phone) {
      user = await updateUserProfile(user.id, profile);
    }
    await client.query("BEGIN");
    if (!user.is_admin) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "NOT_ADMIN" });
    }
    const week = await getWeek(client, weekKey);
    await client.query(
      "update parts set claimed_by=null, claimed_name=null, claimed_at=null where week_id=$1",
      [week.id],
    );
    await client.query("COMMIT");

    const freshParts = await fetchParts(week.id);
    io.to(week.id).emit("week:reset", { weekId: week.id, parts: freshParts });
    res.json({ weekId: week.id, parts: freshParts });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("reset error", error);
    res.status(500).json({ error: "RESET_FAILED" });
  } finally {
    client.release();
  }
});

app.patch("/api/users/:userId/admin", verify, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { makeAdmin, weekId, partNumber } = (req.body || {}) as {
    makeAdmin?: boolean;
    weekId?: string;
    partNumber?: number;
  };
  if (typeof makeAdmin !== "boolean") {
    return res.status(400).json({ error: "INVALID_BODY" });
  }

  try {
    const session = req as AuthenticatedRequest;
    const actor = await getUserById(session.session.userId);
    if (!actor.is_admin) {
      return res.status(403).json({ error: "NOT_ADMIN" });
    }

    const update = await pool.query<DbUserRow>(
      "update users set is_admin=$2 where id=$1 returning id, name, phone, is_admin",
      [userId, makeAdmin],
    );
    if (!update.rowCount) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    if (weekId && Number.isInteger(partNumber)) {
      const part = await pool.query<PartRow>(
        `
        select
          p.number,
          p.claimed_by,
          p.claimed_name,
          u.is_admin as claimed_is_admin
        from parts p
        left join users u on u.id = p.claimed_by
        where p.week_id=$1 and p.number=$2
        `,
        [weekId, partNumber],
      );
      if (part.rowCount) {
        broadcastPartUpdate(weekId, part.rows[0]);
      }
    }

    res.json({ userId, isAdmin: update.rows[0].is_admin });
  } catch (error) {
    console.error("admin toggle error", error);
    res.status(500).json({ error: "ADMIN_TOGGLE_FAILED" });
  }
});

httpServer.listen(PORT, () => {
  console.log(`api listening on ${PORT}`);
});
