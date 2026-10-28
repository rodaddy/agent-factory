"""Exercise the launcher's Linux readers against slow proc files, without Pi.

A FIFO is a real interruptible blocked read. The filesystem mapping lets this
same regression execute on macOS too; Linux host acceptance remains separate.
"""
import builtins
import os
from pathlib import Path
import signal
import sys
import time
import types

launcher, root, helper, scenario = sys.argv[1:]
module = types.ModuleType("pi_employee")
module.__file__ = launcher
exec(compile(Path(launcher).read_text(), launcher, "exec"), module.__dict__)
module.LINUX = True
root = Path(root)
pid = os.getpid()
pids = [pid] + list(range(10000001, 10000020))
for item in pids:
    folder = root / str(item)
    folder.mkdir()
    # stat tail begins at field 3; starttime is field 22.
    (folder / "stat").write_text(f"{item} (sleep) S 1 {item} " + "0 " * 16 + "123\n")
    (folder / "status").write_text(f"Uid:\t{os.getuid()}\t0\t0\t0\n")
    (folder / "environ").write_bytes(b"PAPERCLIP_RUN_ID=probe\0")
    (folder / "cmdline").write_bytes(b"sleep\x0060\0")
fifo = root / "blocked"
os.mkfifo(fifo)
real_open, real_listdir = builtins.open, os.listdir


def fake_open(path, *args, **kwargs):
    text = str(path)
    if text.startswith("/proc/"):
        if scenario in ("blocked", "prior-timer"):
            return real_open(fifo, *args, **kwargs)
        if scenario == "aggregate":
            time.sleep(0.02)  # fixed-sleep-ok: slow filesystem under test
        path = root / text.removeprefix("/proc/")
    return real_open(path, *args, **kwargs)


def fake_listdir(path):
    if path == "/proc":
        if scenario == "enumeration":
            with real_open(fifo, "rb") as stream:
                stream.read()
        return [str(item) for item in pids]
    return real_listdir(path)


builtins.open = fake_open
os.listdir = fake_listdir
budget = 1 if scenario == "prior-timer" else 0.12
call = {"list_procs": lambda: module.list_procs(budget),
        "env_matches": lambda: module.env_matches("probe", os.getuid(), 0.12),
        "live_argv": lambda: module.live_argv(pid, 0.12)}[helper]
# A pre-existing timer must survive, and the reader must not leak its handler.
alarms = []
if scenario == "prior-timer":
    signal.signal(signal.SIGALRM, lambda *_: alarms.append(time.monotonic()))
prior_handler = signal.getsignal(signal.SIGALRM)
signal.setitimer(signal.ITIMER_REAL, 0.05 if scenario == "prior-timer" else 10, 11)
if scenario == "cleanup-interrupt":
    real_setitimer = signal.setitimer
    injected = False

    def interrupted_disarm(which, delay, interval=0):
        global injected
        if not delay and not injected:
            injected = True
            os.kill(pid, signal.SIGALRM)
        return real_setitimer(which, delay, interval)

    signal.setitimer = interrupted_disarm
started = time.monotonic()
try:
    result = call()
    elapsed = time.monotonic() - started
    if scenario == "success":
        expected = {"list_procs": {item: (1, item, os.getuid(), "S", 123) for item in pids},
                    "env_matches": [(item, 123) for item in pids],
                    "live_argv": "sleep 60 "}[helper]
        assert result == expected, (helper, result)
    else:
        assert result is None, (helper, "returned partial data", result)
        if scenario == "prior-timer":
            assert elapsed < 0.3, ("earlier caller deadline postponed", elapsed)
        elif scenario != "cleanup-interrupt":
            assert 0.08 <= elapsed < 0.6, (helper, "deadline not enforced", elapsed)
    remaining, interval = signal.getitimer(signal.ITIMER_REAL)
    assert signal.getsignal(signal.SIGALRM) == prior_handler, "handler leaked"
    if scenario == "prior-timer":
        end = time.monotonic() + 0.3
        while not alarms and time.monotonic() < end:
            time.sleep(0.005)  # fixed-sleep-ok: wait for caller-owned timer
        assert alarms and alarms[0] - started < 0.3, "caller alarm lost or delayed"
    else:
        assert 9 < remaining <= 10 and interval == 11, "previous timer lost"
    print(f"{helper} {scenario}: passed in {elapsed:.3f}s")
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
