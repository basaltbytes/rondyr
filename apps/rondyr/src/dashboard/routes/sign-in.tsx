import { createFileRoute, redirect, useRouterState } from "@tanstack/react-router";
import { Schema } from "effect";
import { useTranslation } from "react-i18next";

import { ProductLogo } from "~/components/product-logo";
import { SignedOut } from "~/features/authentication/signed-out";
import { sessionQuery } from "~/lib/api/session";
import { signInSearchOf } from "~/lib/return-address";
import { useSignedIn } from "~/lib/session";

/**
 * What a signed-out visitor sees: the owner setup on a new instance, the sign-in form
 * otherwise. Once signed in, the visitor arrives at the address they asked for.
 */
export const Route = createFileRoute("/sign-in")({
  validateSearch: Schema.toStandardSchemaV1(signInSearchOf(window.location.origin)),
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient
      .query({ ...sessionQuery, staleTime: "static" })
      .catch(() => null);
    if (session !== null) throw redirect({ href: search.redirect ?? "/", replace: true });
  },
  component: SignIn,
});

function SignIn() {
  const { t } = useTranslation();
  const { redirect: address } = Route.useSearch();
  const signedIn = useSignedIn(address ?? "/");
  // The API answered that the session ended while the dashboard was open.
  const ended = useRouterState({ select: ({ location }) => location.state.sessionEnded === true });
  return (
    <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      {ended && (
        <output className="block text-center text-sm text-pretty text-muted-foreground">
          {t("authentication.signIn.sessionEnded")}
        </output>
      )}
      <SignedOut onSignedIn={signedIn} />
    </main>
  );
}
