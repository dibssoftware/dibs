#!/bin/bash
# Live tests between this machine and a real Linux VM on boat. Not part of the
# suite: it bills a VM for a few minutes and needs the boat CLI and a registry
# row for the VM (dibs never keeps a VM id). Run from a checkout:
#
#   test/live/two-machines.sh [--temp]
#
# Part 1, the coordinator on the VM: this machine joins it through a boat
# forward, both run workers, and jobs go each way: --on, --anywhere, output,
# exit codes, --bring, a worker that dies mid-job (77), and kick.
# Part 2, the coordinator here: the VM as an on-demand machine, woken by a job
# and stopped by dibs once idle.
# Part 3, with --temp: a job too big for the VM gets a small VM made for it,
# which is deleted, row and all, afterwards. It creates a VM: only with --temp.
#
# REGISTRY (default ~/boat/VMS.md), MATCH (dibs) and OWNER (alex-3b) pick the row.
# The VM is stopped on every exit, and every VM part 3 makes is deleted.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=$ROOT/bin/dibs.mjs
REGISTRY=${REGISTRY:-$HOME/boat/VMS.md}; MATCH=${MATCH:-dibs}; OWNER=${OWNER:-alex-3b}
BOAT_CLI=${DIBS_BOAT:-$(command -v boat || echo "$HOME/.local/bin/boat")}
BOAT="$BOAT_CLI --no-update"
TEMP=0; [ "${1:-}" = --temp ] && TEMP=1
VM_NODE=/home/user/.dibs-node/bin
VM_APP=/home/user/dibs-live
VM_HOME_DIBS=/home/user/live-home
T=$(mktemp -d "${TMPDIR:-/tmp}/dibs-live-XXXX")
export DIBS_NO_SESSION=1 DIBS_AGENT=live
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT DIBS_LEASE DIBS_HOME

pass=0; fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
bad() { fail=$((fail + 1)); echo "not ok - $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/    /'; }
# check "name" <test command...>: the test command's exit status decides.
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
od() { node --input-type=module -e "import * as m from '$ROOT/src/ondemand.mjs'; $1" "${@:2}"; }
note() { od 'm.noteVm({ registry: process.argv[1] }, process.argv[2], process.argv[3])' "$REGISTRY" "$ID" "$1"; }
state() { $BOAT info "$1" --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).sandbox.state)}catch{console.log("gone")}})'; }
stopped() { test "$(state "$ID")" = stopped; }
listed() { $BOAT list --all --json | grep -c "\"id\":\"$1\""; }
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
# A shell line on the VM, with the live dibs on PATH. Prints its output; exits with its code.
# boat exec answers in one JSON object off a terminal.
vm() {
  $BOAT exec --json --timeout 300 "$ID" -- sh -c "export PATH=$VM_NODE:\$PATH DIBS_HOME=$VM_HOME_DIBS DIBS_NO_SESSION=1 DIBS_AGENT=live; cd /home/user; $1" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let j;try{j=JSON.parse(d)}catch{process.stdout.write(d);process.exit(1)}process.stdout.write(j.stdout||"");process.stderr.write(j.stderr||"");process.exit(j.exitCode??1)})'
}
vmbg() { $BOAT exec --detach "$ID" -- sh -c "export PATH=$VM_NODE:\$PATH DIBS_HOME=$VM_HOME_DIBS DIBS_NO_SESSION=1 DIBS_AGENT=live ${2:-}; cd /home/user; exec $1" >/dev/null; }
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ID=$(DIBS_BOAT=$BOAT_CLI od 'const f = await m.findVm({ registry: process.argv[1], match: process.argv[2], owner: process.argv[3] }); if (f.problem) { console.error(f.problem); process.exit(1); } console.log(f.id)' "$REGISTRY" "$MATCH" "$OWNER") || exit 1
echo "# VM $ID, from $REGISTRY; scratch in $T"

PIDS=()
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null; done
  # Part 3's VMs: every one dibs made here goes, whatever happened.
  for id in $(grep -ho '"act":"create"[^}]*"id":"bx_[a-z0-9]*"' "$T"/coord*/events.jsonl 2>/dev/null | grep -o 'bx_[a-z0-9]*'); do
    [ "$(listed "$id")" != 0 ] && { echo "# deleting $id, left by part 3"; $BOAT delete "$id" --yes --json >/dev/null; }
    od 'm.dropRow(process.argv[1], process.argv[2])' "$REGISTRY" "$id"
  done
  if [ "$(state "$ID")" != stopped ]; then
    vm "pkill -f '[d]ibs-live/bin/dibs.mjs'; rm -rf $VM_APP $VM_HOME_DIBS" >/dev/null 2>&1
    $BOAT stop "$ID" --json >/dev/null 2>&1
  fi
  note "Stopped $(date +%H:%M) after dibs's live two-machine tests ($OWNER). dibs finds it at run time, not from a saved id"
  echo "# VM $ID: $(state "$ID")"
  echo "# $pass passed, $fail failed"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- Part 1: the coordinator on the VM ----
