#!/usr/bin/env bash
# Runs every suite against an app file. Usage: tests/run-all.sh [index.html] [old-app.html for CH7]
# Needs Node 18+ and Playwright Chromium. No real Firebase project or production data is touched:
# all suites run against an in-process fake Firestore/Auth (tests/harness.js).
set -u
APP="${1:-index.html}"; OLD="${2:-}"
cd "$(dirname "$0")/.."
run(){ echo "== $1"; shift; "$@" 2>&1 | grep -E "^(PASS|FAIL)|→|passed$"; }
run sync      node tests/suite.js "$APP"
run sync+     node tests/sync-extra.js "$APP"
if [ -n "$OLD" ]; then run chunks node tests/chunk-suite.js "$APP" "$OLD"; else run chunks node tests/chunk-suite.js "$APP" /dev/null; fi
run security  node tests/security-suite.js "$APP"
run persist   node tests/persist-suite.js "$APP"
run finance   node tests/finance-suite.js "$APP"
run wealth    node tests/wealth-suite.js "$APP"
run split     node tests/split-suite.js "$APP"
run followup  node tests/followup-suite.js "$APP"
run income    node tests/income-suite.js "$APP"
run export    node tests/export-suite.js "$APP"
run ai        node tests/ai-suite.js "$APP"
run voice     env KM_FAKE_MEDIA=1 node tests/voice-suite.js "$APP"
run proactive node tests/pro-suite.js "$APP"
