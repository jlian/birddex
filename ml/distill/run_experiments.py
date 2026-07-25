#!/usr/bin/env python3
"""Sequential experiment queue runner for the pilot sweep.

Deliberately small: one GPU, a handful of runs, so a for-loop over a JSON
config beats pulling in W&B/Optuna/Hydra. What it DOES borrow from those tools
is the stuff that is easy to get wrong by hand:

  * structured per-run results (results.json) so comparison is not grep work
  * resumability -- a crash on run 4 of 9 does not restart the queue
  * guardrails -- refuses to start if a GPU job is already running, and
    hard-stops after N consecutive failures instead of burning the night
  * an explicit status file an unattended agent can read to decide what to do

Usage:
  python run_experiments.py --queue experiments.json --status /tmp/expq.json
  python run_experiments.py --queue experiments.json --dry-run
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

VENV_PY = "/home/jlian/spikes/bioclip-birdid/.venv/bin/python"


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def gpu_busy():
    """True if a training/eval job is already using the GPU."""
    try:
        out = subprocess.run(["pgrep", "-af", "train_student.py|eval_.*\\.py"],
                             capture_output=True, text=True)
        return bool(out.stdout.strip())
    except Exception:
        return False


def parse_result(log_path):
    """Pull the final metrics out of a finished run's log."""
    best = None
    epochs = []
    imgs = []
    try:
        for line in open(log_path):
            m = re.search(r"epoch (\d+)/(\d+)\s+train_loss=([0-9.]+)\s+val_cos_sim=([0-9.]+)", line)
            if m:
                epochs.append({"epoch": int(m.group(1)),
                               "train_loss": float(m.group(3)),
                               "val_cos_sim": float(m.group(4))})
            m2 = re.search(r"best val_cos_sim=([0-9.]+)", line)
            if m2:
                best = float(m2.group(1))
            m3 = re.search(r"([0-9]+) img/s", line)
            if m3:
                imgs.append(int(m3.group(1)))
    except FileNotFoundError:
        return None
    if best is None and epochs:
        best = max(e["val_cos_sim"] for e in epochs)
    # peak epoch tells us about overfit drift (pilot peaked ~ep11 then declined)
    peak_ep = max(epochs, key=lambda e: e["val_cos_sim"])["epoch"] if epochs else None
    return {
        "best_val_cos_sim": best,
        "epochs_completed": len(epochs),
        "peak_epoch": peak_ep,
        "declined_after_peak": bool(epochs and peak_ep and peak_ep < len(epochs)),
        "median_img_s": sorted(imgs)[len(imgs) // 2] if imgs else None,
        "per_epoch": epochs,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True)
    ap.add_argument("--status", default="/tmp/experiment_queue_status.json")
    ap.add_argument("--logdir", default="/home/jlian/spikes/bioclip-birdid/distill/runs")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-consecutive-failures", type=int, default=2)
    a = ap.parse_args()

    queue = json.load(open(a.queue))
    experiments = queue["experiments"]
    log(f"queue: {len(experiments)} experiments from {a.queue}")

    status = {"queue_file": os.path.abspath(a.queue),
              "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "runs": {}}
    if os.path.exists(a.status):
        try:
            status = json.load(open(a.status))
            log(f"resuming: {len(status.get('runs', {}))} runs already recorded")
        except Exception:
            pass
    status.setdefault("runs", {})

    def save():
        status["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with open(a.status, "w") as f:
            json.dump(status, f, indent=2)

    consecutive_failures = 0

    for i, exp in enumerate(experiments):
        name = exp["name"]
        prev = status["runs"].get(name)
        if prev and prev.get("state") == "done":
            log(f"[{i+1}/{len(experiments)}] {name}: already done, skipping")
            continue

        out_dir = os.path.join(a.logdir, name)
        log_path = os.path.join(out_dir, "train.log")
        cmd = [VENV_PY, "-u", "train_student.py"] + exp["args"] + ["--out", out_dir]

        if a.dry_run:
            log(f"[{i+1}/{len(experiments)}] DRY-RUN {name}:\n    {' '.join(cmd)}")
            continue

        if gpu_busy():
            log("GPU is busy with another job -- refusing to start. Try later.")
            status["blocked"] = "gpu_busy"
            save()
            return 2

        os.makedirs(out_dir, exist_ok=True)
        log(f"[{i+1}/{len(experiments)}] START {name}")
        log(f"    {' '.join(cmd)}")
        status["runs"][name] = {"state": "running", "cmd": cmd,
                                "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        save()

        t0 = time.time()
        with open(log_path, "w") as lf:
            proc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT,
                                  cwd="/home/jlian/spikes/bioclip-birdid/distill")
        el = time.time() - t0

        res = parse_result(log_path)
        ok = proc.returncode == 0 and res and res.get("best_val_cos_sim") is not None
        status["runs"][name] = {
            "state": "done" if ok else "failed",
            "cmd": cmd,
            "returncode": proc.returncode,
            "elapsed_sec": round(el),
            "elapsed_h": round(el / 3600, 2),
            "log": log_path,
            "result": res,
            "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        save()

        if ok:
            consecutive_failures = 0
            log(f"    DONE {name}: best_val_cos={res['best_val_cos_sim']:.4f} "
                f"peak_ep={res['peak_epoch']} "
                f"declined_after_peak={res['declined_after_peak']} "
                f"{res['median_img_s']} img/s  ({el/3600:.2f}h)")
        else:
            consecutive_failures += 1
            log(f"    FAILED {name}: rc={proc.returncode} "
                f"({consecutive_failures} consecutive)")
            if consecutive_failures >= a.max_consecutive_failures:
                log(f"STOPPING: {consecutive_failures} consecutive failures. "
                    f"Something systemic is wrong -- a human/agent should look.")
                status["blocked"] = "consecutive_failures"
                save()
                return 1

    status["blocked"] = None
    status["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    save()

    log("")
    log("=== QUEUE COMPLETE ===")
    done = [(n, r) for n, r in status["runs"].items() if r.get("state") == "done"]
    done.sort(key=lambda kv: -(kv[1]["result"]["best_val_cos_sim"] or 0))
    for n, r in done:
        res = r["result"]
        log(f"  {res['best_val_cos_sim']:.4f}  {n:28s} "
            f"peak_ep={res['peak_epoch']:<3} "
            f"drift={'YES' if res['declined_after_peak'] else 'no':3s} "
            f"{r['elapsed_h']}h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