echo "# part 1: coordinator on the VM, this machine joined through a forward"
note "Running dibs's live two-machine tests ($OWNER) since $(date +%H:%M)"
$BOAT resume "$ID" --json >/dev/null || { bad "resume $ID"; exit 1; }
$BOAT exec --timeout 120 "$ID" -- sh -c "rm -rf $VM_APP $VM_HOME_DIBS; mkdir -p $VM_HOME_DIBS" >/dev/null
$BOAT push "$ID" "$ROOT" --to $VM_APP >/dev/null || { bad "push dibs to the VM"; exit 1; }
[ "$(vm "cat /home/user/.dibs-node/.pinned")" = v22.23.3 ] || { bad "the VM has the pinned Node (an on-demand wake installs it)"; exit 1; }
# The same port on both ends, so the join line the VM prints works here unchanged.
PORT=$(free_port)
# Short timeouts, so a worker that dies is noticed in seconds.
vmbg "node $VM_APP/bin/dibs.mjs serve --listen $PORT --bind 127.0.0.1 >> $VM_HOME_DIBS/serve.log 2>&1" "DIBS_SERVE_TIMING='{\"workerLost\":8000,\"beatHold\":2000}'"
listening() { vm "grep -q listening $VM_HOME_DIBS/serve.log" 2>/dev/null; }
until_ 60 listening || { bad "coordinator starts on the VM" "$(vm "cat $VM_HOME_DIBS/serve.log")"; exit 1; }
VMNAME=$(vm "node -p 'require(\"$VM_HOME_DIBS/remote.json\").name'")
vmbg "node $VM_APP/bin/dibs.mjs worker >> $VM_HOME_DIBS/worker.log 2>&1"
$BOAT forward "$ID" --remote "$PORT" --local "$PORT" > "$T/forward.log" 2>&1 &
PIDS+=($!)
until_ 30 curl -s -o /dev/null "http://127.0.0.1:$PORT/" || { bad "forward to the VM's coordinator" "$(cat "$T/forward.log")"; exit 1; }
JOIN=$(vm "node $VM_APP/bin/dibs.mjs invite mac" | grep -o 'dibs join .*')
MAC=$T/mac; mkdir -p "$MAC"
d() { DIBS_HOME=$MAC node "$BIN" "$@"; }
eval "DIBS_HOME=$MAC node \"$BIN\" ${JOIN#dibs }" > "$T/join.log" 2>&1 || { bad "join from here" "$(cat "$T/join.log")"; exit 1; }
DIBS_HOME=$MAC node "$BIN" worker > "$T/mac-worker.log" 2>&1 &
PIDS+=($!)
P=$T/proj; mkdir -p "$P"; (cd "$P" && git init -q && echo hi > a.txt && git add a.txt && git -c user.email=t@t -c user.name=t commit -qm one)

both() { d machines 2>&1 | grep -q "2 machines taking jobs"; }
until_ 30 both && ok "dibs machines here lists both machines ($VMNAME and mac)" || bad "dibs machines lists both" "$(d machines 2>&1)"

out=$(cd "$P" && d run test --on "$VMNAME" -m live -- sh -c 'uname -s; echo shipped > made.txt; echo to-stderr >&2; exit 3' 2>&1); code=$?
check "--on the VM: it runs on Linux" grep -q Linux <<<"$out"
check "--on the VM: its stderr comes back" grep -q to-stderr <<<"$out"
check "--on the VM: its exit code comes back (3, got $code)" test "$code" = 3

rm -f "$P/made.txt"
out=$(cd "$P" && d run test --on "$VMNAME" --bring made.txt -m live -- sh -c 'echo shipped > made.txt' 2>&1); code=$?
check "--bring: the file the job made comes back (exit $code)" grep -q shipped "$P/made.txt"

out=$(vm "cd /home/user && mkdir -p livep && cd livep && git init -q 2>/dev/null; echo x > x && node $VM_APP/bin/dibs.mjs run test --on mac -m live -- uname -s" 2>&1); code=$?
check "from the VM --on mac: it runs here, on Darwin" grep -q Darwin <<<"$out"
check "from the VM --on mac: exit 0 (got $code)" test "$code" = 0

