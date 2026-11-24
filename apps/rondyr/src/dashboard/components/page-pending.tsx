import { useTranslation } from "react-i18next";

import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";

const sidebarFolderRows = [0, 1, 2, 3] as const;
const sidebarFormRows = [0, 1] as const;
const listPreviewRows = [0, 1, 2, 3, 4, 5] as const;
const formFieldRows = [0, 1, 2] as const;
const listCardRows = [0, 1, 2] as const;

/**
 * Full-viewport dashboard shell placeholder shown while the session or organizations load
 * on a cold start, mirroring the sidebar, message list and reader layout.
 */
export function AppShellSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh w-full bg-background lg:h-dvh lg:overflow-hidden">
      <output className="sr-only">{t("common.loading")}</output>
      <aside
        aria-hidden="true"
        className="hidden w-64 shrink-0 flex-col bg-sidebar hairline-r p-3 lg:flex"
      >
        <div className="flex items-center gap-2.5 px-1 py-1.5">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="mt-6 grid gap-1.5 px-1">
          <Skeleton className="mb-1 h-3 w-16" />
          {sidebarFolderRows.map((row) => (
            <div key={row} className="flex h-9 items-center gap-2.5 px-1">
              <Skeleton variant="circle" className="size-4 shrink-0" />
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3 w-5 shrink-0" />
            </div>
          ))}
        </div>
        <div className="mt-6 grid gap-1.5 px-1">
          <Skeleton className="mb-1 h-3 w-14" />
          {sidebarFormRows.map((row) => (
            <div key={row} className="flex h-9 items-center gap-2.5 px-1">
              <Skeleton className="size-5 shrink-0" />
              <Skeleton className="h-3.5 w-28" />
            </div>
          ))}
        </div>
        <div className="mt-auto flex items-center gap-2.5 hairline-t pt-3 px-1">
          <Skeleton variant="circle" className="size-8 shrink-0" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        </div>
      </aside>

      <div aria-hidden="true" className="flex min-w-0 flex-1 flex-col lg:grid lg:inbox-panes">
        <div className="flex min-h-0 flex-col bg-background lg:hairline-r">
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 hairline-b px-4">
            <Skeleton className="h-5 w-28" />
            <Skeleton variant="circle" className="size-7" />
          </div>
          <div className="hairline-b px-3 py-2">
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="grid divide-y divide-border">
            {listPreviewRows.map((row) => (
              <div key={row} className="flex gap-3 px-4 py-3.5">
                <Skeleton className="mt-0.5 size-8 shrink-0" />
                <div className="grid min-w-0 flex-1 gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-10" />
                  </div>
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="hidden min-h-0 flex-col bg-card lg:flex">
          <div className="flex h-14 shrink-0 items-center justify-end gap-2 hairline-b px-4">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-28" />
          </div>
          <div className="grid max-w-3xl gap-6 px-6 py-7">
            <div className="grid gap-2.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-3.5 w-44" />
            </div>
            <div className="grid max-w-prose gap-2.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Holds the place of a page while its code and its data load. */
export function PagePending() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-5 px-5 py-10 lg:col-span-2">
      <output className="sr-only">{t("common.loading")}</output>
      <div aria-hidden="true" className="grid gap-2">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card aria-hidden="true">
        <CardHeader>
          <Skeleton className="h-4 w-3/4" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            {formFieldRows.map((row) => (
              <div key={row} className="grid gap-2">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Skeleton for a settings or authentication form inside a card. */
export function CardFormSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="grid gap-4">
      <output className="sr-only">{label}</output>
      <div aria-hidden="true" className="grid gap-4">
        {formFieldRows.map((row) => (
          <div key={row} className="grid gap-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
        <Skeleton className="h-10 w-32" />
      </div>
    </div>
  );
}

/** Skeleton for a list of items inside a card or settings section. */
export function CardListSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="grid gap-2.5">
      <output className="sr-only">{label}</output>
      <div aria-hidden="true" className="grid gap-2.5">
        {listCardRows.map((row) => (
          <div key={row} className="flex items-center justify-between gap-3 py-1.5">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Skeleton className="h-4 w-44 max-w-full" />
              <Skeleton className="h-3 w-32 max-w-full" />
            </div>
            <Skeleton className="h-8 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
