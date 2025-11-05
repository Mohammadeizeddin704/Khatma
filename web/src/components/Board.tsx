import React from "react";
import io, { type Socket } from "socket.io-client";
import { authed, API_BASE } from "../lib/api";

type Part = {
  number: number;
  claimed_by: string | null;
  claimed_name?: string | null;
  claimed_is_admin?: boolean | null;
};
type Profile = { name: string; phone: string };

interface BoardProps {
  weekKey: string;
  userId: string;
  profile?: Profile;
  isAdmin: boolean;
}

export default function Board({ weekKey, userId, profile, isAdmin }: BoardProps) {
  const [weekId, setWeekId] = React.useState<string>("");
  const [parts, setParts] = React.useState<Part[]>([]);
  const [loading, setLoading] = React.useState(true);
  const socketRef = React.useRef<Socket | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/weeks/${weekKey}`);
        if (!resp.ok) throw new Error("failed to load week");
        const data = await resp.json();
        if (cancelled) return;
        setWeekId(data.weekId);
        setParts(data.parts);

        const socket = io(API_BASE, { transports: ["websocket"] });
        socketRef.current = socket;
        socket.emit("join-week", data.weekId);

        socket.on("part:update", (part: Part) => {
          setParts((prev) =>
            prev.map((existing) => (existing.number === part.number ? { ...existing, ...part } : existing)),
          );
        });

        socket.on("week:reset", (payload: { weekId: string; parts: Part[] }) => {
          if (payload.weekId === data.weekId) {
            setParts(payload.parts);
          }
        });
      } catch (error) {
        console.error(error);
        alert("تعذر تحميل بيانات الأسبوع الحالي.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [weekKey]);

  const reservedCount = React.useMemo(
    () => parts.reduce((acc, part) => (part.claimed_by ? acc + 1 : acc), 0),
    [parts],
  );

  const handleContextMenu = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>, part: Part) => {
      if (!isAdmin || !weekId || !part.claimed_by) return;
      event.preventDefault();

      const targetName = part.claimed_name?.trim() || "المشارك";
      const makeAdmin = !part.claimed_is_admin;
      const question = makeAdmin
        ? `منح صلاحية المشرف للمشارك ${targetName}؟`
        : `إزالة صلاحية المشرف من ${targetName}؟`;

      if (!window.confirm(question)) return;

      try {
        const resp = await authed(`/api/users/${part.claimed_by}/admin`, {
          method: "PATCH",
          body: JSON.stringify({
            makeAdmin,
            weekId,
            partNumber: part.number,
          }),
        });
        if (!resp.ok) throw new Error(`admin toggle failed (${resp.status})`);

        setParts((prev) =>
          prev.map((p) =>
            p.number === part.number ? { ...p, claimed_is_admin: makeAdmin } : p,
          ),
        );
      } catch (error) {
        console.error(error);
        alert("تعذر تحديث صلاحيات المشرف.");
      }
    },
    [isAdmin, weekId],
  );

  async function toggle(number: number, part: Part) {
    if (!weekId) return;
    if (!userId) {
      alert("يرجى تسجيل الدخول أولاً.");
      return;
    }

    const payload = profile ? { profile } : {};
    if (!part.claimed_by) {
      try {
        const resp = await authed(`/api/weeks/${weekId}/parts/${number}/claim`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!resp.ok) alert("هذا الجزء محجوز حالياً.");
      } catch (error) {
        console.error(error);
        alert("تعذر حجز الجزء. حاول مرة أخرى.");
      }
      return;
    }

    try {
      const resp = await authed(`/api/weeks/${weekId}/parts/${number}/release`, {
        method: "POST",
      });
      if (!resp.ok) alert("لا يمكنك إلغاء حجز جزء لا تملكه.");
    } catch (error) {
      console.error(error);
      alert("تعذر إلغاء الحجز الآن.");
    }
  }

  return (
    <main className="px-4 py-10 flex justify-center">
      <section className="khatma-card">
        <div className="khatma-card__top">
          <div className="khatma-card__subtitle">تم الحجز: {reservedCount}/30</div>
          <h2 className="khatma-card__title">أسبوع: {weekKey}</h2>
        </div>

        {loading ? (
          <div className="khatma-loading">جارٍ التحميل...</div>
        ) : (
          <>
            <div dir="ltr" className="khatma-board">
              {parts.map((part) => {
                const isMine = Boolean(part.claimed_by) && part.claimed_by === userId;
                const isTaken = Boolean(part.claimed_by);
                const className = [
                  "khatma-btn",
                  isMine ? "mine" : "",
                  !isMine && isTaken ? "claimed" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const fallbackName = isMine ? (profile?.name || "أنت") : "مشارك";
                const baseName = isTaken ? (part.claimed_name?.trim() || fallbackName) : "";
                const displayName = part.claimed_is_admin ? `${baseName} ★` : baseName;
                const nameClass = [
                  "khatma-name",
                  isMine ? " mine" : "",
                  part.claimed_is_admin ? " admin" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <div key={part.number} className="khatma-cell">
                    <button
                      className={className}
                      onClick={() => toggle(part.number, part)}
                      onContextMenu={(event) => handleContextMenu(event, part)}
                      title={
                        !isTaken
                          ? "متاح"
                          : isMine
                            ? "محجوز لك"
                            : part.claimed_name
                              ? `محجوز بواسطة ${part.claimed_name}`
                              : "محجوز"
                      }
                      disabled={!isMine && isTaken}
                    >
                      {part.number}
                    </button>
                    {isTaken ? (
                      <span className={nameClass} title={displayName}>
                        {displayName}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="khatma-list" dir="rtl">
              <h3 className="khatma-list__title">قائمة المشاركين حسب الأجزاء</h3>
              <div className="khatma-list__rows">
                {parts.map((part) => {
                  const isMine = Boolean(part.claimed_by) && part.claimed_by === userId;
                  const isTaken = Boolean(part.claimed_by);
                  const baseName = part.claimed_name?.trim() || "";
                  const fallbackName = isMine && isTaken ? profile?.name || "أنت" : "متاح";
                  const displayName = baseName || fallbackName;
                  const finalName =
                    isTaken && part.claimed_is_admin ? `${displayName} ★` : displayName;
                  const classNames = [
                    "khatma-list__name",
                    !isTaken ? "empty" : "",
                    isTaken && isMine ? "mine" : "",
                    isTaken && part.claimed_is_admin ? "admin" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <div key={`row-${part.number}`} className="khatma-list__row">
                      <span className="khatma-list__number" dir="ltr">
                        {part.number.toString().padStart(2, "0")}
                      </span>
                      <span className={classNames} title={finalName}>
                        {finalName}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <div className="khatma-legend">
          <span>
            <span className="khatma-dot red"></span>متاح
          </span>
          <span>
            <span className="khatma-dot green"></span>محجوز لك
          </span>
          <span>
            <span className="khatma-dot gray"></span>محجوز للآخرين
          </span>
        </div>
      </section>
    </main>
  );
}
