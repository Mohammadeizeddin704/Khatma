interface HeaderProps {
  userLabel: string;
  syncing: boolean;
  isAdmin: boolean;
  resetting: boolean;
  onReset: () => void;
  onLogout: () => void;
}

export default function Header({
  userLabel,
  syncing,
  isAdmin,
  resetting,
  onReset,
  onLogout,
}: HeaderProps) {
  return (
    <header className="kh-header">
      <div className="inner" dir="rtl">
        <div className="kh-brand">
          <div className="kh-logo">خ</div>
          <div className="kh-title">ختمة</div>
        </div>

        <div className="kh-userwrap">
          <div className="kh-userpill" title={userLabel}>
            <span className={`dot${syncing ? " syncing" : ""}`} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
              {userLabel}
            </span>
          </div>
          {isAdmin ? (
            <button className="kh-reset" disabled={resetting} onClick={onReset}>
              {resetting ? "جارٍ إعادة الضبط..." : "إعادة ضبط الأسبوع"}
            </button>
          ) : null}
          <button className="kh-logout" onClick={onLogout}>تسجيل الخروج</button>
        </div>
      </div>
    </header>
  );
}
