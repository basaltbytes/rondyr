import { InvitationAcceptance } from "~/features/authentication/invitation-acceptance";
import { productName } from "~/lib/product";

/** The page of an invitation link: `/invitation#<secret>`. A fragment never reaches a server. */
export function Invitation() {
  const token = window.location.hash.slice(1);
  return (
    <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
      <h1 className="text-lg font-semibold">{productName}</h1>
      <InvitationAcceptance token={token} />
    </main>
  );
}
