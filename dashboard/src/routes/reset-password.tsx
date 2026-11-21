import { PasswordReset } from "~/features/authentication/password-reset";
import { productName } from "~/lib/product";

/** The page of a reset link: `/reset-password#<secret>`. A fragment never reaches a server. */
export function ResetPassword() {
  const token = window.location.hash.slice(1);
  return (
    <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
      <h1 className="text-lg font-semibold">{productName}</h1>
      <PasswordReset token={token} />
    </main>
  );
}
