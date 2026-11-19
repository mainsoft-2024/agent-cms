#!/usr/bin/env bash
# A local S3-compatible server for tests, CI and the example app.
#
#   bash scripts/s3-dev.sh            start in the background, then return
#   bash scripts/s3-dev.sh --stop     stop it
#
# Address http://127.0.0.1:9100 (S3_PORT), access key "test", secret
# "testsecret1", buckets "media" and "private". Files are kept in
# $S3_DIR (default: a folder under the system temp directory).
#
# The server is versitygw (Apache-2.0), one binary that serves a folder over
# the S3 API. It is downloaded once from its GitHub release.
set -euo pipefail

VERSION="1.11.0"
PORT="${S3_PORT:-9100}"
DIR="${S3_DIR:-${TMPDIR:-/tmp}/agent-cms-s3}"
BIN="$DIR/versitygw-$VERSION"
PID="$DIR/server.pid"

if [ "${1:-}" = "--stop" ]; then
  [ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null || true
  rm -f "$PID"
  exit 0
fi

if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "[s3-dev] already running on http://127.0.0.1:$PORT"
  exit 0
fi

mkdir -p "$DIR/data/media" "$DIR/data/private"
if [ ! -x "$BIN" ]; then
  case "$(uname -s)" in Linux) OS=Linux ;; Darwin) OS=Darwin ;; *) echo "[s3-dev] unsupported system: $(uname -s)" >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64 | amd64) ARCH=x86_64 ;; arm64 | aarch64) ARCH=arm64 ;; *) echo "[s3-dev] unsupported machine: $(uname -m)" >&2; exit 1 ;; esac
  NAME="versitygw_v${VERSION}_${OS}_${ARCH}"
  echo "[s3-dev] downloading $NAME"
  curl -sSfL -o "$DIR/gw.tgz" "https://github.com/versity/versitygw/releases/download/v${VERSION}/${NAME}.tar.gz"
  tar xzf "$DIR/gw.tgz" -C "$DIR"
  mv "$DIR/$NAME/versitygw" "$BIN"
  rm -rf "$DIR/gw.tgz" "${DIR:?}/$NAME"
fi

# Any origin may upload: this server is for local use only.
nohup "$BIN" --access test --secret testsecret1 --port "127.0.0.1:$PORT" --cors-allow-origin "*" posix "$DIR/data" >"$DIR/server.log" 2>&1 &
echo $! >"$PID"
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "[s3-dev] http://127.0.0.1:$PORT (key test / testsecret1, buckets media and private)"
    exit 0
  fi
  sleep 0.25
done
echo "[s3-dev] the server did not start; see $DIR/server.log" >&2
exit 1
