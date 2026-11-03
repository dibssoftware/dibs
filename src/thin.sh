# dibs run and dibs hold, waiting without Node. bin/dibs.mjs starts this as
#   /bin/sh thin.sh <bin/dibs.mjs> run|hold <args>
# when config.json has "waits": "thin". Node gets in line as this process and
# runs a job that can start at once; a waiting one comes back here, gets in line
# again (_enqueue, picking up its place), and this shell blocks on a read from its own FIFO,
# which costs no CPU and about 1.5 MB, and the broker (src/broker.mjs) writes
# to it: "out <line>" to print, "go" when it's this waiter's turn, "exit N".
# On go it execs Node for the run itself, so the pid and start time the lease
# names stay this process's. Keep it small and POSIX: it runs under dash too.
B=$1
shift
D=${DIBS_HOME:-$HOME/.dibs}
# How bin/dibs.mjs starts Node (LEAN in src/util.mjs); keep them in step.
N="node --max-semi-space-size=1"
F=$D/w/$$
# First, Node gets in line as this same process (exec): a job that can start now
# runs in it, Node started once. One that must wait keeps its place and comes
# back here with DIBS_THIN_RESUME set, to wait as below. On 2026-10-21 starting
# Node twice (once to get in line, once to run) was 90 ms of every run.
if [ -z "${DIBS_THIN_RESUME:-}" ]; then
  exec $N "$B" _enqueue $$ "$PPID" "$F" "$@"
fi
unset DIBS_THIN_RESUME
# No FIFO, no thin wait: wait the old way instead.
{ mkdir -p "$D/w" && rm -f "$F" && mkfifo -m 600 "$F"; } 2>/dev/null || exec $N "$B" "$@"
# Opening the read end blocks until there's a writer, so open a writer of our own first.
exec 4<>"$F" 3<"$F"
gone() { exec 3<&- 4>&-; rm -f "$F"; }
# Anything that goes wrong with a thin wait leaves an event (kind thin) in the
# history, so it can be found later. why is always one of the words below.
note() { printf '{"at":%s000,"kind":"thin","why":"%s","id":%s,"shell":%s}\n' "$(date +%s)" "$1" "${id:-0}" $$ >>"$D/events.jsonl" 2>/dev/null; }

# Set before getting in line: a signal that comes while Node is at it is
# acted on once Node is done, and leaves whatever place it made. Its answer,
# if it gave one, is already in the FIFO: read without our own writer, an
# empty FIFO is end of file at once rather than a wait.
id=
leave() {
  # A signal during `IFS= read` runs this with IFS still empty in bash, and $N
  # would then be one word, "node --max...", which isn't a command.
  unset IFS
  [ -z "$id" ] && { exec 4>&-; IFS= read -r r <&3; case $r in go\ *|wait\ *) id=${r#* } ;; esac; }
  $N "$B" _leave "${id:-0}" $$ "$1"
  gone
  exit "$2"
}
trap 'leave SIGINT 130' INT
trap 'leave SIGTERM 143' TERM
trap 'leave SIGHUP 129' HUP

$N "$B" _enqueue $$ "$PPID" "$F" "$@" || { code=$?; trap - INT TERM HUP; [ $code = 70 ] && note 'getting in line crashed'; gone; exit $code; }
IFS= read -r r <&3
# From here on only the broker writes, so end of file means it isn't here.
exec 4>&-
case $r in
  go\ *|wait\ *) id=${r#* } ;;
  exit\ *) trap - INT TERM HUP; gone; exit "${r#exit }" ;;
  fat) trap - INT TERM HUP; gone; exec $N "$B" "$@" ;;
  *) trap - INT TERM HUP; note 'no answer from getting in line'; gone; exit 70 ;;
esac

# End of file: no broker has this FIFO open. One that's alive hasn't reached
# us yet (it opens every waiter's FIFO on its next tick), so read again after
# a pause. One that's dead crashed or was replaced by a release. Only one
# waiter starts the next, whoever makes the broker.starting folder; the rest
# wait for it, so 50 waiters don't start 50 Nodes at once. A broker that
# couldn't be started (broker.broken, less than a minute old), found dead three
# times in a minute, or missing for GIVE_UP seconds is broken: give the place
# up for the in-process wait, which picks it up again.
GIVE_UP=${DIBS_THIN_GIVE_UP:-15}
broken() { [ -n "$(find "$D/broker.broken" -mmin -1 2>/dev/null)" ]; }
gap=1 dead= t1= t2=
nobroker() {
  p=
  read -r p <"$D/broker.pid" 2>/dev/null
  # A liveness hint only: kill -0 sends nothing.
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    dead=
    sleep $((gap / 10)).$((gap % 10))
    [ $gap -lt 20 ] && gap=$((gap * 2))
    return 0
  fi
  t=$(date +%s)
  if [ -z "$dead" ]; then
    dead=$t
    [ -n "$t1" ] && [ $((t - t1)) -lt 60 ] && { gaveup='broker died three times in a minute'; return 1; }
    t1=$t2 t2=$t
  fi
  [ $((t - dead)) -ge "$GIVE_UP" ] && { gaveup='no broker for too long'; return 1; }
  broken && { gaveup='no broker could be started'; return 1; }
  if mkdir "$D/broker.starting" 2>/dev/null; then
    echo $$ >"$D/broker.starting/pid"
    note 'broker gone, starting another'
    $N "$B" _rewait
    code=$?
    rm -rf "$D/broker.starting"
    return $code
  fi
  # A starter killed before it finished would hold the folder for good.
  s=
  read -r s <"$D/broker.starting/pid" 2>/dev/null
  [ -n "$s" ] && ! kill -0 "$s" 2>/dev/null && rm -rf "$D/broker.starting"
  sleep 0.$(($$ % 9 + 1))
}

[ "${r%% *}" = go ] || while :; do
  if IFS= read -r line <&3; then
    gap=1 dead=
    case $line in
      go) break ;;
      out\ *) printf '%s\n' "${line#out }" >&2 ;;
      exit\ *) gone; exit "${line#exit }" ;;
      # No broker could be started: Node waits instead, and picks the kept place up.
      fat) trap - INT TERM HUP; gone; exec $N "$B" "$@" ;;
    esac
  else
    nobroker && continue
    trap - INT TERM HUP
    note "$gaveup: waiting in Node"
    $N "$B" _leave "$id" $$ keep
    gone
    exec $N "$B" "$@"
  fi
done

gone
trap - INT TERM HUP
v=$1
shift
exec $N "$B" "$v" --lease "$id" "$@"
