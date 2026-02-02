#!/bin/bash
# release.sh
# Automates the complete release process for @aceteam/ace:
# - Updates version in package.json and src/index.ts
# - Builds the TypeScript project
# - Creates and pushes a git tag
# - Publishes to npm
# - Creates a GitHub release
#
# Usage:
#   ./release.sh                              # Interactive mode
#   ./release.sh -v v0.2.0 -y                 # Non-interactive with version
#   ./release.sh --dry-run -v v0.2.0          # Dry run (no git/gh/publish commands)

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Default Values ---
VERSION=""
AUTO_CONFIRM=false
DRY_RUN=false

# --- Parse Arguments ---
print_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Automates the complete release process for @aceteam/ace."
    echo ""
    echo "Options:"
    echo "  -v, --version VERSION   Version to release (e.g., v0.2.0)"
    echo "  -y, --yes               Auto-confirm without prompting"
    echo "  --dry-run               Show what would be done without executing"
    echo "  -h, --help              Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Interactive mode"
    echo "  $0 -v v0.2.0 -y                       # Non-interactive release"
    echo "  $0 --dry-run -v v0.2.0                # Preview without executing"
    echo ""
    echo "Prerequisites:"
    echo "  npm login                             # Authenticate with npm registry"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--version)
            VERSION="$2"
            shift 2
            ;;
        -y|--yes)
            AUTO_CONFIRM=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Unknown option: $1${NC}"
            print_help
            exit 1
            ;;
    esac
done

