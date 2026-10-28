# KeepHybrid: Security & Reliability Remediation

Branch: `fix/keep-hybrid-reliability`. Base: `main` @ `e7a32d5` (v4.9).

## Where the data lives

| Data | Where | Protection |
|---|---|---|
| Financial dataset (transactions, accounts, budgets…) | `localStorage` on the device, one key per account (`km_local_data__<uid>`) | **Plain text.** On-device encryption (AES-GCM) cannot be turned on in cloud or guest sessions in this version. |
| Cloud copy | Firestore `users/{uid}` (settings, accounts…) + `users/{uid}/tx/{YYYY-MM}` (transactions) | Firebase Auth + Firestore rules (`firestore.rules`). **Not end-to-end encrypted.** Google can read it, as with any ordinary Firestore data. |
| Local backups (3 rotating slots) | `localStorage`, per account | Plain text, same as the data. |
| Assistant chat history | `localStorage` (`km_ai_chat__<uid>`) | Plain text, never uploaded to Firestore. |
| Offline unlock | `km_offline_unlock` | A PBKDF2-HMAC-SHA256 verifier (310k iterations, 16-byte salt). The password itself is not stored. |
| What goes to Gemini | The message text, the last 20 chat turns, tool results the model asks for (monthly summary, up to 50 matching transactions with descriptions), and receipt images | Over Firebase AI Logic + App Check (reCAPTCHA Enterprise). Disclosed in the consent dialog before first use. |

The Firebase client config (`apiKey`…) in `index.html` is public by design and is not a secret. The file contains no private API keys.

## Findings

Severity follows the definitions in the task. "Baseline" means the test was run against `main` before the fix.

| ID | Sev | Location | Issue | Status | Evidence |
|---|---|---|---|---|---|
| H-01 | High | startup fallback when Firebase fails to load (`lastUser()`) | The previous user's financial data opened automatically, with no authentication at all | Fixed: an offline unlock screen using the account password (local verifier + escalating lockout); otherwise no access | security S2–S4, sync OFF; baseline S2 **FAIL** |
| H-01b | High | `createHybridAdapter` → `emit` / `onRemote` | An upload from the old session finishing after an account switch replaced the new session's in-memory data with the old account's data (then it could be saved and uploaded under the new account) | Fixed: a closed session can no longer touch the UI or memory | security S7; baseline **FAIL** (reproduced the leak) |
| H-02 | High | `save()` and its callers | Callers ignored the save result and showed success | Fixed: `save()` returns a reliable result, plus `_lastSaveOk`, `commitReplace()` (rolls back on failure) and `cloudStatusText()` (separates local from cloud) | persist I7, R1, R5, A3, A6, A9 |
| H-03a | High | `restoreBackup()` | A save failure showed "تمت الاستعادة ✅" while the data was not saved | Fixed | R1; baseline FAIL |
| H-03b | Medium | `restoreBackup()` → `backupNow` | The pre-restore backup could push the backup being restored (the 3rd slot) out of the slots | Fixed: `backupNow(reason,{keep})` | R2; baseline FAIL |
| H-03c | High | `clearAll()` | Clearing went ahead even if the pre-clear backup failed (possible permanent loss) | Fixed: aborts | R4; baseline FAIL |
| H-03d | High | `importData()` | A save failure after import showed success and left unsaved data in memory | Fixed: `commitImport()` | I7 |
| H-03e | Medium | `importPipeline()` | `{}` or a JSON file from another app was accepted as an empty dataset that replaces your data | Fixed: requires a `transactions` array | I5; baseline FAIL |
| H-03f | Low | `importPipeline()` | The backup was taken before confirmation, so cancelling consumed a backup slot | Fixed: backup moved to after confirmation | I3 |
| H-04a | High | `aiExec('set_budget')` | Reported success to Gemini even when the save failed | Fixed: previous value restored + `ok:false` | A3; baseline FAIL |
| H-04b | Medium | `aiExec('set_budget')` | `monthly_limit:''` became 0 and **deleted** the budget | Fixed | A2; baseline FAIL |
| H-04c | Medium | `aiExec('add_transaction')` | Invalid date silently became today; type silently became expense; a model retry recorded twice; a failed charity save was ignored | Fixed: explicit errors, per-message dedupe, rollback | A5–A7 |
| H-04d | Medium | `aiExec('delete_transaction')` | Reported a delete as done even when the save failed | Fixed: transaction restored | A9 |
| H-04e | Medium | `aiSend()` (receipts) | Text inside a receipt image could drive deletion or budget changes | Fixed: receipt turns cannot delete or change budgets | A10 |
| H-04f | Medium | `aiSend()` | No timeout on Gemini requests; the assistant could hang | Fixed: 60s timeout, late replies ignored | Code review (no automated hang test) |
| P2-1 | Medium | `loadDataUnlocked()` | Decryption failure → blank data with writes allowed (fail-open) | Fixed: writing stops (fail closed) and the original stays | E2; baseline FAIL. The path is unreachable in hybrid sessions in this version |
| P2-2 | Info | encryption | Encryption primitives verified (random IV, tag verification, wrong key, tampered data) | No format change | E1 |
| P2-3 | Medium | `firestore.rules` | Rules don't restrict fields or sizes; protection relies on ownership + the old-version guard | Proposal only | Unverified by Firebase (see below) |
| P4-1 | Medium (business rule) | `FE.SIGN[Saving] = -1` | Recording a "saving" reduces the account balance and net worth by its amount, and isn't added anywhere else. This contradicts the comment in `FE.cashFlow` ("الادخار لا يغادر الحساب") | **Not changed**; needs a product decision | F11 (records current behavior) |
| P6-1 | Medium | `exportReportCSV()` | CSV formula injection: quoting alone doesn't stop it | Fixed: `csvCell()` neutralizes `= + - @ Tab CR` and keeps negative numbers | C1; baseline FAIL |
| L-1 | Low | settings ← security | The auto-lock and PIN options appear in settings but don't lock the session in this version (Firebase is the gatekeeper) | Documented, not changed | Code review |
| L-2 | Low | sync retry | Fixed retries (30s after a network failure + periodic sync every 2 min), not exponential, but no tight loop | Documented | Code review |

