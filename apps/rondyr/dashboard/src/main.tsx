import { createRoot } from "react-dom/client";

import "~/lib/i18n";
import { Dashboard } from "~/routes/dashboard";
import { Invitation } from "~/routes/invitation";
import { RecipientConfirmation } from "~/routes/recipient-confirmation";
import { ResetPassword } from "~/routes/reset-password";

import "./dashboard.css";

// The Worker serves the same page for every path; the path picks what it shows.
const pages = new Map([
  ["/invitation", Invitation],
  ["/confirm-recipient", RecipientConfirmation],
  ["/reset-password", ResetPassword],
]);
const Page = pages.get(window.location.pathname) ?? Dashboard;

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<Page />);
}
