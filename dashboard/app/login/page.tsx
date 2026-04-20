"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success">("error");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function checkSession() {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(`/api/v1/auth/session`, {
          cache: "no-store",
          credentials: "include",
          signal: ctrl.signal
        });
        clearTimeout(tid);
        const body = (await res.json().catch(() => ({}))) as { authenticated?: boolean };
        if (!cancelled && res.ok && body.authenticated === true) {
          router.replace("/trading?account_sync=1");
        }
      } catch { }
    }
    const reason = params.get("reason");
    if (reason === "session_expired") {
      setMessage("세션이 만료되었습니다. 다시 로그인해 주세요.");
      setMessageTone("error");
    }
    if (reason === "logged_out") {
      setMessage("로그아웃되었습니다.");
      setMessageTone("success");
    }
    void checkSession();
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const idTrim = id.trim();
    if (!idTrim || !password) {
      setBusy(false);
      setMessageTone("error");
      setMessage("아이디와 비밀번호를 모두 입력해 주세요.");
      return;
    }
    try {
      const res = await fetch(`/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: idTrim, password }),
      });
      const body = await res.json();
      if (!res.ok || body?.authenticated !== true) {
        setMessageTone("error");
        setMessage(body?.message || "아이디 또는 비밀번호가 올바르지 않습니다");
        return;
      }
      setMessageTone("success");
      setMessage("인증 성공. 대시보드로 이동합니다.");
      router.replace("/trading?account_sync=1");
    } catch {
      setMessage("로그인 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "radial-gradient(1200px 700px at 20% -10%, #1d4ed833 0%, #070d1b 48%, #02050d 100%)",
        color: "#d6e7ff",
        padding: "1rem",
      }}
    >
      <section
        style={{
          width: "min(920px, 100%)",
          borderRadius: 16,
          border: "1px solid #2b4d7a",
          background: "linear-gradient(180deg, #0b1428 0%, #081125 100%)",
          boxShadow: "0 0 0 1px #1d3558 inset, 0 24px 60px rgba(2, 6, 23, 0.55)",
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "1.4rem", borderRight: "1px solid #1f3c63" }}>
          <div style={{ fontSize: "1.35rem", fontWeight: 900, color: "#f1f7ff", letterSpacing: "0.02em" }}>Orbitalpha Trading Access</div>
          <div style={{ marginTop: 6, fontSize: "0.88rem", color: "#8ea9d1", fontWeight: 600 }}>Authorized Control Login</div>
          <div style={{ marginTop: 16, color: "#d6e7ff", fontSize: "0.88rem", lineHeight: 1.6 }}>
            로그인 후 실거래 대시보드 접근이 허용됩니다.
            <br />
            자동매매는 로그인만으로 켜지지 않으며, 대시보드에서 직접 활성화해야 합니다.
          </div>
        </div>
        <form onSubmit={onLogin} style={{ padding: "1.4rem", display: "grid", gap: 10, alignContent: "center", background: "linear-gradient(180deg, #10203d 0%, #0b1a33 100%)" }}>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="아이디"
            autoComplete="username"
            style={{ background: "#0f2240", border: "1px solid #1f3c63", borderRadius: 8, color: "#d6e7ff", padding: "0.58rem 0.68rem" }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호"
            autoComplete="current-password"
            style={{ background: "#0f2240", border: "1px solid #1f3c63", borderRadius: 8, color: "#d6e7ff", padding: "0.58rem 0.68rem" }}
          />
          <button
            type="submit"
            disabled={busy}
            style={{
              marginTop: 4,
              borderRadius: 8,
              border: "1px solid #0ea5e9",
              background: "linear-gradient(180deg, #0b355f 0%, #0b2748 100%)",
              color: "#dbeafe",
              fontWeight: 800,
              padding: "0.58rem 0.72rem",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "로그인 중..." : "로그인"}
          </button>
          {message ? (
            <p style={{ margin: "0.2rem 0 0", color: messageTone === "success" ? "#2dd4bf" : "#f87171", fontSize: 13, fontWeight: 700 }}>
              {message}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
