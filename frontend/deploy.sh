#!/usr/bin/env bash
# Deploy the frontend to wrapsynth.com (Hostinger) over FTP/SFTP.
#
# Credentials live in frontend/.ftp-creds (gitignored), one per line:
#   HOST=ftp.wrapsynth.com
#   USER=your-hpanel-username
#   PASS=your-password
#   PORT=21            # 21 for plain FTP, 22 for SFTP
#   REMOTE_DIR=/       # path to the web root on the host
#   PROTO=ftp          # ftp | sftp
#
# Usage:  ./deploy.sh          # sync local frontend/ to the live site
set -euo pipefail

cd "$(dirname "$0")"
CREDS=.ftp-creds
LOCAL_DIR=.

if [ ! -f "$CREDS" ]; then
    echo "Missing $CREDS — create it from the header of deploy.sh (HOST/USER/PASS/...)." >&2
    exit 1
fi
# shellcheck disable=SC1090
source "$CREDS"

if [ -z "${HOST:-}" ] || [ -z "${USER:-}" ] || [ -z "${PASS:-}" ]; then
    echo "Incomplete $CREDS — need HOST, USER, PASS." >&2
    exit 1
fi
PROTO="${PROTO:-ftp}"
PORT="${PORT:-21}"
REMOTE_DIR="${REMOTE_DIR:-/}"

if ! command -v lftp >/dev/null 2>&1; then
    echo "lftp is required (sudo apt install lftp / brew install lftp)." >&2
    exit 1
fi

echo "Deploying frontend/ → ${PROTO}://${HOST}:${PORT}${REMOTE_DIR}"

if [ "$PROTO" = "sftp" ]; then
    # SFTP: lftp speaks it natively; sftp:// URLs keep the password auth path.
    LFTP_URL="sftp://${USER}:${PASS}@${HOST}:${PORT}"
else
    LFTP_URL="ftp://${USER}:${PASS}@${HOST}:${PORT}"
fi

# Exclude: secrets, local deploy config, dev artifacts, legacy manifests.
EXCLUDES=(--exclude='.ftp-creds' --exclude='deploy.sh' --exclude='node_modules'
          --exclude='.git' --exclude='*.log' --exclude='deployment.json'
          --exclude='deployment.gnosis.json' --exclude='deployment.hyperevm-legacy.json')

lftp -e "set net:timeout 15; set ftp:ssl-force false; mirror --reverse --delete --verbose ${EXCLUDES[*]} $LOCAL_DIR $REMOTE_DIR; bye" "$LFTP_URL"

echo "Deploy complete."