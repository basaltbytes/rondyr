import { createRoot } from "react-dom/client";

import "./dashboard.css";

function Dashboard() {
  return (
    <main>
      <h1>Rondyr</h1>
      <p>Le backend de vos formulaires.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<Dashboard />);
}
