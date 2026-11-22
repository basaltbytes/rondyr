import mark from "@rondyr/brand/rondyr-mark.svg?no-inline";
import wordmark from "@rondyr/brand/rondyr.svg?no-inline";

import { productName } from "~/lib/product";

export function ProductLogo({ compact }: { readonly compact?: boolean }) {
  const isCompact = compact ?? false;
  return (
    <img
      src={isCompact ? mark : wordmark}
      alt={productName}
      width={isCompact ? 64 : 184}
      height={64}
      className="h-8 w-auto"
    />
  );
}
