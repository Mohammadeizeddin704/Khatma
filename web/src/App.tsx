import React from "react";
import Header from "./components/Header";
import Board from "./components/Board";
import Login, { type LoginResult } from "./components/Login";
import { authed, getSessionToken, setSessionToken, clearSession } from "./lib/api";

const WEEK_KEY = "W44-2025";

type StoredProfile = { name: string; phone: string };
type AccountState = { userId: string; name: string | null; phone: string | null; isAdmin: boolean };

function readProfile(): StoredProfile | null {
  try {
    const raw = localStorage.getItem("khatma_profile");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.name === "string" && typeof parsed?.phone === "string") {
      return { name: parsed.name, phone: parsed.phone };
    }
    return null;
  } catch {
    return null;
  }
}

export default function App() {
  const [token, setToken] = React.useState<string | null>(() => getSessionToken());
  const [profile, setProfile] = React.useState<StoredProfile | null>(() => readProfile());
  const [account, setAccount] = React.useState<AccountState | null>(null);
  const [initializing, setInitializing] = React.useState(true);
  const [syncingProfile, setSyncingProfile] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const doLogout = React.useCallback(() => {
    clearSession();
    setToken(null);
    setAccount(null);
    setProfile(null);
    setError(null);
  }, []);

  React.useEffect(() => {
    if (!token) {
      setAccount(null);
      setInitializing(false);
      return;
    }

    const stored = readProfile();
    setProfile(stored);
    setSyncingProfile(true);
    setError(null);

    (async () => {
      try {
        const resp = await authed("/api/profile", {
          method: "POST",
          body: JSON.stringify(stored || {}),
        });
        if (!resp.ok) {
          if (resp.status === 401) {
            doLogout();
            return;
          }
          throw new Error(`profile sync failed (${resp.status})`);
        }
        const data = await resp.json();
        if (data.token && data.token !== token) {
          setSessionToken(data.token);
          setToken(data.token);
        }
        const nextAccount: AccountState = {
          userId: data.userId,
          name: data.name ?? null,
          phone: data.phone ?? null,
          isAdmin: Boolean(data.isAdmin),
        };
        setAccount(nextAccount);
        localStorage.setItem("khatma_myDbUserId", nextAccount.userId);
        localStorage.setItem("khatma_isAdmin", nextAccount.isAdmin ? "1" : "0");
      } catch (err) {
        console.error(err);
        setAccount(null);
        setError("تعذر مزامنة الملف الشخصي");
      } finally {
        setSyncingProfile(false);
        setInitializing(false);
      }
    })();
  }, [token, doLogout]);

  const handleLoginSuccess = React.useCallback((result: LoginResult) => {
    setSessionToken(result.token);
    setToken(result.token);
    setAccount({
      userId: result.user.id,
      name: result.user.name ?? result.profile.name,
      phone: result.user.phone ?? result.profile.phone,
      isAdmin: result.user.isAdmin,
    });
    setProfile(result.profile);
    setInitializing(false);
    localStorage.setItem("khatma_myDbUserId", result.user.id);
    localStorage.setItem("khatma_isAdmin", result.user.isAdmin ? "1" : "0");
  }, []);

  const handleReset = React.useCallback(async () => {
    if (!account?.isAdmin) return;
    if (!window.confirm("هل تريد إعادة تعيين أجزاء هذا الأسبوع؟")) return;
    try {
      setResetting(true);
      const body = { profile };
      const resp = await authed(`/api/weeks/${WEEK_KEY}/reset`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        throw new Error(`reset failed (${resp.status})`);
      }
    } catch (err) {
      console.error(err);
      alert("تعذر إعادة التعيين الآن. حاول مرة أخرى.");
    } finally {
      setResetting(false);
    }
  }, [account?.isAdmin, profile]);

  if (initializing) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-600">
        جارٍ التحميل...
      </div>
    );
  }

  if (!token) {
    return <Login onSuccess={handleLoginSuccess} />;
  }

  const displayName = account?.name || profile?.name;
  const displayPhone = account?.phone || profile?.phone;
  const userLabel = displayName ? `${displayName}${displayPhone ? ` — ${displayPhone}` : ""}` : "مستخدم مجهول";

  return (
    <div className="min-h-screen">
      <Header
        userLabel={userLabel}
        syncing={syncingProfile}
        isAdmin={Boolean(account?.isAdmin)}
        resetting={resetting}
        onReset={handleReset}
        onLogout={doLogout}
      />

      {error ? (
        <div className="px-4 mt-6 text-center text-sm text-red-500">{error}</div>
      ) : null}

      <Board
        weekKey={WEEK_KEY}
        userId={account?.userId || ""}
        profile={profile || undefined}
        isAdmin={Boolean(account?.isAdmin)}
      />
    </div>
  );
}
