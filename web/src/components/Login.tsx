import React from "react";
import { API_BASE } from "../lib/api";

const PHONE_PREFIX = "+963";
const phoneRegex = /^\+\d{6,15}$/;

export interface LoginResult {
  token: string;
  user: {
    id: string;
    name: string | null;
    phone: string | null;
    isAdmin: boolean;
  };
  profile: { name: string; phone: string };
}

interface LoginProps {
  onSuccess: (result: LoginResult) => void;
}

export default function Login({ onSuccess }: LoginProps) {
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState(PHONE_PREFIX);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem("khatma_profile");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.name) setName(parsed.name);
        if (parsed?.phone) setPhone(parsed.phone);
      }
    } catch {
      /* ignore */
    }
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const normalizedPhone = phone.trim().startsWith("+")
      ? phone.trim()
      : `+${phone.trim().replace(/^\+/, "")}`;

    if (!trimmedName) {
      setError("يرجى إدخال الاسم الكامل.");
      return;
    }
    if (!phoneRegex.test(normalizedPhone)) {
      setError("يرجى إدخال رقم جوال بصيغة دولية صحيحة (مثال: ‎+963123456789).");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, phone: normalizedPhone }),
      });
      if (!response.ok) {
        throw new Error(`login failed (${response.status})`);
      }
      const data = await response.json();
      if (!data?.token || !data?.user?.id) {
        throw new Error("missing token");
      }

      const profile = { name: trimmedName, phone: normalizedPhone };
      localStorage.setItem("khatma_profile", JSON.stringify(profile));
      if (data.user?.isAdmin) {
        localStorage.setItem("khatma_isAdmin", "1");
      } else {
        localStorage.removeItem("khatma_isAdmin");
      }
      localStorage.setItem("khatma_myDbUserId", data.user.id);

      onSuccess({ token: data.token, user: data.user, profile });
    } catch (err) {
      console.error(err);
      setError("حدث خطأ أثناء تسجيل الدخول. يرجى المحاولة مجدداً.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-panel">
        <header className="login-header">
          <div className="login-icon">خ</div>
          <div className="login-copy">
            <h2>أهلاً بك في ختمة ملتقى المحبين</h2>
            <p>شارك في ختمة أسبوعية، واحجز الجزء الذي تريد قراءته مع المجموعة.</p>
          </div>
        </header>

        <form className="login-form" onSubmit={submit}>
          <label className="login-label">الاسم الكامل</label>
          <input
            className="login-input"
            value={name}
            placeholder="ادخل اسمك الكامل"
            onChange={(event) => setName(event.target.value)}
            disabled={loading}
            autoComplete="name"
          />

          <label className="login-label">رقم الجوال (بصيغة دولية)</label>
          <div className="login-input-group">
            <span className="login-prefix">+</span>
            <input
              dir="ltr"
              className="login-input"
              value={phone.startsWith("+") ? phone.slice(1) : phone}
              placeholder="963523783612"
              onChange={(event) => {
                const digits = event.target.value.replace(/[^\d]/g, "");
                setPhone(digits ? `+${digits}` : "+");
              }}
              disabled={loading}
              autoComplete="tel"
            />
          </div>

          {error ? <p className="login-error">{error}</p> : null}

          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? "جارٍ التحقق..." : "بدء المشاركة"}
          </button>

          <p className="login-hint">
            يتم حفظ مشاركتك تلقائياً، ويمكنك العودة في أي وقت لإكمال الختمة.
          </p>
        </form>
      </div>
    </div>
  );
}
