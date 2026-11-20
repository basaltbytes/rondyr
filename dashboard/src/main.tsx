import { createRoot } from "react-dom/client";

import "~/lib/i18n";
import { Dashboard } from "~/routes/dashboard";

import "./dashboard.css";

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<Dashboard />);
}