# --- Helper Functions ---
run_cmd() {
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "${BLUE}[DRY-RUN] Would execute: $*${NC}"
    else
        "$@"
    fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Release Automation: @aceteam/ace"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}   (DRY RUN MODE - no changes will be made)${NC}"
fi
echo ""

# --- Check Prerequisites ---
for cmd in gh node pnpm npm; do
    if ! command -v "$cmd" &> /dev/null; then
        echo -e "${RED}Error: $cmd is not installed.${NC}"
        exit 1
    fi
done

# Check clean working directory
if [[ -n $(git status -s) ]]; then
    echo -e "${RED}Error: Working directory is not clean.${NC}"
    echo "Please commit or stash your changes before releasing."
    git status -s
    exit 1
fi

# Get version from argument or prompt
CURRENT_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
if [ -z "$VERSION" ]; then
    echo -e "${YELLOW}Current version: $CURRENT_VERSION${NC}"
    echo ""
    read -p "Enter new version (e.g., v0.2.0): " VERSION
fi

# Validate version format
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    echo -e "${RED}Error: Invalid version format.${NC}"
    echo "Version must be in format: v0.2.0 or v0.2.0-rc1"
    exit 1
fi

# Strip 'v' prefix for package version strings
VERSION_NUM="${VERSION#v}"

# Check if tag already exists
if git rev-parse "$VERSION" >/dev/null 2>&1; then
    echo -e "${RED}Error: Tag $VERSION already exists.${NC}"
    exit 1
fi

# --- Generate Change Summary ---
echo ""
echo -e "${GREEN}Analyzing changes since $CURRENT_VERSION...${NC}"

if [ "$CURRENT_VERSION" != "v0.0.0" ]; then
    COMMIT_LOG=$(git log "$CURRENT_VERSION"..HEAD --pretty=format:"- %s" --no-merges)
    COMMIT_COUNT=$(git rev-list --count "$CURRENT_VERSION"..HEAD)
else
    COMMIT_LOG=$(git log --pretty=format:"- %s" --no-merges -20)
    COMMIT_COUNT="N/A (initial release)"
fi

echo ""
echo "Release Summary:"
echo "   Version: $VERSION (from $CURRENT_VERSION)"
echo "   Branch: $(git branch --show-current)"
echo "   Commit: $(git rev-parse --short HEAD)"
echo "   Changes: $COMMIT_COUNT commits"
echo ""
echo "   Commits:"
echo "$COMMIT_LOG" | head -10 | sed 's/^/      /'
if [ "$(echo "$COMMIT_LOG" | wc -l)" -gt 10 ]; then
    echo "      ... and more"
fi
echo ""

if [[ "$AUTO_CONFIRM" != true ]]; then
    read -p "Continue with release? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Release cancelled."
        exit 1
    fi
fi

# Step 1: Update version numbers
echo ""
echo -e "${GREEN}Step 1/6: Updating version to $VERSION_NUM${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would update package.json version to $VERSION_NUM${NC}"
    echo -e "${BLUE}[DRY-RUN] Would update src/index.ts .version() to $VERSION_NUM${NC}"
else
    CURRENT_PKG_VERSION=$(node -p "require('./package.json').version")
    if [[ "$CURRENT_PKG_VERSION" != "$VERSION_NUM" ]]; then
        pnpm version "$VERSION_NUM" --no-git-tag-version
    else
        echo "package.json already at $VERSION_NUM"
    fi
    sed -i "s/\.version(\"[^\"]*\")/.version(\"$VERSION_NUM\")/" src/index.ts
fi
echo "Done"

# Step 2: Build
echo ""
echo -e "${GREEN}Step 2/6: Building TypeScript${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would execute: pnpm build${NC}"
else
    pnpm build
fi
echo "Done"

# Step 3: Git commit + tag + push
echo ""
echo -e "${GREEN}Step 3/6: Creating git commit and tag${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would commit version bump and create tag $VERSION${NC}"
else
    git add package.json src/index.ts
    # Commit only if there are staged changes (version might already be set)
    if git diff --cached --quiet; then
        echo "Version already at $VERSION_NUM, no commit needed"
    else
        git commit -m "release: $VERSION"
    fi
    git tag -a "$VERSION" -m "$VERSION"
    git push origin "$(git branch --show-current)"
    git push origin "$VERSION"
fi
echo "Done"

# Step 4: Publish to npm
echo ""
echo -e "${GREEN}Step 4/6: Publishing to npm${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would execute: pnpm publish --access public --no-git-checks${NC}"
else
    pnpm publish --access public --no-git-checks
fi
echo "Done"

# Step 5: Create GitHub release
echo ""
echo -e "${GREEN}Step 5/6: Creating GitHub release${NC}"

RELEASE_NOTES="## What's New

$COMMIT_LOG

## Installation

\`\`\`bash
npm install -g @aceteam/ace@$VERSION_NUM
\`\`\`

Or run without installing:

\`\`\`bash
npx @aceteam/ace@$VERSION_NUM
\`\`\`

## Links

- [npm](https://www.npmjs.com/package/@aceteam/ace/v/$VERSION_NUM)
- [Documentation](https://github.com/aceteam-ai/ace#readme)"

if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would create GitHub release${NC}"
    echo ""
    echo "Release notes preview:"
    echo "----------------------------------------"
    echo "$RELEASE_NOTES" | head -20
    echo "..."
    echo "----------------------------------------"
else
    gh release create "$VERSION" \
        --title "$VERSION" \
        --notes "$RELEASE_NOTES"
fi
echo "Done"

# Step 6: Summary
echo ""
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${GREEN}Dry run complete - no changes were made${NC}"
    echo ""
    echo "To perform the actual release, run:"
    echo "  $0 -v $VERSION -y"
else
    RELEASE_URL=$(gh release view "$VERSION" --json url -q .url)
    echo -e "${GREEN}Release $VERSION published successfully!${NC}"
    echo ""
    echo "Release URL: $RELEASE_URL"
    echo "npm: https://www.npmjs.com/package/@aceteam/ace/v/$VERSION_NUM"
    echo ""
    echo "Next steps:"
    echo "  1. Verify the npm page"
    echo "  2. Test install: npm install -g @aceteam/ace@$VERSION_NUM"
fi
