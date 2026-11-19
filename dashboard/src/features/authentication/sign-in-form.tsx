import { useActionState } from "react";

import { authClient } from "~/lib/auth-client";

async function signIn(_previousError: string | null, fields: FormData): Promise<string | null> {
  try {
    const result = await authClient.signIn.email({
      email: String(fields.get("email") ?? ""),
      password: String(fields.get("password") ?? ""),
    });

    if (result.error === null) return null;
    if (result.error.status === 429) return "Trop de tentatives. Réessayez dans un moment.";
    if (result.error.status >= 500) return "Le service de connexion est indisponible.";
    return "Vérifiez votre adresse e-mail et votre mot de passe.";
  } catch {
    return "La connexion a échoué. Réessayez.";
  }
}

export function SignInForm() {
  const [error, action, pending] = useActionState(signIn, null);

  return (
    <form action={action} className="auth-form">
      <h2>Connexion</h2>
      <label>
        Adresse e-mail
        <input type="email" name="email" autoComplete="username" required />
      </label>
      <label>
        Mot de passe
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "Connexion en cours…" : "Se connecter"}
      </button>
    </form>
  );
}
