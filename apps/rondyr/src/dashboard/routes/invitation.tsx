import { createFileRoute } from "@tanstack/react-router";

import { ProductLogo } from "~/components/product-logo";
import { InvitationAcceptance } from "~/features/authentication/invitation-acceptance";

/** The page of an invitation link: `/invitation#<secret>`. A fragment never reaches a server. */
export const Route = createFileRoute("/invitation")({
  component: Invitation,
});

function Invitation() {
  const token = window.location.hash.slice(1);
  return (
    <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      <InvitationAcceptance token={token} />
    </main>
  );
}
