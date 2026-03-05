#!/usr/bin/env bash
# End-to-end smoke tests for the ace CLI.
# Requires: OPENAI_API_KEY (or source ../aceteam/.env)
set -euo pipefail

ACE="node $(dirname "$0")/../dist/index.js"
PASS=0
FAIL=0
FAILURES=()

# ── Helpers ──────────────────────────────────────────────────

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

run_test() {
  local name="$1"; shift
  printf "  %-40s " "$name"
  if output=$("$@" 2>&1); then
    green "✓"
    PASS=$((PASS + 1))
  else
    red "✗"
    FAILURES+=("$name")
    dim "    $output" | head -5
    FAIL=$((FAIL + 1))
  fi
}

# Check output contains a string
assert_contains() {
  local name="$1" expected="$2"; shift 2
  printf "  %-40s " "$name"
  if output=$("$@" 2>&1) && echo "$output" | grep -qF -- "$expected"; then
    green "✓"
    PASS=$((PASS + 1))
  else
    red "✗"
    FAILURES+=("$name")
    dim "    expected to contain: $expected"
    FAIL=$((FAIL + 1))
  fi
}

# Check command fails (non-zero exit)
assert_fails() {
  local name="$1"; shift
  printf "  %-40s " "$name"
  if output=$("$@" 2>&1); then
    red "✗ (expected failure, got success)"
    FAILURES+=("$name")
    FAIL=$((FAIL + 1))
  else
    green "✓"
    PASS=$((PASS + 1))
  fi
}

# ── Load API key ─────────────────────────────────────────────

if [ -z "${OPENAI_API_KEY:-}" ]; then
  ENV_FILE="$(dirname "$0")/../../aceteam/.env"
  if [ -f "$ENV_FILE" ]; then
    OPENAI_API_KEY=$(grep '^OPENAI_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    export OPENAI_API_KEY
  fi
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  red "ERROR: OPENAI_API_KEY not set and ../aceteam/.env not found"
  exit 1
fi

# ── Build ────────────────────────────────────────────────────

echo ""
echo "Building..."
(cd "$(dirname "$0")/.." && pnpm build --silent 2>&1) || { red "Build failed"; exit 1; }
echo ""

# ── CLI basics ───────────────────────────────────────────────

echo "CLI basics"
assert_contains "ace --version"          "0."            $ACE --version
assert_contains "ace --help shows run"   "run"           $ACE --help
assert_contains "ace --help shows login" "login"         $ACE --help
assert_contains "ace run --help"         "--input"       $ACE run --help
assert_contains "ace login --help"       "--api-key"     $ACE login --help
assert_contains "ace workflow --help"    "validate"      $ACE workflow --help
echo ""

# ── Task listing ─────────────────────────────────────────────

echo "Task listing"
assert_contains "ace run --list"         "summarize"     $ACE run --list
assert_contains "ace run --info"         "Summarize"     $ACE run --info summarize
echo ""

# ── Task execution (LLM) ────────────────────────────────────

echo "Task execution"
assert_contains "ace run summarize (pipe)" "Summary" \
  bash -c "echo 'The Eiffel Tower is a wrought-iron lattice tower in Paris, France.' | $ACE run summarize"

assert_contains "ace run summarize (inline)" "Summary" \
  $ACE run summarize "The Eiffel Tower is a wrought-iron lattice tower in Paris, France."
echo ""

# ── Workflow validation ──────────────────────────────────────

echo "Workflow validation"
assert_contains "validate example workflow" "Valid workflow" \
  $ACE workflow validate examples/extraction-workflow.json

# Invalid JSON
TMPFILE=$(mktemp /tmp/ace-e2e-XXXXXX.json)
echo "not json" > "$TMPFILE"
assert_fails "reject invalid JSON" \
  $ACE workflow validate "$TMPFILE"

# Valid JSON, bad schema
echo '{"foo": "bar"}' > "$TMPFILE"
assert_fails "reject bad schema" \
  $ACE workflow validate "$TMPFILE"
rm -f "$TMPFILE"
echo ""

# ── Workflow execution (LLM) ────────────────────────────────

echo "Workflow execution"
assert_contains "ace run extraction workflow" "entities" \
  $ACE run examples/extraction-workflow.json \
    --input "text=Marie Curie worked at the University of Paris in France."
echo ""

# ── Node listing ─────────────────────────────────────────────

echo "Node listing"
assert_contains "ace workflow list-nodes" "LLM" \
  $ACE workflow list-nodes

assert_contains "ace workflow list-templates" "hello-llm" \
  $ACE workflow list-templates
echo ""

# ── Error handling ───────────────────────────────────────────

echo "Error handling"
assert_fails "reject nonexistent task" \
  $ACE run nonexistent-task-xyz "hello"

assert_fails "reject nonexistent workflow file" \
  $ACE run /tmp/does-not-exist.json --input text=hello
echo ""

# ── Results ──────────────────────────────────────────────────

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  green "All $PASS tests passed"
else
  red "$FAIL failed, $PASS passed"
  echo ""
  for f in "${FAILURES[@]}"; do
    red "  FAIL: $f"
  done
  exit 1
fi
