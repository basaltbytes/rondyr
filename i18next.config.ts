import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en", "fr"],
  extract: {
    input: ["dashboard/src/**/*.{ts,tsx}"],
    ignore: ["dashboard/src/**/*.test.ts"],
    output: "dashboard/src/locales/{{language}}/{{namespace}}.json",
    defaultNS: "translation",
    // The files keep the order of the screens, not the alphabet.
    sort: false,
    // French has a plural form that English lacks. Both files keep the same keys,
    // because the type check in dashboard/src/lib/i18n.ts compares them.
    allPluralForms: true,
    // The last part of these keys is a value that the API returns or that the
    // state of a component holds, so the extractor cannot list them from the code.
    preservePatterns: [
      "status.reasons.*",
      "status.deliveries.*",
      "authentication.signIn.problems.*",
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
      "inbox.forms.suspension.title",
      "inbox.forms.turnstile.title",
      "inbox.webhooks.title",
      "inbox.emails.active",
    ],
  },
  lint: {
    // Lint the text of every element, including the components of the dashboard.
    acceptedTags: "all",
  },
});
