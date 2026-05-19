"""DuckDB connection management.

One process holds a single DuckDB Connection that owns the file. Every caller
that needs to run a query takes a fresh cursor from that Connection via
`get_cursor()`. Cursors are independent execution contexts (DuckDB's MVCC
isolates them), so concurrent reads don't serialize on a Python lock.

The ingest pipeline uses the Connection directly via `get_connection()` to
issue DDL/DML; it runs in a single background thread (see ingest_queue), so
there is only ever one writer at a time.
"""
import os

import duckdb

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "nfl.duckdb")

_conn: duckdb.DuckDBPyConnection | None = None


def get_connection() -> duckdb.DuckDBPyConnection:
    """The single process-wide Connection. Use this only for writes (ingest)."""
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _conn = duckdb.connect(DB_PATH)
    return _conn


def get_cursor() -> duckdb.DuckDBPyConnection:
    """A fresh cursor for read queries. Cursors are cheap and isolated."""
    return get_connection().cursor()


def query_to_dict(sql: str, params: list = None) -> list[dict]:
    """Run a query on a fresh cursor and return rows as dicts.

    Used by all read endpoints. Each call gets its own cursor, so concurrent
    requests do not serialize.
    """
    cur = get_cursor()
    rel = cur.execute(sql, params or [])
    columns = [desc[0] for desc in rel.description]
    return [dict(zip(columns, row)) for row in rel.fetchall()]
