# @basaltbytes/emdash-plugin-rondyr

An EmDash plugin that sends the submissions of `@emdash-cms/plugin-forms` to [Rondyr](https://github.com/basaltbytes/rondyr), shows Rondyr's Inbox, To review and Archived folders in the EmDash admin, and emails accepted messages through the site's mailer.

Installation, configuration and operation: [docs/emdash.md](https://github.com/basaltbytes/rondyr/blob/main/docs/emdash.md).

| Entry point | Use |
| --- | --- |
| `@basaltbytes/emdash-plugin-rondyr` | `rondyr({ url })` and `formsWithoutSubmissions()` for `astro.config.mjs` |
| `@basaltbytes/emdash-plugin-rondyr/plugin` | The plugin, loaded by EmDash |
| `@basaltbytes/emdash-plugin-rondyr/forms` | The forms plugin without its Submissions page and widget, loaded by EmDash for `formsWithoutSubmissions()` |
| `@basaltbytes/emdash-plugin-rondyr/admin` | The admin pages and widget, loaded by EmDash |
| `@basaltbytes/emdash-plugin-rondyr/route` | The site's submission route: `export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";`, and `submitForm()` for a site route or page that answers the visitor its own way |

MIT license. Rondyr itself is AGPL-3.0; this package contains none of its code.
