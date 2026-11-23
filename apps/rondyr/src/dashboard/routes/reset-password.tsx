import { createFileRoute } from "@tanstack/react-router";

import { ProductLogo } from "~/components/product-logo";
import { PasswordReset } from "~/features/authentication/password-reset";

/** The page of a reset link: `/reset-password#<secret>`. A fragment never reaches a server. */
export const Route = createFileRoute("/reset-password")({
  component: ResetPassword,
});

function ResetPassword() {
  const token = window.location.hash.slice(1);
  return (
    <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      <PasswordReset token={token} />
    </main>
  );
}
