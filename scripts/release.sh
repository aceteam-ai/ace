#!/bin/bash
# release.sh — Resumable release automation for @aceteam/ace
#
# Each step checks if it already completed and skips if so,
# making the script safe to re-run after partial failures.
#
# Usage:
#   ./scripts/release.sh -v v0.2.0 -y      # Non-interactive
#   ./scripts/release.sh --dry-run -v v0.2.0
#   ./scripts/release.sh -h

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

VERSION=""
AUTO_CONFIRM=false
DRY_RUN=false

print_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Resumable release automation for @aceteam/ace."
    echo "Safe to re-run — each step skips if already completed."
    echo ""
    echo "Options:"
    echo "  -v, --version VERSION   Version to release (e.g., v0.2.0)"
    echo "  -y, --yes               Auto-confirm without prompting"
    echo "  --dry-run               Show what would be done without executing"
    echo "  -h, --help              Show this help message"
    echo ""
    echo "Prerequisites:"
    echo "  pnpm login              Authenticate with npm registry"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--version) VERSION="$2"; shift 2 ;;
        -y|--yes) AUTO_CONFIRM=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) print_help; exit 0 ;;
        *) echo -e "${RED}Error: Unknown option: $1${NC}"; print_help; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Release Automation: @aceteam/ace"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}   (DRY RUN MODE)${NC}"
fi
echo ""

# --- Prerequisites ---
for cmd in gh node pnpm; do
    if ! command -v "$cmd" &> /dev/null; then
        echo -e "${RED}Error: $cmd is not installed.${NC}"
        exit 1
    fi
done

# --- Version ---
CURRENT_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
if [ -z "$VERSION" ]; then
    echo -e "${YELLOW}Current version: $CURRENT_VERSION${NC}"
    read -p "Enter new version (e.g., v0.2.0): " VERSION
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    echo -e "${RED}Error: Invalid version format (expected v0.2.0 or v0.2.0-rc1)${NC}"
    exit 1
fi

VERSION_NUM="${VERSION#v}"

# --- Change Summary ---
TAG_EXISTS=false
if git rev-parse "$VERSION" >/dev/null 2>&1; then
    TAG_EXISTS=true
    echo -e "${YELLOW}Tag $VERSION already exists — will resume from where we left off${NC}"
fi

if [ "$CURRENT_VERSION" != "v0.0.0" ] && [ "$TAG_EXISTS" != true ]; then
    COMMIT_LOG=$(git log "$CURRENT_VERSION"..HEAD --pretty=format:"- %s" --no-merges)
    COMMIT_COUNT=$(git rev-list --count "$CURRENT_VERSION"..HEAD)
else
    COMMIT_LOG=$(git log --pretty=format:"- %s" --no-merges -20)
    COMMIT_COUNT="N/A (initial release)"
fi

echo ""
echo "Release Summary:"
echo "   Version: $VERSION"
echo "   Commits: $COMMIT_COUNT"
echo ""

if [[ "$AUTO_CONFIRM" != true ]]; then
    read -p "Continue? (y/N): " -n 1 -r; echo ""
    [[ $REPLY =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 1; }
fi

# ── Step 1: Update version ──────────────────────────────────────────
echo ""
echo -e "${GREEN}Step 1/6: Update version to $VERSION_NUM${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would update package.json and src/index.ts${NC}"
else
    CURRENT_PKG_VERSION=$(node -p "require('./package.json').version")
    if [[ "$CURRENT_PKG_VERSION" != "$VERSION_NUM" ]]; then
        pnpm version "$VERSION_NUM" --no-git-tag-version
    else
        echo "package.json already at $VERSION_NUM"
    fi
    sed -i "s/\.version(\"[^\"]*\")/.version(\"$VERSION_NUM\")/" src/index.ts
    echo "Done"
fi

# ── Step 2: Build ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Step 2/6: Build TypeScript${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would run: pnpm build${NC}"
else
    pnpm build
    echo "Done"
fi

# ── Step 3: Git commit + tag + push ────────────────────────────────
echo ""
echo -e "${GREEN}Step 3/6: Git commit + tag + push${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would commit, tag $VERSION, and push${NC}"
else
    # Commit version bump if needed
    git add package.json src/index.ts
    if git diff --cached --quiet; then
        echo "No version changes to commit"
    else
        git commit -m "release: $VERSION"
    fi

    # Tag if needed
    if git rev-parse "$VERSION" >/dev/null 2>&1; then
        echo "Tag $VERSION already exists, skipping"
    else
        git tag -a "$VERSION" -m "$VERSION"
    fi

    # Push branch + tag
    git push origin "$(git branch --show-current)" 2>&1 || true
    git push origin "$VERSION" 2>&1 || true
    echo "Done"
fi

# ── Step 4: Publish to npm ──────────────────────────────────────────
echo ""
echo -e "${GREEN}Step 4/6: Publish to npm${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${BLUE}[DRY-RUN] Would run: pnpm publish --access public --no-git-checks${NC}"
else
    # Check if already published
    if npm view "@aceteam/ace@$VERSION_NUM" version >/dev/null 2>&1; then
        echo "Already published to npm, skipping"
    else
        pnpm publish --access public --no-git-checks
    fi
    echo "Done"
fi

# ── Step 5: GitHub release ──────────────────────────────────────────
echo ""
echo -e "${GREEN}Step 5/6: Create GitHub release${NC}"

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
else
    if gh release view "$VERSION" >/dev/null 2>&1; then
        echo "GitHub release $VERSION already exists, skipping"
    else
        gh release create "$VERSION" \
            --title "$VERSION" \
            --notes "$RELEASE_NOTES"
    fi
    echo "Done"
fi

# ── Step 6: Summary ─────────────────────────────────────────────────
echo ""
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${GREEN}Dry run complete${NC}"
    echo "  Run: $0 -v $VERSION -y"
else
    RELEASE_URL=$(gh release view "$VERSION" --json url -q .url 2>/dev/null || echo "N/A")
    echo -e "${GREEN}Release $VERSION complete!${NC}"
    echo ""
    echo "  GitHub: $RELEASE_URL"
    echo "  npm:    https://www.npmjs.com/package/@aceteam/ace/v/$VERSION_NUM"
fi
