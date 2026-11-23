import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { messageCountsQuery } from "~/lib/api/messages";

interface ReaderPlaceholderProps {
  readonly organizationId: string;
}

/** The reader while no message is open: how many messages wait, once the counts are known. */
export function ReaderPlaceholder({ organizationId }: ReaderPlaceholderProps) {
  const { t } = useTranslation();
  const { data: counts } = useQuery(messageCountsQuery(organizationId));
  return (
    <>
      {/* The rule under the list's header continues across the empty reader. */}
      <div className="h-14 shrink-0 hairline-b" />
      {counts !== undefined && (
        <div className="grid gap-2 px-5 py-6">
          <h2 className="text-base font-semibold text-balance">
            {counts.quarantined === 0
              ? t("inbox.reader.nothingToReview")
              : t("inbox.reader.noOpenMessage")}
          </h2>
          <p className="max-w-prose text-pretty text-muted-foreground">
            {t("inbox.reader.waiting", { count: counts.quarantined })}
          </p>
        </div>
      )}
    </>
  );
}
