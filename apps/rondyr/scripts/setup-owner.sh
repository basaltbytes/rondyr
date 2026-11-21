#!/usr/bin/env bash
set +x
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s <rondyr-origin>\n' "$0" >&2
  exit 2
fi

setup_token=${RONDYR_SETUP_TOKEN:-}
unset RONDYR_SETUP_TOKEN

rondyr_origin=$(node --input-type=module - "$1" <<'NODE'
const url = URL.parse(process.argv[2]);
const loopback =
  url?.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (url !== null && url.href === `${url.origin}/` && (url.protocol === "https:" || loopback)) {
  process.stdout.write(url.origin);
} else {
  console.error("Give an HTTPS origin or a local HTTP address, without a path or credentials.");
  process.exitCode = 2;
}
NODE
)

if [[ -z "$setup_token" ]]; then
  printf 'Rondyr setup token: ' >&2
  IFS= read -rs setup_token
  printf '\n' >&2
fi

if [[ ${#setup_token} -lt 32 || "$setup_token" == *$'\n'* || "$setup_token" == *$'\r'* ]]; then
  printf 'The token must have at least 32 characters on one line.\n' >&2
  exit 1
fi

printf 'Account name: ' >&2
IFS= read -r owner_name
printf 'Email address: ' >&2
IFS= read -r owner_email
printf 'Password (12 to 128 characters): ' >&2
IFS= read -rs owner_password
printf '\n' >&2

status=$(
  printf '%s\0' "$owner_name" "$owner_email" "$owner_password" |
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const [name, email, password] = readFileSync(0, "utf8").split("\0");
      process.stdout.write(JSON.stringify({ name, email, password }));
    ' |
    curl --disable --silent --show-error --connect-timeout 5 --max-time 20 \
      --output /dev/null --write-out '%{http_code}' \
      --header @/dev/fd/3 --json @- "$rondyr_origin/api/setup" \
      3< <(printf 'Authorization: Bearer %s\n' "$setup_token")
)

if [[ "$status" != 201 ]]; then
  printf 'Setup refused (HTTP %s).\n' "$status" >&2
  exit 1
fi

printf 'First account created (HTTP 201).\n'
