import { ProductLogo } from "~/components/product-logo";
import { RecipientConfirmation as Confirmation } from "~/features/recipients/recipient-confirmation";

/** The page of a confirmation link: `/confirm-recipient#<secret>`. Nobody needs to be signed in. */
export function RecipientConfirmation() {
  const token = window.location.hash.slice(1);
  return (
    <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
      <h1>
        <ProductLogo />
      </h1>
      <Confirmation token={token} />
    </main>
  );
}
