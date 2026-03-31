#!/bin/sh
set -eu

AHA_HOME_DIR="${AHA_HOME_DIR:-/home/node/.aha-v12}"
AHA_HOME_COMPAT_DIR="${AHA_HOME_COMPAT_DIR:-/home/node/.aha-v11}"
mkdir -p "$AHA_HOME_DIR"

maybe_decode_b64_file() {
    var_name="$1"
    target_path="$2"
    value="$(printenv "$var_name" || true)"

    if [ -n "$value" ] && [ ! -f "$target_path" ]; then
        printf '%s' "$value" | base64 -d > "$target_path"
        echo "[aha-cli-entrypoint] Wrote $(basename "$target_path") from $var_name"
    fi
}

maybe_seed_legacy_file() {
    filename="$1"
    target_path="$AHA_HOME_DIR/$filename"
    source_path="$AHA_HOME_COMPAT_DIR/$filename"

    if [ "$AHA_HOME_COMPAT_DIR" != "$AHA_HOME_DIR" ] && [ ! -f "$target_path" ] && [ -f "$source_path" ]; then
        cp "$source_path" "$target_path"
        echo "[aha-cli-entrypoint] Seeded $filename from $AHA_HOME_COMPAT_DIR"
    fi
}

maybe_decode_b64_file "AHA_CREDENTIALS_JSON_B64" "$AHA_HOME_DIR/access.key"
maybe_decode_b64_file "AHA_CONFIG_JSON_B64" "$AHA_HOME_DIR/config.json"
maybe_decode_b64_file "AHA_SETTINGS_JSON_B64" "$AHA_HOME_DIR/settings.json"

maybe_seed_legacy_file "access.key"
maybe_seed_legacy_file "config.json"
maybe_seed_legacy_file "settings.json"

if [ ! -f "$AHA_HOME_DIR/access.key" ]; then
    echo "[aha-cli-entrypoint] Missing $AHA_HOME_DIR/access.key" >&2
    echo "[aha-cli-entrypoint] Mount a populated AHA_HOME_DIR volume or provide AHA_CREDENTIALS_JSON_B64 (base64 of access.key JSON)." >&2
    exit 1
fi

exec "$@"
