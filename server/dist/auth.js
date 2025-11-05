// server/src/auth.ts
import admin from "firebase-admin";
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
        }),
    });
}
export async function verify(req, res, next) {
    try {
        const h = req.headers.authorization || "";
        if (!h.startsWith("Bearer "))
            return res.status(401).send("NO_TOKEN");
        const idToken = h.slice(7);
        const decoded = await admin.auth().verifyIdToken(idToken); // works for anonymous too
        // attach to req (cast to our auth type for runtime)
        req.user = decoded;
        next();
    }
    catch {
        res.status(401).send("BAD_TOKEN");
    }
}
