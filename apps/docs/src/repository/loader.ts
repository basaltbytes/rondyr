// An Astro content loader for the Markdown pages of the repository. The files stay where
// they are; the loader reads them, takes the title and description from the Markdown,
// and renders the body with the site's Markdown pipeline.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  githubBranch,
  githubRepository,
  listDocuments,
  parseDocument,
  repositoryPath,
} from "./documents.ts";

import type { Loader, LoaderContext } from "astro/loaders";
import type { DocumentSource } from "./documents.ts";

/** The edit link of a page, on GitHub. */
export function editUrl(path: string): string {
  return `${githubRepository}/edit/${githubBranch}/${path}`;
}

async function loadDocument(context: LoaderContext, document: DocumentSource): Promise<void> {
  const file = repositoryPath(document.path);
  const source = readFileSync(file, "utf8");
  const { title, description, body } = parseDocument(document.path, source);
  const head =
    description === ""
      ? []
      : [
          { tag: "meta" as const, attrs: { name: "description", content: description } },
          { tag: "meta" as const, attrs: { property: "og:description", content: description } },
        ];
  const data = await context.parseData({
    id: document.id,
    data: { title, head, editUrl: editUrl(document.path) },
    filePath: file,
  });
  const rendered = await context.renderMarkdown(body, { fileURL: pathToFileURL(file) });
  const filePath = relative(fileURLToPath(context.config.root), file);
  // Every build renders every page again, because a page's links depend on other files and
  // on the Markdown plugins. The store keeps an entry whose digest has not changed, so the
  // digest covers the rendered page, not only its source.
  const digest = context.generateDigest({ html: rendered.html, data });
  context.store.set({
    id: document.id,
    data,
    body,
    filePath,
    digest,
    rendered,
    assetImports: rendered.metadata?.imagePaths ?? [],
  });
}

async function loadAll(context: LoaderContext): Promise<void> {
  const documents = listDocuments();
  const ids = new Set(documents.map(({ id }) => id));
  for (const id of context.store.keys()) {
    if (!ids.has(id)) context.store.delete(id);
  }
  for (const document of documents) await loadDocument(context, document);
}

/** Loads every site Markdown file under `docs/` as a page. */
export function repositoryDocsLoader(): Loader {
  return {
    name: "rondyr-repository-docs",
    load: async (context) => {
      await loadAll(context);
      const watcher = context.watcher;
      if (watcher === undefined) return;
      const docs = repositoryPath("docs");
      watcher.add([docs]);
      const reload = (path: string): void => {
        if (!path.startsWith(docs)) return;
        if (!path.endsWith(".md")) return;
        loadAll(context).catch((error: Error) => context.logger.error(error.message));
      };
      watcher.on("change", reload);
      watcher.on("add", reload);
      watcher.on("unlink", reload);
    },
  };
}