out=$(cd "$P" && d run test --anywhere -m live -- sh -c 'echo anywhere-ran' 2>&1); code=$?
check "--anywhere: it runs somewhere and exits 0 (got $code)" sh -c "test $code = 0 && echo \"\$0\" | grep -q anywhere-ran" "$out"

# A worker that dies mid-job: the sender hears 77 (it may have run).
(cd "$P" && d run test --on "$VMNAME" -m live -- sh -c 'echo started; sleep 120' > "$T/77.out" 2>&1; echo "$?" > "$T/77.code") &
until_ 60 grep -q started "$T/77.out" || bad "the long job starts on the VM" "$(cat "$T/77.out")"
vm "pkill -9 -f '[d]ibs-live/bin/dibs.mjs worker'; pkill -9 -f 'sleep 120'" >/dev/null 2>&1
until_ 60 test -s "$T/77.code"
check "a worker killed mid-job: the sender exits 77 (got $(cat "$T/77.code" 2>/dev/null))" test "$(cat "$T/77.code" 2>/dev/null)" = 77

vm "node $VM_APP/bin/dibs.mjs kick mac" > "$T/kick.log" 2>&1
out=$(cd "$P" && d run test --on "$VMNAME" -m live -- true 2>&1); code=$?
check "kicked: this machine can't send any more (exit $code)" test "$code" != 0
gone() { ! vm "node $VM_APP/bin/dibs.mjs machines" 2>&1 | grep -q '^ *mac '; }
check "kicked: the VM's dibs machines no longer lists mac" until_ 20 gone

for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null; done; PIDS=()
vm "pkill -f '[d]ibs-live/bin/dibs.mjs'; rm -rf $VM_APP $VM_HOME_DIBS /home/user/livep" >/dev/null 2>&1
$BOAT stop "$ID" --json >/dev/null
check "part 1 leaves the VM stopped" until_ 60 stopped

# ---- Part 2 (and 3): the coordinator here, the VM on demand ----
echo "# part 2: coordinator here, the VM woken by a job and stopped once idle"
C=$T/coord; S=$T/sender; mkdir -p "$C" "$S"
CREATE=""; [ $TEMP = 1 ] && CREATE=',"mem":2147483648,"cores":1,"create":{"max":"small"}'
echo "{\"machines\":{\"ondemand\":[{\"name\":\"boat-1\",\"provider\":\"boat\",\"registry\":\"$REGISTRY\",\"match\":\"$MATCH\",\"owner\":\"$OWNER\"$CREATE}]}}" > "$C/config.json"
CP=$(free_port)
DIBS_BOAT=$BOAT_CLI DIBS_HOME=$C node "$BIN" serve --listen "$CP" --bind 127.0.0.1 > "$T/serve.log" 2>&1 &
PIDS+=($!)
until_ 30 grep -q "on-demand machines:" "$T/serve.log" || { bad "coordinator here starts with boat-1" "$(cat "$T/serve.log")"; exit 1; }
eval "DIBS_HOME=$S node \"$BIN\" $(DIBS_HOME=$C node "$BIN" invite sender | grep -o 'dibs join .*' | sed 's/^dibs //')" >/dev/null
s() { DIBS_HOME=$S node "$BIN" "$@"; }
t0=$(date +%s)
out=$(cd "$P" && s run test --on boat-1 -m live -- sh -c 'uname -s; exit 4' 2>&1); code=$?
check "--on boat-1 wakes it and runs there ($(( $(date +%s) - t0 ))s, exit $code)" sh -c "test $code = 4 && echo \"\$0\" | grep -q Linux" "$out"
check "dibs stops it once its queue is empty" until_ 120 stopped

if [ $TEMP = 1 ]; then
  echo "# part 3: a job too big for boat-1 (which says it has 2 GB here) gets a small VM made for it"
  out=$(cd "$P" && s run test --on boat-1 --mem 3G -m live -- sh -c 'nproc; grep MemTotal /proc/meminfo' 2>&1); code=$?
  check "the job runs on the VM made for it (exit $code)" grep -q MemTotal <<<"$out"
  NEW=$(grep -ho '"act":"create"[^}]*"id":"bx_[a-z0-9]*"' "$C/events.jsonl" | grep -o 'bx_[a-z0-9]*' | tail -1)
  check "it was made small" grep -q '"type":"small"' "$C/events.jsonl"
  deleted() { test "$(listed "$NEW")" = 0; }
  check "$NEW is gone from boat list --all" until_ 120 deleted
  check "$NEW's row is gone from $REGISTRY" sh -c "! grep -q '$NEW' '$REGISTRY'"
  check "boat-1 itself stayed asleep" stopped
fi
exit $(( fail > 0 ))
