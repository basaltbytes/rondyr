import { createFileRoute } from "@tanstack/react-router";

import { ProductLogo } from "~/components/product-logo";
import { RecipientConfirmation } from "~/features/recipients/recipient-confirmation";

/** The page of a confirmation link: `/confirm-recipient#<secret>`. Nobody needs to be signed in. */
export const Route = createFileRoute("/confirm-recipient")({
  component: ConfirmRecipient,
});

function ConfirmRecipient() {
  const token = window.location.hash.slice(1);
  return (
    <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      <RecipientConfirmation token={token} />
    </main>
  );
}
