import { useActionState } from "react";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
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
    <Card>
      <CardHeader>
        <CardTitle>Connexion</CardTitle>
        <CardDescription>Le compte de cette installation de Rondyr.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <TextField
            label="Adresse e-mail"
            type="email"
            name="email"
            autoComplete="username"
            required
          />
          <TextField
            label="Mot de passe"
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
          <FormProblem>{error}</FormProblem>
          <Button type="submit" variant="default" disabled={pending}>
            {pending ? "Connexion en cours…" : "Se connecter"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
