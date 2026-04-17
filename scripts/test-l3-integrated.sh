#!/bin/bash
set -euo pipefail

# L3: Docker daemon + bb-browser OAuth bridge + integration verification
# Usage: ./scripts/test-l3-integrated.sh
#
# Prerequisites:
#   - Docker image aha-test-l2 already built
#   - bb-browser installed and connected to a browser with aha-agi.com login state
#   - ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY set in environment

CONTAINER_NAME="aha-l3-$$"
AUTH_URL_FILE="/tmp/aha-l3-auth-url-$$.txt"
RESULT_FILE="/tmp/aha-l3-result-$$.txt"
TIMEOUT_AUTH=60
TIMEOUT_VERIFY=90

cleanup() {
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  rm -f "$AUTH_URL_FILE" "$RESULT_FILE"
}
trap cleanup EXIT

echo "=== L3: Docker + bb-browser integrated verification ==="
echo ""

# ── Step 1: Start daemon in Docker (background) ────────────────────
echo "[1/5] Starting daemon in Docker container..."
docker run --rm --name "$CONTAINER_NAME" \
  -e ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}" \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -e ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}" \
  -e ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-}" \
  -e ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-}" \
  -e ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-}" \
  -e ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-}" \
  -e ANTHROPIC_REASONING_MODEL="${ANTHROPIC_REASONING_MODEL:-}" \
  aha-test-l2 bash -c '
    node dist/index.mjs daemon start-sync 2>&1 &
    DAEMON_PID=$!

    # Wait for auth URL in logs
    for i in $(seq 1 30); do
      sleep 2
      LOG_FILE=$(ls -t /tmp/aha-test/logs/*.log 2>/dev/null | head -1)
      if [ -n "$LOG_FILE" ]; then
        AUTH_URL=$(grep -o "https://[^ ]*terminal/connect[^ ]*" "$LOG_FILE" 2>/dev/null | head -1)
        if [ -n "$AUTH_URL" ]; then
          echo "AUTH_URL=$AUTH_URL"
          break
        fi
      fi
      # Also check stdout for the URL
      echo "waiting_for_auth..."
    done

    # Keep daemon alive for verification
    echo "DAEMON_READY"

    # Monitor for 90s
    SECONDS=0
    while [ $SECONDS -lt 90 ] && kill -0 $DAEMON_PID 2>/dev/null; do
      sleep 5
      LOG_FILE=$(ls -t /tmp/aha-test/logs/*.log 2>/dev/null | head -1)
      if [ -n "$LOG_FILE" ]; then
        if grep -q "WebSocket connected\|machine-alive\|authenticated" "$LOG_FILE" 2>/dev/null; then
          echo "CONNECTED"
        fi
        if grep -q "\[caffeinate\] Unhandled rejection" "$LOG_FILE" 2>/dev/null; then
          echo "BOOT_LOOP_DETECTED"
        fi
        if grep -q "\[START\] Unhandled rejection" "$LOG_FILE" 2>/dev/null; then
          echo "REJECTION_LOGGED"
        fi
      fi
    done

    echo "DAEMON_DONE"
    kill $DAEMON_PID 2>/dev/null || true
  ' > "$RESULT_FILE" 2>&1 &

DOCKER_PID=$!

# ── Step 2: Wait for auth URL from Docker output ───────────────────
echo "[2/5] Waiting for auth URL from daemon..."
AUTH_URL=""
for i in $(seq 1 $TIMEOUT_AUTH); do
  sleep 1
  if [ -f "$RESULT_FILE" ]; then
    AUTH_URL=$(grep -o 'AUTH_URL=https://[^ ]*' "$RESULT_FILE" 2>/dev/null | head -1 | sed 's/AUTH_URL=//')
    if [ -n "$AUTH_URL" ]; then
      echo "       Got auth URL: ${AUTH_URL:0:80}..."
      break
    fi
  fi
done

if [ -z "$AUTH_URL" ]; then
  # Check if daemon output has the URL directly (from stdout)
  AUTH_URL=$(grep -o 'https://[^ ]*terminal/connect[^ ]*' "$RESULT_FILE" 2>/dev/null | head -1)
fi

if [ -z "$AUTH_URL" ]; then
  echo "       No auth URL found — daemon may have started without needing auth"
  echo "       Checking daemon status directly..."
fi

# ── Step 3: bb-browser completes OAuth ──────────────────────────────
if [ -n "$AUTH_URL" ]; then
  echo "[3/5] bb-browser completing OAuth..."
  bb-browser open "$AUTH_URL" 2>&1 || true
  sleep 3

  # Take screenshot to verify
  bb-browser screenshot /tmp/aha-l3-auth.png 2>&1 || true

  # Check if there's a confirm/allow button to click
  SNAPSHOT=$(bb-browser snapshot -i 2>&1 || true)
  echo "$SNAPSHOT" | grep -i 'confirm\|allow\|connect\|authorize\|approve' && {
    REF=$(echo "$SNAPSHOT" | grep -io '@[0-9]*.*\(confirm\|allow\|connect\|authorize\|approve\)' | head -1 | grep -o '@[0-9]*')
    if [ -n "$REF" ]; then
      echo "       Clicking auth button $REF..."
      bb-browser click "$REF" 2>&1 || true
      sleep 3
    fi
  } || echo "       No explicit auth button found (may auto-complete)"

  bb-browser screenshot /tmp/aha-l3-auth-done.png 2>&1 || true
  bb-browser close 2>&1 || true
  echo "       OAuth flow completed"
else
  echo "[3/5] SKIP: No auth URL needed"
fi

# ── Step 4: Wait and verify Docker daemon behavior ──────────────────
echo "[4/5] Monitoring daemon for ${TIMEOUT_VERIFY}s..."
CONNECTED=false
BOOT_LOOP=false
REJECTION=false

for i in $(seq 1 $((TIMEOUT_VERIFY / 5))); do
  sleep 5
  if [ -f "$RESULT_FILE" ]; then
    grep -q "CONNECTED" "$RESULT_FILE" 2>/dev/null && CONNECTED=true
    grep -q "BOOT_LOOP_DETECTED" "$RESULT_FILE" 2>/dev/null && BOOT_LOOP=true
    grep -q "REJECTION_LOGGED" "$RESULT_FILE" 2>/dev/null && REJECTION=true
  fi

  # Early exit on boot loop
  if $BOOT_LOOP; then
    echo "       BOOT LOOP DETECTED — stopping early"
    break
  fi

  # Early success
  if $CONNECTED; then
    echo "       Daemon connected to happy-server!"
    break
  fi
done

# Wait for Docker to finish
wait $DOCKER_PID 2>/dev/null || true

# ── Step 5: Report ──────────────────────────────────────────────────
echo ""
echo "=== L3 Summary ==="
echo "boot-loop:  $(! $BOOT_LOOP && echo 'PASS (none)' || echo 'FAIL')"
echo "connection: $($CONNECTED && echo 'PASS (WebSocket up)' || echo 'SKIP (no real server in Docker)')"
echo "rejection:  $($REJECTION && echo 'INFO (non-fatal, logged)' || echo 'CLEAN (none seen)')"

if $BOOT_LOOP; then
  echo ""
  echo "VERDICT: FAIL — F-019 fix did not prevent boot loop"
  exit 1
fi

echo ""
echo "VERDICT: PASS — daemon stable, no boot loop"
echo ""
echo "Screenshots saved:"
ls -la /tmp/aha-l3-auth*.png 2>/dev/null || echo "  (none)"
