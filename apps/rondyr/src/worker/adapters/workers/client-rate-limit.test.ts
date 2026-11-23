import { assert, it } from "@effect/vitest";

import { rateLimitedClient } from "./client-rate-limit.ts";

it("counts an IPv4 address as one client and an IPv6 address by its /64 network", () => {
  assert.strictEqual(rateLimitedClient("203.0.113.7"), "203.0.113.7");
  assert.strictEqual(
    rateLimitedClient("2001:0db8:0001:0002:0003:0004:0005:0006"),
    "2001:db8:1:2::/64",
  );
  // Addresses of one /64 network are one client, however they are written.
  assert.deepEqual(
    ["2001:db8:1:2::1", "2001:DB8:1:2:ffff::9", "2001:db8:1:2:a:b:c:d"].map(rateLimitedClient),
    ["2001:db8:1:2::/64", "2001:db8:1:2::/64", "2001:db8:1:2::/64"],
  );
  assert.strictEqual(rateLimitedClient("2001:db8:1:3::1"), "2001:db8:1:3::/64");
  assert.strictEqual(rateLimitedClient("2001:db8::1"), "2001:db8:0:0::/64");
  assert.strictEqual(rateLimitedClient("::1"), "0:0:0:0::/64");
  // An address that does not parse counts as itself.
  assert.deepEqual(
    ["::ffff:192.0.2.1", "2001:db8::1::2", "2001:db8:1:2:3:4:5:6:7", "fe80::1%eth0"].map(
      rateLimitedClient,
    ),
    ["::ffff:192.0.2.1", "2001:db8::1::2", "2001:db8:1:2:3:4:5:6:7", "fe80::1%eth0"],
  );
});
