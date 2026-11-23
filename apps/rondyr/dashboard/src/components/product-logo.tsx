import { productName } from "~/lib/product";

function MarkPaths() {
  return (
    <g
      transform="translate(32 32) scale(0.03215) translate(-1496.509 -1968.429)"
      fill="currentColor"
      stroke="currentColor"
    >
      <path
        d="M2191.425 1371.998C2191.425 1053.144 1925.833 794.276 1598.698 794.276C1271.563 794.276 1005.971 1053.144 1005.971 1371.998C1005.971 1690.851 1271.563 1949.72 1598.698 1949.72"
        fill="none"
        strokeWidth="72.61"
        transform="matrix(1.335207 0 0 1.418007 -653.603024 22.925545)"
      />
      <path
        d="M1064.502 1657.35C1065.514 1638.974 1124.339 1571.357 1160.281 1541.604C1235.996 1478.927 1313.904 1441.41 1396.694 1423.237C1610.519 1376.301 1815.188 1463.303 1889.527 1626.279C1940.743 1738.561 1977.87 1906.745 1723.945 2035.508C1871.767 2058.878 1940.261 2100.518 1991.271 2293.743C2051.523 2521.973 2125.313 2373.407 2130.575 2402.393C2136.977 2437.667 2105.921 2493.116 2042.805 2555.733C1945.658 2652.113 1815.172 2754.227 1768.552 2731.039C1721.248 2707.511 1686.673 2668.338 1661.968 2549.271C1647.435 2479.234 1593.285 2162.395 1468.216 2242.389C1416.702 2275.338 1423.996 2461.637 1389.908 2495.696C1353.586 2531.985 1279.501 2527.676 1190.814 2468.616C1094.706 2404.615 1019.529 2306.363 1048.279 2296.507C1048.279 2296.507 1228.266 2231.838 1223.363 1969.007C1218.978 1733.967 1063.414 1677.118 1064.502 1657.35ZM1480.989 1664.745L1484.607 1947.688C1512.453 1961.672 1543.929 1968.819 1575.871 1968.411C1676.303 1967.127 1756.906 1892.886 1755.753 1802.726C1754.6 1712.567 1672.126 1640.411 1571.694 1641.695C1539.752 1642.104 1508.468 1650.053 1480.989 1664.745Z"
        fillRule="evenodd"
        strokeWidth="69"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="2269.733882" cy="2080.129179" rx="63.931" ry="64.13" strokeWidth="36.5" />
    </g>
  );
}

interface ProductLogoProps {
  readonly compact?: boolean;
  readonly size?: "default" | "lg";
}

/** Brand mark or wordmark. Inherits `currentColor` so it adapts to dark and light surfaces. */
export function ProductLogo({ compact, size }: ProductLogoProps) {
  const isCompact = compact ?? false;
  const heightClass = size === "lg" ? "h-12 w-auto" : "h-8 w-auto";
  return (
    <span className="inline-flex items-center">
      {isCompact ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 64 64"
          width={64}
          height={64}
          aria-hidden="true"
          className={heightClass}
        >
          <MarkPaths />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 184 64"
          width={184}
          height={64}
          aria-hidden="true"
          className={heightClass}
        >
          <g transform="translate(0 2.5) scale(0.88)">
            <MarkPaths />
          </g>
          <g
            transform="translate(-48 2)"
            fill="none"
            stroke="currentColor"
            strokeWidth="5.5"
            strokeLinejoin="round"
          >
            <path d="M127.5 35.5c0 5.4-4.2 9.2-9.9 9.2s-9.9-3.8-9.9-9.2 4.2-9.2 9.9-9.2 9.9 3.8 9.9 9.2Z" />
            <path d="M137.5 47V24.5m0 10.5c0-5.3 3.2-8.7 8.2-8.7 4.8 0 7.3 2.9 7.3 7.7v13" />
            <path d="M182 15v32m0-11.5c0 5.4-3.8 9.2-9.5 9.2s-9.6-3.8-9.6-9.2 3.9-9.2 9.6-9.2 9.5 3.8 9.5 9.2Z" />
            <path d="m191.5 24.5 9.2 22m8.5-22-10.8 26.9c-1.7 4.2-4.1 5.9-8 5.9" />
            <path d="M217.5 47V24.5m0 11.2c0-6.2 4.2-9.8 10-9.4" />
          </g>
        </svg>
      )}
      <span className="sr-only">{productName}</span>
    </span>
  );
}
