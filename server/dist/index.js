import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { pool } from "./db.js";
import { verify } from "./auth.js";
const PORT = Number(process.env.PORT || 8080);
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.WEB_ORIGIN || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
const app = express();
app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
}));
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins.length ? allowedOrigins : "*",
    },
});
io.on("connection", (socket) => {
    socket.on("join-week", (weekId) => {
        if (weekId)
            socket.join(weekId);
    });
});
async function ensureUser(firebaseUid, profile) {
    const adminUids = (process.env.ADMIN_UIDS || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const wantsAdmin = adminUids.includes(firebaseUid);
    const name = profile?.name?.trim() || null;
    const phone = profile?.phone?.trim() || null;
    const query = `
    insert into users (firebase_uid, name, phone, is_admin)
    values ($1, $2, $3, $4)
    on conflict (firebase_uid)
    do update set
      name = coalesce(excluded.name, users.name),
      phone = coalesce(excluded.phone, users.phone),
      is_admin = users.is_admin or excluded.is_admin
    returning id, name, phone, is_admin
  `;
    const { rows } = await pool.query(query, [firebaseUid, name, phone, wantsAdmin]);
    return rows[0];
}
async function ensureWeek(client, weekKey) {
    const existing = await client.query("select id from weeks where week_key=$1", [weekKey]);
    if (existing.rowCount)
        return existing.rows[0].id;
    const inserted = await client.query("insert into weeks (week_key) values ($1) returning id", [weekKey]);
    const weekId = inserted.rows[0].id;
    await client.query("insert into parts (week_id, number) select $1, n from generate_series(1,30) as n", [weekId]);
    return weekId;
}
async function getWeek(client, weekKey) {
    const week = await client.query("select id, week_key from weeks where week_key=$1", [weekKey]);
    if (week.rowCount)
        return { id: week.rows[0].id, key: week.rows[0].week_key };
    const id = await ensureWeek(client, weekKey);
    return { id, key: weekKey };
}
async function fetchParts(weekId) {
    const { rows } = await pool.query("select number, claimed_by, claimed_name from parts where week_id=$1 order by number asc", [weekId]);
    return rows;
}
function broadcastPartUpdate(weekId, payload) {
    io.to(weekId).emit("part:update", payload);
}
app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
});
app.post("/api/profile", verify, async (req, res) => {
    try {
        const authed = req;
        const { name, phone } = (req.body || {});
        const user = await ensureUser(authed.user.uid, { name, phone });
        res.json({
            userId: user.id,
            name: user.name,
            phone: user.phone,
            isAdmin: user.is_admin,
        });
    }
    catch (error) {
        console.error("profile error", error);
        res.status(500).json({ error: "PROFILE_FAILED" });
    }
});
app.get("/api/weeks/:weekKey", async (req, res) => {
    const { weekKey } = req.params;
    if (!weekKey)
        return res.status(400).json({ error: "WEEK_REQUIRED" });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const week = await getWeek(client, weekKey);
        await client.query("COMMIT");
        const parts = await fetchParts(week.id);
        res.json({ weekId: week.id, weekKey: week.key, parts });
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("week fetch error", error);
        res.status(500).json({ error: "WEEK_FETCH_FAILED" });
    }
    finally {
        client.release();
    }
});
app.post("/api/weeks/:weekId/parts/:number/claim", verify, async (req, res) => {
    const { weekId, number } = req.params;
    const n = Number(number);
    if (!weekId || Number.isNaN(n))
        return res.status(400).json({ error: "BAD_REQUEST" });
    const profile = (req.body?.profile || {});
    const client = await pool.connect();
    try {
        const authed = req;
        const user = await ensureUser(authed.user.uid, profile);
        await client.query("BEGIN");
        const existing = await client.query("select number, claimed_by, claimed_name from parts where week_id=$1 and number=$2 for update", [weekId, n]);
        if (!existing.rowCount) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "PART_NOT_FOUND" });
        }
        if (existing.rows[0].claimed_by) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "ALREADY_CLAIMED" });
        }
        const claimedName = profile.name?.trim() || user.name || null;
        await client.query("update parts set claimed_by=$3, claimed_name=$4, claimed_at=now() where week_id=$1 and number=$2", [weekId, n, user.id, claimedName]);
        await client.query("COMMIT");
        const payload = { number: n, claimed_by: user.id, claimed_name: claimedName };
        broadcastPartUpdate(weekId, payload);
        res.json(payload);
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("claim error", error);
        res.status(500).json({ error: "CLAIM_FAILED" });
    }
    finally {
        client.release();
    }
});
app.post("/api/weeks/:weekId/parts/:number/release", verify, async (req, res) => {
    const { weekId, number } = req.params;
    const n = Number(number);
    if (!weekId || Number.isNaN(n))
        return res.status(400).json({ error: "BAD_REQUEST" });
    const client = await pool.connect();
    try {
        const authed = req;
        const user = await ensureUser(authed.user.uid);
        await client.query("BEGIN");
        const existing = await client.query("select number, claimed_by, claimed_name from parts where week_id=$1 and number=$2 for update", [weekId, n]);
        if (!existing.rowCount) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "PART_NOT_FOUND" });
        }
        if (!existing.rows[0].claimed_by || existing.rows[0].claimed_by !== user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: "NOT_OWNER" });
        }
        await client.query("update parts set claimed_by=null, claimed_name=null, claimed_at=null where week_id=$1 and number=$2", [weekId, n]);
        await client.query("COMMIT");
        const payload = { number: n, claimed_by: null, claimed_name: null };
        broadcastPartUpdate(weekId, payload);
        res.json(payload);
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("release error", error);
        res.status(500).json({ error: "RELEASE_FAILED" });
    }
    finally {
        client.release();
    }
});
app.post("/api/weeks/:weekKey/reset", verify, async (req, res) => {
    const { weekKey } = req.params;
    if (!weekKey)
        return res.status(400).json({ error: "WEEK_REQUIRED" });
    const profile = (req.body?.profile || {});
    const client = await pool.connect();
    try {
        const authed = req;
        const user = await ensureUser(authed.user.uid, profile);
        await client.query("BEGIN");
        if (!user.is_admin) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: "NOT_ADMIN" });
        }
        const week = await getWeek(client, weekKey);
        await client.query("update parts set claimed_by=null, claimed_name=null, claimed_at=null where week_id=$1", [week.id]);
        await client.query("COMMIT");
        const freshParts = await fetchParts(week.id);
        io.to(week.id).emit("week:reset", { weekId: week.id, parts: freshParts });
        res.json({ weekId: week.id, parts: freshParts });
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("reset error", error);
        res.status(500).json({ error: "RESET_FAILED" });
    }
    finally {
        client.release();
    }
});
httpServer.listen(PORT, () => {
    console.log(`api listening on ${PORT}`);
});
