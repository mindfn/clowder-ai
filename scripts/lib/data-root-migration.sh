#!/usr/bin/env bash

cat_cafe_absolute_path() {
    local path="$1"
    local -a parts
    local -a normalized=()
    local part

    case "$path" in
        /*) ;;
        *) path="$PWD/$path" ;;
    esac

    IFS='/' read -r -a parts <<< "$path"
    for part in "${parts[@]}"; do
        case "$part" in
            ""|.) continue ;;
            ..)
                if [ "${#normalized[@]}" -gt 0 ]; then
                    unset "normalized[$((${#normalized[@]} - 1))]"
                fi
                ;;
            *) normalized+=("$part") ;;
        esac
    done

    if [ "${#normalized[@]}" -eq 0 ]; then
        printf '/'
    else
        local IFS='/'
        printf '/%s' "${normalized[*]}"
    fi
}

cat_cafe_dir_has_entries() {
    local dir="$1"
    [ -d "$dir" ] && find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .
}

cat_cafe_migrate_data_root_dir_or_abort() {
    local label="$1"
    local legacy_dir="$2"
    local target_dir="$3"

    [ "$legacy_dir" != "$target_dir" ] || return 0
    cat_cafe_dir_has_entries "$legacy_dir" || return 0

    if [ -d "$target_dir" ]; then
        if cat_cafe_dir_has_entries "$target_dir"; then
            echo "  [#671] Refusing to switch ${label} to DATA_DIR because both legacy and target contain data." >&2
            echo "        legacy: $legacy_dir" >&2
            echo "        target: $target_dir" >&2
            exit 1
        fi
        rmdir "$target_dir" 2>/dev/null || {
            echo "  [#671] Refusing to switch ${label} to DATA_DIR because the empty target could not be removed: $target_dir" >&2
            exit 1
        }
    fi

    echo "  [#671] Migrating ${label}: $legacy_dir -> $target_dir"
    mkdir -p "$(dirname "$target_dir")"
    mv "$legacy_dir" "$target_dir" 2>/dev/null || {
        cp -a "$legacy_dir" "$target_dir" && rm -rf "$legacy_dir"
    } || {
        echo "  [#671] Failed to migrate ${label}: $legacy_dir -> $target_dir" >&2
        exit 1
    }
}
