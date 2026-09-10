"""Single-writer queue for sequential season ingest in a background thread."""
import queue
import threading

from database import query_to_dict, write_lock
from ingest import run_ingest

# Season state: "queued" | "loading" | "error" — absent means loaded or not yet touched
season_status: dict[int, str] = {}
ingest_logs:   dict[int, list[str]] = {}

# Single-writer queue: one background thread loads seasons sequentially
_load_queue: queue.SimpleQueue = queue.SimpleQueue()


def _ingest_season(year: int) -> None:
    ingest_logs[year] = []

    def log(msg: str):
        line = str(msg).strip()
        print(line)
        ingest_logs.setdefault(year, []).append(line)

    try:
        # Hold the write lock for the whole run: lazy materialization from
        # request threads must never interleave with an in-flight ingest
        # (same connection = shared transaction context).
        with write_lock:
            run_ingest([year], log=log)
        season_status.pop(year, None)          # remove → treated as "loaded"
        ingest_logs[year].append("__DONE__")
    except Exception as e:
        print(f"Ingest failed for {year}: {e}")
        season_status[year] = "error"
        ingest_logs[year].append(f"__ERROR__ {e}")


def _load_worker() -> None:
    """Single daemon thread — consumes the queue, one season at a time."""
    while True:
        year = _load_queue.get()
        if season_status.get(year) not in ("queued", "loading"):
            continue   # was cancelled / already done
        season_status[year] = "loading"
        _ingest_season(year)


def queue_season(year: int, force: bool = False) -> str:
    """Enqueue a season for loading. Returns the resulting status string."""
    # Start the worker on first use rather than at app startup: a serving
    # container that is never asked to ingest should not carry an ingest
    # thread at all. Idempotent, so repeated calls are free.
    start_worker()

    current = season_status.get(year)
    if current in ("queued", "loading"):
        return current

    if not force:
        try:
            loaded = {r["season"] for r in query_to_dict("SELECT DISTINCT season FROM schedules")}
            if year in loaded:
                return "loaded"
        except Exception:
            pass

    season_status[year] = "queued"
    _load_queue.put(year)
    return "queued"


_start_lock = threading.Lock()
_started = False


def start_worker() -> None:
    """Start the background ingest worker. Idempotent: a second call (test
    re-entry, repeated lifespan) is a no-op — two consumers on the queue would
    mean two writers."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_load_worker, daemon=True).start()
