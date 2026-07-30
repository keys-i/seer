#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

branch=$(git branch --show-current)
[[ $branch == automation ]] || { echo "Run this once on the automation branch." >&2; exit 1; }
[[ $(git rev-parse HEAD) == 4adc91c0ecd2c5afb29a47c39b67b3eec6a83a29 ]] || { echo "Unexpected or partially committed base." >&2; exit 1; }
[[ $(git remote get-url origin) == https://github.com/keys-i/seer.git ]] || { echo "Unexpected origin repository." >&2; exit 1; }
git diff --cached --quiet || { echo "Refusing to mix pre-staged changes." >&2; exit 1; }
for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-apply rebase-merge BISECT_LOG; do
  [[ ! -e $(git rev-parse --git-path "$state") ]] || { echo "Finish the current Git operation first." >&2; exit 1; }
done
expected_alias='!f() { d="$1"; shift; GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git commit --date="$d" "$@"; }; f'
[[ $(git config --get alias.bkcommit) == "$expected_alias" ]] || { echo "Unexpected git bkcommit implementation." >&2; exit 1; }
[[ $(git config --get gpg.format) == ssh ]] || { echo "This helper requires Git SSH signing." >&2; exit 1; }
ssh_program=$(git config --get gpg.ssh.program || true)
[[ -z $ssh_program || $ssh_program == ssh-keygen || $ssh_program == /usr/bin/ssh-keygen ]] || { echo "Unexpected Git signing program." >&2; exit 1; }

public_key=$(git config --get user.signingkey)
[[ $public_key == *.pub && -r $public_key && -r ${public_key%.pub} ]] || { echo "Git signing key is unavailable." >&2; exit 1; }
fingerprint=$(ssh-keygen -lf "$public_key" | awk '{print $2}')
[[ $fingerprint == SHA256:G77AMCruPe0O0qZHMEQX4DkIkoDlPhMl6F2ZTOHMaFc ]] || { echo "Unexpected Git signing key." >&2; exit 1; }
commit_day=$(node -e "const d=new Date();d.setDate(d.getDate()-1);process.stdout.write([d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'))")
agent_status=0
ssh-add -l >/dev/null 2>&1 || agent_status=$?
(( agent_status != 2 )) || { echo "Start ssh-agent before committing." >&2; exit 1; }
added_key=false
cleanup() { $added_key && ssh-add -d "$public_key" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if ! ssh-add -l 2>/dev/null | grep -Fq "$fingerprint"; then
  ssh-add "${public_key%.pub}"
  added_key=true
fi

commit() {
  local timestamp=$1 message=$2
  shift 2
  git add -- "$@"
  ! git diff --cached --quiet || { echo "No changes for: $message" >&2; exit 1; }
  git bkcommit "$timestamp" -S -m "$message"
}

commit "$commit_day 03:00:00" "ci: harden checks and security" \
  .github/workflows/ci.yml .github/workflows/checks.yml .github/workflows/security.yml
commit "$commit_day 03:05:00" "ci: automate releases" .github/workflows/release.yml
commit "$commit_day 03:10:00" "ci: publish the demo" .github/workflows/publish.yml
commit "$commit_day 03:15:00" "chore: add progressive commit helper" commit.sh
