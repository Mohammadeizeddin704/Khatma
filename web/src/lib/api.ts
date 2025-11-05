const TOKEN_KEY = "khatma_token";
const rawBase =
  (typeof import.meta.env.VITE_API_URL === "string" && import.meta.env.VITE_API_URL.trim()) ||
  (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8080` : "http://localhost:8080");
export const API_BASE = rawBase.replace(/\/$/, "");

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null) {
  try {
    if (!token) {
      localStorage.removeItem(TOKEN_KEY);
    } else {
      localStorage.setItem(TOKEN_KEY, token);
    }
  } catch {
    /* ignore */
  }
}

export async function authed(path: string, init?: RequestInit) {
  const token = getSessionToken();
  const headers = {
    "Content-Type": "application/json",
    ...(init?.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  } as Record<string, string>;
  return fetch(`${API_BASE}${path}`, {
    ...(init || {}),
    headers,
  });
}

export function clearSession() {
  setSessionToken(null);
  try {
    localStorage.removeItem("khatma_myDbUserId");
    localStorage.removeItem("khatma_isAdmin");
  } catch {
    /* ignore */
  }
}
