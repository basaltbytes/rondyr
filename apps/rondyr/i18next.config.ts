import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en", "fr"],
  extract: {
    input: ["src/dashboard/**/*.{ts,tsx}"],
    ignore: ["src/dashboard/**/*.test.ts", "src/dashboard/vitest.config.ts"],
    output: "src/dashboard/locales/{{language}}/{{namespace}}.json",
    defaultNS: "translation",
    // The files keep the order of the screens, not the alphabet.
    sort: false,
    // French has a plural form that English lacks. Both files keep the same keys,
    // because the type check in src/dashboard/lib/i18n.ts compares them.
    allPluralForms: true,
    // The last part of these keys is a value that the API returns or that the
    // state of a component holds, so the extractor cannot list them from the code.
    preservePatterns: [
      "status.reasons.*",
      "status.deliveries.*",
      "authentication.signIn.problems.*",
      "setup.problems.*",
      "inbox.sections.*",
      "inbox.statuses.*",
      "inbox.reader.problems.*",
      "inbox.deliveries.outcomes.*",
      "inbox.deliveries.problems.*",
      "inbox.forms.statuses.*",
      "inbox.forms.redirect.refusals.*",
      "inbox.origins.refusals.*",
      "inbox.webhooks.refusals.*",
      "inbox.emails.refusals.*",
      "inbox.connectors.refusals.*",
      "inbox.connectors.types.*",
      "inbox.members.roles.*",
      "inbox.members.emails.*",
      "inbox.members.problems.*",
      "invitation.as.*",
      "invitation.problems.*",
      "inbox.emails.statuses.*",
      "inbox.emails.resend.*",
      "recipientConfirmation.confirmed.*",
      "recipientConfirmation.invalid.*",
      "inbox.retention.outcomes.*",
      "verification.badges.*",
      "verification.checkStates.*",
      "verification.turnstileCauses.*",
      "verification.turnstileUnavailable.*",
      "verification.blockedScopes.*",
      "verification.failures.*",
      "verification.spamStates.*",
      "verification.solicitationStates.*",
      "verification.relevanceStates.*",
      "verification.previewBadges.*",
    ],
  },
  status: {
    // These words are the same in English and in French.
    ignoreKeys: [
      "languages.en",
      "languages.fr",
      "sidebar.menu",
      "inbox.navigation.label",
      "inbox.navigation.messages",
      "inbox.setup.firstFormPlaceholder",
      "inbox.deliveries.webhook",
      "inbox.forms.honeypot.placeholder",
      "inbox.forms.turnstile.title",
      "inbox.destinations.kinds.webhook",
      "inbox.connectors.types.airtable.fields.table.label",
      "inbox.list.export.csv",
      "inbox.list.export.jsonl",
    ],
  },
  lint: {
    // Lint the text of every element, including the components of the dashboard.
    acceptedTags: "all",
  },
});
