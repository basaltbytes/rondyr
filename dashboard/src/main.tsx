import { createRoot } from "react-dom/client";

import { SessionPanel } from "~/features/authentication/session-panel";

import "./dashboard.css";

function Dashboard() {
  return (
    <main>
      <h1>Rondyr</h1>
      <SessionPanel />
    </main>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<Dashboard />);
}
