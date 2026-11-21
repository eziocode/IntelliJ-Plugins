#!/bin/sh
# Smoke test for the deployed REST API. Usage:
#   MCP_TOKEN=... sh deploy/smoke.sh [base-url]
# The token is read from the environment; it is never printed.
U="${1:-https://crmindex.development.catalystappsail.in}"
if [ -z "$MCP_TOKEN" ]; then echo "set MCP_TOKEN first"; exit 1; fi
H="Authorization: Bearer $MCP_TOKEN"
code() { curl -s -m 60 -o /tmp/smoke.out -w '%{http_code}' "$@"; }
echo "no token      -> $(curl -s -m 25 -o /dev/null -w '%{http_code}' $U/api/status) (expect 401)"
echo "status        -> $(code -H "$H" $U/api/status)"
echo "branches      -> $(code -H "$H" "$U/api/branches?contains=BULKIO&limit=3")"
echo "search master -> $(code -X POST -H "$H" -H 'content-type: application/json' -d '{"query":"validate api name for custom button","limit":3}' $U/api/search)"
ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/smoke.out | head -1)
echo "symbol        -> $(code -X POST -H "$H" -H 'content-type: application/json' -d "{\"id\":\"$ID\",\"max_lines\":5}" $U/api/symbol) id=$ID"
echo "diff          -> $(code -X POST -H "$H" -H 'content-type: application/json' -d '{"base":"master","head":"BULKIO_UNDO_ADOPTION","limit":5}' $U/api/diff)"
echo "unknown branch-> $(code -X POST -H "$H" -H 'content-type: application/json' -d '{"query":"x","branch":"nope"}' $U/api/search) (expect 409)"
