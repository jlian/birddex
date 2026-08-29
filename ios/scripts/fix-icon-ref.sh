#!/bin/bash
# Post-xcodegen script: inject AppIcon.icon as a proper file reference.
# xcodegen doesn't understand the Xcode 26 .icon (Icon Composer) bundle format.
# We exclude it from xcodegen entirely and inject the correct pbxproj entries here.

set -euo pipefail

PBXPROJ="WingDex.xcodeproj/project.pbxproj"

if [[ ! -f "$PBXPROJ" ]]; then
  echo "Error: $PBXPROJ not found" >&2
  exit 1
fi

# Simulator tests do not inspect the home-screen icon. Icon Composer took almost
# two minutes on the hosted runner, so CI generates a test-only project without
# injecting the .icon bundle. Normal local generation and release archives keep
# the production resource.
if [[ "${WINGDEX_SKIP_APP_ICON:-}" == "1" ]]; then
    echo "Skipping AppIcon.icon injection for the CI simulator build"
    exit 0
fi

python3 << 'PYEOF'
import re, sys

pbxproj = "WingDex.xcodeproj/project.pbxproj"
with open(pbxproj, "r") as f:
    content = f.read()

# Skip if already patched
if "AppIcon.icon" in content and "PBXFileReference" in content and "folder.icon" in content:
    print("AppIcon.icon already patched - skipping")
    sys.exit(0)

# Fixed UUIDs for deterministic output
FILE_REF_UUID = "A1B2C3D4E5F6A7B8C9D0E1F2"
BUILD_FILE_UUID = "F2E1D0C9B8A7F6E5D4C3B2A1"

# 1. Remove any existing PBXGroup entry for AppIcon.icon (from partial xcodegen)
group_pattern = r'\s*\w+ /\* AppIcon\.icon \*/ = \{\s*isa = PBXGroup;[^}]*path = AppIcon\.icon;[^}]*\};'
content = re.sub(group_pattern, '', content, flags=re.DOTALL)

# 2. Add PBXFileReference
file_ref = f'\t\t{FILE_REF_UUID} /* AppIcon.icon */ = {{isa = PBXFileReference; lastKnownFileType = folder.icon; path = AppIcon.icon; sourceTree = "<group>"; }};'
content = content.replace(
    '/* Begin PBXFileReference section */',
    '/* Begin PBXFileReference section */\n' + file_ref
)

# 3. Add PBXBuildFile
build_file = f'\t\t{BUILD_FILE_UUID} /* AppIcon.icon in Resources */ = {{isa = PBXBuildFile; fileRef = {FILE_REF_UUID} /* AppIcon.icon */; }};'
content = content.replace(
    '/* Begin PBXBuildFile section */',
    '/* Begin PBXBuildFile section */\n' + build_file
)

# 4. Add to Resources build phase
res_match = re.search(r'(/\* Begin PBXResourcesBuildPhase section \*/.*?files = \(\s*)', content, re.DOTALL)
if res_match:
    insert_point = res_match.end()
    content = content[:insert_point] + f'\t\t\t\t{BUILD_FILE_UUID} /* AppIcon.icon in Resources */,\n' + content[insert_point:]

# 5. Add to the Resources group so it shows up in the project navigator
res_group = re.search(r'(/\* Resources \*/ = \{\s*isa = PBXGroup;\s*children = \(\s*)', content, re.DOTALL)
if res_group:
    insert_point = res_group.end()
    content = content[:insert_point] + f'\t\t\t\t{FILE_REF_UUID} /* AppIcon.icon */,\n' + content[insert_point:]

with open(pbxproj, "w") as f:
    f.write(content)

print("Injected AppIcon.icon as PBXFileReference (folder.icon) + Resources build phase")
PYEOF
