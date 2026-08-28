#!/usr/bin/env bash
#
# Where am I, and what has the other person done?
#
#   npm run status
#
# Two people work on this from separate machines, so the state that matters is
# spread across four places: your working tree, your branch, main on GitHub,
# and any open pull requests. This gathers all of it into one screen so you
# don't have to remember which command answers which question.
#
# Read-only. It fetches, but never merges, pulls or changes a branch.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
RED=$'\033[31m'; BLUE=$'\033[34m'; RESET=$'\033[0m'

command -v gh >/dev/null 2>&1 && HAS_GH=1 || HAS_GH=0

printf '\n%sFetching…%s' "$DIM" "$RESET"
git fetch --quiet --prune 2>/dev/null
printf '\r          \r'

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"

echo ""
echo "${BOLD}You${RESET}"
echo "  branch:  ${BOLD}${BRANCH}${RESET}"

if [[ "$DIRTY" -gt 0 ]]; then
  echo "  changes: ${YELLOW}${DIRTY} uncommitted file(s)${RESET}  ${DIM}git status${RESET}"
  git status --porcelain | head -5 | sed "s/^/           ${DIM}/;s/$/${RESET}/"
  [[ "$DIRTY" -gt 5 ]] && echo "           ${DIM}…and $((DIRTY - 5)) more${RESET}"
else
  echo "  changes: ${GREEN}working tree clean${RESET}"
fi

# How this branch sits against main.
if git rev-parse --verify --quiet origin/main >/dev/null; then
  AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
  BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"

  if [[ "$BRANCH" == "main" ]]; then
    [[ "$AHEAD" -gt 0 ]] && echo "  ${YELLOW}${AHEAD} commit(s) on your main that aren't pushed${RESET}  ${DIM}(put them on a branch)${RESET}"
  else
    echo "  vs main: ${AHEAD} ahead, ${BEHIND} behind"
    if [[ "$AHEAD" -gt 0 ]]; then
      echo "  ${DIM}your work on this branch:${RESET}"
      git log --oneline origin/main..HEAD | head -6 | sed "s/^/           /"
    fi
    [[ "$BEHIND" -gt 0 ]] && \
      echo "  ${YELLOW}main has moved on${RESET} — ${DIM}git pull --rebase origin main${RESET}"
  fi
fi

# What landed on main that you haven't got locally.
echo ""
echo "${BOLD}Main${RESET}"
NEW="$(git rev-list --count main..origin/main 2>/dev/null || echo 0)"
if [[ "$NEW" -gt 0 ]]; then
  echo "  ${YELLOW}${NEW} new commit(s) on GitHub you don't have:${RESET}"
  git log --oneline --format="           %C(auto)%h%Creset %s  ${DIM}%an, %ar${RESET}" main..origin/main | head -8
  echo "  ${DIM}git checkout main && git pull${RESET}"
else
  echo "  ${GREEN}up to date${RESET} with GitHub"
fi
echo "  ${DIM}latest:${RESET}"
git log origin/main -3 --format="           %C(auto)%h%Creset %s  ${DIM}%an, %ar${RESET}"

# Pull requests and CI.
if [[ "$HAS_GH" == "1" ]]; then
  echo ""
  echo "${BOLD}Pull requests${RESET}"
  OPEN="$(gh pr list --state open --json number,title,author,isDraft \
    --jq '.[] | "           #\(.number)  \(.title)  — \(.author.login)\(if .isDraft then " (draft)" else "" end)"' 2>/dev/null)"
  if [[ -n "$OPEN" ]]; then
    echo "$OPEN"
  else
    echo "           ${DIM}none open${RESET}"
  fi

  MINE="$(gh pr status --json number,title --jq '.currentBranch.number // empty' 2>/dev/null)"
  [[ -n "$MINE" ]] && echo "  ${DIM}this branch has PR #${MINE}${RESET}"

  echo ""
  echo "${BOLD}CI${RESET}"
  gh run list --limit 3 --json conclusion,status,displayTitle,headBranch \
    --jq '.[] | "           \(.conclusion // .status)  \(.headBranch)  \(.displayTitle)"' 2>/dev/null \
    | sed "s/success/${GREEN}pass${RESET}   /; s/failure/${RED}FAIL${RESET}   /; s/in_progress/${BLUE}running${RESET}/" \
    || echo "           ${DIM}none${RESET}"
fi

echo ""
echo "${DIM}────────────────────────────────────────────────────────────${RESET}"
if [[ "$BRANCH" == "main" && "$DIRTY" -gt 0 ]]; then
  echo "${YELLOW}You have uncommitted work on main.${RESET} Move it to a branch before committing:"
  echo "  ${DIM}git checkout -b what-youre-doing${RESET}"
elif [[ "$BRANCH" == "main" ]]; then
  echo "Start something: ${DIM}git checkout -b what-youre-doing${RESET}"
else
  echo "Share it: ${DIM}git push -u origin ${BRANCH} && gh pr create${RESET}"
fi
echo ""
