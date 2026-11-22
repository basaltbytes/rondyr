// The text of the landing page that the hero component and the page share.

/** Cloudflare's deploy link for the public repository. */
export const deployUrl =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/basaltbytes/rondyr";

export interface FirstRunStep {
  readonly title: string;
  /** One paragraph of HTML. */
  readonly html: string;
}

export const firstRun: readonly FirstRunStep[] = [
  {
    title: "Deploy",
    html: "Select <strong>Deploy to Cloudflare</strong>. Cloudflare copies the repository to your GitHub or GitLab account and deploys Rondyr to your Cloudflare account. When it asks for the setup token, enter a long random passphrase of at least 32 characters (for example from your password manager or <code>openssl rand -hex 32</code>) and keep it for the next step.",
  },
  {
    title: "Create the owner account",
    html: "Open your new Rondyr address and create the first account with that setup token. Public sign-up stays closed; other people join your organization through an invitation link.",
  },
  {
    title: "Connect a form",
    html: "Create an organization and a form in the dashboard, then paste the form's URL into the <code>action</code> attribute of a <code>&lt;form&gt;</code> on your site.",
  },
];

/** The form of the landing page, as a site would write it. */
export const formSnippet = `<form action="https://rondyr.example.com/f/YOUR_PUBLIC_ID" method="post">
  <input type="email" name="email" required />
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>`;
