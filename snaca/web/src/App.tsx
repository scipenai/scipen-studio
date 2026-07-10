import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Plugins } from "./pages/Plugins";
import { Threads } from "./pages/Threads";
import { Approvals } from "./pages/Approvals";
import { Schedules } from "./pages/Schedules";
import { Outbox } from "./pages/Outbox";
import { System } from "./pages/System";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="plugins" element={<Plugins />} />
        <Route path="threads" element={<Threads />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="outbox" element={<Outbox />} />
        <Route path="system" element={<System />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
