import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";
import { ExtendDocsSchema } from "lucode-starlight/schema";

import { repositoryDocsLoader } from "./repository/loader.ts";

export const collections = {
  docs: defineCollection({
    loader: repositoryDocsLoader(),
    schema: docsSchema({ extend: ExtendDocsSchema }),
  }),
};
