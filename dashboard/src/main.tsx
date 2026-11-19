import { createRoot } from "react-dom/client";

import { Dashboard } from "~/routes/dashboard";

import "./dashboard.css";

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<Dashboard />);
}
