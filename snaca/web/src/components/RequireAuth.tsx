import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { consumeTokenFromUrl, useAuthStore } from "../store/auth";

export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  useEffect(() => {
    consumeTokenFromUrl();
  }, []);
  const token = useAuthStore((s) => s.token);
  if (!token) {
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    );
  }
  return <>{children}</>;
}
