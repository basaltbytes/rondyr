import { useActionState } from "react";

import { authClient } from "~/lib/auth-client";

import { SignInForm } from "./sign-in-form.tsx";

async function signOut(): Promise<string | null> {
  try {
    const result = await authClient.signOut();
    return result.error === null ? null : "La déconnexion a échoué. Réessayez.";
  } catch {
    return "La déconnexion a échoué. Réessayez.";
  }
}

export function SessionPanel() {
  const session = authClient.useSession();
  const [error, action, pending] = useActionState(signOut, null);
  if (session.isPending) return <output>Vérification de la session…</output>;
  if (session.data === null) return <SignInForm />;

  return (
    <form action={action} className="auth-form">
      <p>Connecté avec {session.data.user.email}</p>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "Déconnexion en cours…" : "Se déconnecter"}
      </button>
    </form>
  );
}