## Firestore rules: status

- The `firestore.rules` file in the repo was reviewed:
  - Owner-only for `users/{uid}` and `users/{uid}/tx/{month}`.
  - Anonymous users are blocked.
  - Any other path is closed.
  - The `_fmt` guard blocks old app versions from overwriting the chunked format.
- **Not verified by Firebase:** the Firestore Emulator download is blocked from the test environment. The tests use an emulation in `tests/harness.js` (ownership + the `_fmt` guard + 1 MiB). That is not Firebase evaluating the rules.
- **The deployed rules were not inspected** (no access to the Console from here). The user reported publishing them. Verify by hand: Console → Firestore → Rules, matching the repo file.
- Recommended manual check in the Rules Playground:
  - Reading `users/OTHER_UID` as another user → denied.
  - Writing `users/{uid}` with no `_fmt` after splitting → denied.
  - An anonymous user → denied.

## Tests

`tests/run-all.sh index.html tests/fixtures/keepMoney-v4.8-old-client.html`. Everything runs against a fake Firebase (Auth + Firestore in memory). No real project and no production data are touched.

- `suite.js`: 33 sync and persistence tests.
- `sync-extra.js`: 3 tests (ambiguous result, timeout, clear vs pending edit).
- `chunk-suite.js`: 10 tests (monthly split, old-version guard).
- `security-suite.js`: 10 tests (H-01).
- `persist-suite.js`: 30 tests (import, restore, clear, assistant, CSV, encryption).
- `finance-suite.js`: 11 financial invariants + 1 mobile smoke test.
- `ai-suite.js`: 21 tests; `voice-suite.js`: 5 tests; `pro-suite.js`: 8 tests.

**Not run:**
- A real Android device or Android WebView (Median): only Chromium with phone-sized viewports, portrait and landscape.
- The Firestore Rules emulator.
- Real Gemini: AI tests use a scripted mock of the Firebase AI SDK.

## Limitations

- The data on the device is plain text. The offline unlock is a screen guard, not encryption: anyone who can read the browser storage can read the data.
- A Firebase session persisted on the device opens with no password, which is Firebase's normal behavior.
- The cloud copy is not end-to-end encrypted. E2E would need a separate design (keys per user, wrapping with a password and recovery code, chunk migration, cross-device sharing) and an explicit migration plan.
- Old clients (v4.8 and earlier) can no longer write after the monthly split. That's intentional and enforced by the rules.
