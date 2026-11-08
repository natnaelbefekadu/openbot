
import os, signal, time
PATTERN = "OpenBot-Fork" + "/openbot"
def procs():
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\x00", b" ").decode("utf8", "replace")
        except OSError:
            continue
        if PATTERN in cmd or "mount_openbo" in cmd.lower():
            out.append(int(pid))
    return out
found = procs()
print("stopping", len(found))
for x in found:
    try:
        os.kill(x, signal.SIGTERM)
    except ProcessLookupError:
        pass
for _ in range(25):
    time.sleep(0.4)
    if not procs():
        break
for x in procs():
    try:
        os.kill(x, signal.SIGKILL)
    except ProcessLookupError:
        pass
time.sleep(1)
print("remaining", len(procs()))
