#!/bin/sh
# Builds and deploys to Vercel from a clean copy without .git, so Vercel doesn't check the git commit author
# against the team (fails when commits use a different e-mail than the Vercel account).
#   sh scripts/vercel-deploy.sh            (needs `npx vercel login` once, or VERCEL_TOKEN in the environment)
set -e
cd "$(dirname "$0")/.."
npm run build:cloud
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
rsync -a --exclude .git --exclude node_modules --exclude data --exclude '.env' ./ "$tmp/"
cd "$tmp"
npx -y vercel@latest deploy --prod --yes ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"}
