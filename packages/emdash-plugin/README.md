# @basaltbytes/emdash-plugin-rondyr

An EmDash plugin that sends submissions to [Rondyr](https://github.com/basaltbytes/rondyr) from forms declared in Astro or built with `@emdash-cms/plugin-forms`. Editors review messages in the EmDash admin, and the site’s mailer sends notifications once Rondyr accepts them.

Installation, configuration and operation: [docs/emdash.md](https://github.com/basaltbytes/rondyr/blob/main/docs/emdash.md).

| Entry point | Use |
| --- | --- |
| `@basaltbytes/emdash-plugin-rondyr` | `rondyr({ url, forms })` for declared forms, or `rondyr({ url })` and `formsWithoutSubmissions()` or `formsWithRondyr()` in place of `formsPlugin()`, for `astro.config.mjs` |
| `@basaltbytes/emdash-plugin-rondyr/plugin` | The plugin, loaded by EmDash |
| `@basaltbytes/emdash-plugin-rondyr/forms` | The forms plugin without its Submissions page and widget, with its emails held for a form linked to Rondyr, loaded by EmDash for `formsWithoutSubmissions()` |
| `@basaltbytes/emdash-plugin-rondyr/forms-with-submissions` | The same forms plugin with its Submissions page and widget, loaded by EmDash for `formsWithRondyr()` |
| `@basaltbytes/emdash-plugin-rondyr/admin` | The admin pages and widget, loaded by EmDash |
| `@basaltbytes/emdash-plugin-rondyr/route` | The site's submission route: `export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";`, and `submitForm()` for a site route or page that answers the visitor its own way |

MIT license. Rondyr itself is AGPL-3.0; this package contains none of its code.

In declared mode, import `getDeclaredForm(Astro, slug)` from the `/route` entry to read the fields and public Turnstile site key. The forms plugin is an optional peer dependency.
