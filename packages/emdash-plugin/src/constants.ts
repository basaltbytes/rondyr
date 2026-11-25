import packageJson from "../package.json" with { type: "json" };

export const pluginId = "rondyr";

export const pluginVersion = packageJson.version;

/** The forms plugin's ID, as `@emdash-cms/plugin-forms` declares it. */
export const formsPluginId = "emdash-forms";

/** The path of the site's submission route, which this package exports for Astro. */
export const submissionRoutePath = "/api/form";
