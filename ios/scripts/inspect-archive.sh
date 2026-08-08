#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_PATH="${1:-build/WingDex.xcarchive}"
EVIDENCE_DIR="${2:-build/archive-inspection}"
REQUIRE_SIGNED="${REQUIRE_SIGNED:-0}"

APP_PATH="${ARCHIVE_PATH}/Products/Applications/WingDex.app"
EXTENSION_PATH="${APP_PATH}/PlugIns/WingDexShareExtension.appex"
APP_DSYM="${ARCHIVE_PATH}/dSYMs/WingDex.app.dSYM"
EXTENSION_DSYM="${ARCHIVE_PATH}/dSYMs/WingDexShareExtension.appex.dSYM"

mkdir -p "${EVIDENCE_DIR}"
REPORT="${EVIDENCE_DIR}/report.txt"
exec > >(tee "${REPORT}") 2>&1

failures=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

require_file() {
  if [[ -f "$1" ]]; then
    pass "$2"
  else
    fail "$2 (missing $1)"
  fi
}

require_dir() {
  if [[ -d "$1" ]]; then
    pass "$2"
  else
    fail "$2 (missing $1)"
  fi
}

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true
}

expect_plist_value() {
  local actual
  actual="$(plist_value "$1" "$2")"
  if [[ "${actual}" == "$3" ]]; then
    pass "$4"
  else
    fail "$4 (expected '$3', got '${actual:-missing}')"
  fi
}

uuid_set() {
  xcrun dwarfdump --uuid "$1" 2>/dev/null | awk '{print $2}' | sort -u
}

check_dsym() {
  local binary="$1"
  local dsym="$2"
  local dwarf_name="$3"
  local label="$4"
  local dwarf_binary="${dsym}/Contents/Resources/DWARF/${dwarf_name}"

  require_dir "${dsym}" "${label} dSYM is present"
  require_file "${dwarf_binary}" "${label} dSYM contains DWARF binary"
  if [[ ! -f "${binary}" || ! -f "${dwarf_binary}" ]]; then
    return
  fi

  local binary_uuids dsym_uuids
  binary_uuids="$(uuid_set "${binary}")"
  dsym_uuids="$(uuid_set "${dwarf_binary}")"
  if [[ -n "${binary_uuids}" && "${binary_uuids}" == "${dsym_uuids}" ]]; then
    pass "${label} binary and dSYM UUIDs match (${binary_uuids//$'\n'/, })"
  else
    fail "${label} binary and dSYM UUIDs differ"
  fi
}

check_entitlements() {
  local bundle="$1"
  local output="$2"
  local label="$3"

  if ! codesign -d --entitlements :- "${bundle}" > "${output}" 2>/dev/null; then
    if [[ "${REQUIRE_SIGNED}" == "1" ]]; then
      fail "${label} is signed and entitlements can be extracted"
    else
      printf 'SKIP: %s signature and entitlement validation (unsigned archive)\n' "${label}"
    fi
    return 1
  fi
  pass "${label} is signed and entitlements were extracted"
  return 0
}

printf 'WingDex archive inspection\n'
printf 'Archive: %s\n' "${ARCHIVE_PATH}"
printf 'Require signed: %s\n\n' "${REQUIRE_SIGNED}"

require_dir "${ARCHIVE_PATH}" "Archive exists"
require_file "${ARCHIVE_PATH}/Info.plist" "Archive metadata plist is present"
require_dir "${APP_PATH}" "WingDex app bundle is present"
require_dir "${EXTENSION_PATH}" "Share extension is embedded"

require_file "${APP_PATH}/Info.plist" "App Info.plist is present"
require_file "${EXTENSION_PATH}/Info.plist" "Share extension Info.plist is present"
require_file "${APP_PATH}/PrivacyInfo.xcprivacy" "Privacy manifest is embedded"
if [[ -f "${APP_PATH}/PrivacyInfo.xcprivacy" ]]; then
  if plutil -lint "${APP_PATH}/PrivacyInfo.xcprivacy"; then
    pass "Privacy manifest is valid"
  else
    fail "Privacy manifest is invalid"
  fi
fi

require_file "${APP_PATH}/Assets.car" "Compiled asset catalog is embedded"
if compgen -G "${APP_PATH}/AppIcon*.png" >/dev/null; then
  pass "Compiled app icon is embedded"
else
  fail "Compiled app icon is embedded"
fi
require_file "${APP_PATH}/taxonomy.json" "Taxonomy resource is embedded"
require_dir "${APP_PATH}/WingCLIP.mlmodelc" "Compiled WingCLIP model is embedded"
require_file "${APP_PATH}/text_classifier_int8.bin" "Bird classifier is embedded"
require_file "${APP_PATH}/occurrence.bin" "Occurrence prior is embedded"

if [[ -f "${APP_PATH}/Info.plist" ]]; then
  expect_plist_value "${APP_PATH}/Info.plist" CFBundleIdentifier app.wingdex "App bundle identifier is app.wingdex"
  expect_plist_value "${APP_PATH}/Info.plist" ITSAppUsesNonExemptEncryption false "App declares no non-exempt encryption"
fi
if [[ -f "${EXTENSION_PATH}/Info.plist" ]]; then
  expect_plist_value "${EXTENSION_PATH}/Info.plist" CFBundleIdentifier app.wingdex.share "Share extension bundle identifier is app.wingdex.share"
fi

check_dsym "${APP_PATH}/WingDex" "${APP_DSYM}" WingDex "WingDex app"
check_dsym "${EXTENSION_PATH}/WingDexShareExtension" "${EXTENSION_DSYM}" WingDexShareExtension "Share extension"

APP_ENTITLEMENTS="${EVIDENCE_DIR}/WingDex.entitlements.plist"
EXTENSION_ENTITLEMENTS="${EVIDENCE_DIR}/WingDexShareExtension.entitlements.plist"
if check_entitlements "${APP_PATH}" "${APP_ENTITLEMENTS}" "WingDex app"; then
  expect_plist_value "${APP_ENTITLEMENTS}" com.apple.security.application-groups:0 group.app.wingdex "App uses the WingDex app group"
  expect_plist_value "${APP_ENTITLEMENTS}" com.apple.developer.applesignin:0 Default "App has Sign in with Apple entitlement"
  expect_plist_value "${APP_ENTITLEMENTS}" com.apple.developer.associated-domains:0 webcredentials:wingdex.app "App has production webcredentials domain"
fi
if check_entitlements "${EXTENSION_PATH}" "${EXTENSION_ENTITLEMENTS}" "Share extension"; then
  expect_plist_value "${EXTENSION_ENTITLEMENTS}" com.apple.security.application-groups:0 group.app.wingdex "Share extension uses the WingDex app group"
fi

printf '\n'
if [[ "${failures}" -gt 0 ]]; then
  printf 'Archive inspection failed with %d error(s).\n' "${failures}"
  exit 1
fi
printf 'Archive inspection passed.\n'