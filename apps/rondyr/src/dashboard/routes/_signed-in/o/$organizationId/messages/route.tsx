import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Schema } from "effect";
import { useTranslation } from "react-i18next";

import { MessageList } from "~/features/messages/message-list";
import { messageListQuery } from "~/lib/api/messages";
import { messagesSearch, MessagesSearch } from "~/lib/messages-search";
import { rememberMessages } from "~/routes/-layout/last-messages";
import { useOrganization } from "~/routes/-layout/organization-context";

/**
 * The messages of a folder, with the open message beside them. The folder, the form and
 * the searched text are in the address, so a reload and a link keep them.
 */
export const Route = createFileRoute("/_signed-in/o/$organizationId/messages")({
  staticData: { sidebar: { at: "messages" } },
  validateSearch: Schema.toStandardSchemaV1(MessagesSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => {
    void context.queryClient
      .infiniteQuery(messageListQuery(params.organizationId, deps))
      .catch(() => undefined);
  },
  // The settings go back to the list that was shown before them.
  onEnter: ({ params, search }) => rememberMessages(params.organizationId, search),
  onStay: ({ params, search }) => rememberMessages(params.organizationId, search),
  component: Messages,
});

function Messages() {
  const { t } = useTranslation();
  const organization = useOrganization();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const openId = useParams({ strict: false, select: (params) => params.submissionId ?? null });
  const { folder } = search;
  const form = search.form ?? null;
  const text = search.q ?? null;

  return (
    <>
      <MessageList
        organization={organization}
        search={search}
        openId={openId}
        onForm={(next) =>
          void navigate({
            to: "/o/$organizationId/messages",
            search: messagesSearch(folder, next, text),
          })
        }
        onSearch={(next) =>
          void navigate({
            to: "/o/$organizationId/messages",
            search: messagesSearch(folder, form, next),
          })
        }
      />
      <section
        aria-label={t("inbox.reader.label")}
        className={cn("flex min-h-0 min-w-0 flex-col bg-card", openId === null && "max-lg:hidden")}
      >
        <Outlet />
      </section>
    </>
  );
}
