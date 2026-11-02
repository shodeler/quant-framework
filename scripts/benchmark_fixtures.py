"""Create the agent benchmark fixtures (issue #22) through the public AlphaLab API.

Run against a backend whose runtime store already holds synchronized RQ data:

    python scripts/benchmark_fixtures.py --check
    python scripts/benchmark_fixtures.py F1 F2 F3 [--reset]

F1  project bench-momentum from sdk-v1-default with the momentum_20d factor.
F2  one succeeded backtest of bench-momentum/main over the benchmark window.
F3  project bench-quality using quality_profitability, whose fundamentals
    fields must be absent from the runtime store so the Agent has to sync them.

The fixtures use the same endpoints the Agent tools call, so a fixture that
cannot be created here would also fail for the Agent.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import httpx

WINDOW = ("2024-01-01", "2025-12-31")
PROJECTS = {
    "F1": ("bench-momentum", "Benchmark momentum", "momentum_20d"),
    "F3": ("bench-quality", "Benchmark quality", "quality_profitability"),
}
TERMINAL = {"succeeded", "failed", "cancelled"}


def _client(origin: str) -> httpx.Client:
    return httpx.Client(base_url=origin.rstrip("/"), timeout=120.0, headers={"Accept": "application/json"})


def _fail(response: httpx.Response, action: str) -> None:
    if response.is_error:
        raise SystemExit(f"{action} failed with HTTP {response.status_code}: {response.text[:500]}")


def check(client: httpx.Client) -> dict:
    """Report runtime data coverage before any fixture is written."""

    response = client.get("/api/agent/context")
    _fail(response, "Reading the workspace context")
    context = response.json()
    catalog = context["data_status"]["catalog"]
    print(json.dumps({"data_status": context["data_status"]["status"], "datasets": catalog["datasets"],
                      "projects": [item["id"] for item in context["projects"]]}, ensure_ascii=False, indent=2))
    return context


def create_project(client: httpx.Client, fixture: str, reset: bool) -> None:
    project_id, name, template_id = PROJECTS[fixture]
    if reset:
        response = client.delete(f"/api/strategy/projects/{project_id}", params={"confirm_delete": "true"})
        if response.status_code not in (204, 404):
            _fail(response, f"Deleting {project_id}")
    response = client.post("/api/strategy/projects", json={
        "project_id": project_id, "name": name, "description": f"Agent benchmark fixture {fixture} (issue #22)",
        "factors": [{"template_id": template_id}], "confirm_save": True, "confirm_python_execution": True,
    })
    if response.status_code == 409 and not reset:
        print(f"{fixture}: {project_id} already exists; pass --reset to recreate it")
        return
    _fail(response, f"Creating {project_id}")
    print(f"{fixture}: created {project_id} with factor template {template_id}")


def run_backtest(client: httpx.Client) -> None:
    response = client.post("/api/backtests/jobs", json={
        "project_id": "bench-momentum", "strategy_id": "main", "start_date": WINDOW[0], "end_date": WINDOW[1],
        "profile": "runtime", "confirm_python_execution": True,
    })
    _fail(response, "Submitting the F2 backtest")
    job = response.json()
    deadline = time.monotonic() + 3600
    while job.get("status") not in TERMINAL:
        if time.monotonic() > deadline:
            raise SystemExit(f"F2: backtest {job['id']} did not finish within an hour")
        response = client.get(f"/api/backtests/jobs/{job['id']}/wait", params={"timeout_seconds": 30}, timeout=45.0)
        _fail(response, "Waiting for the F2 backtest")
        job = response.json()
    if job["status"] != "succeeded":
        raise SystemExit(f"F2: backtest ended {job['status']}: {job.get('error_code')} {job.get('error_summary')}")
    print(f"F2: backtest {job.get('result_id')} succeeded, execution_reliable={job.get('execution_reliable')}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("fixtures", nargs="*", choices=["F1", "F2", "F3"])
    parser.add_argument("--origin", default="http://127.0.0.1:8000")
    parser.add_argument("--check", action="store_true", help="only report data coverage and existing projects")
    parser.add_argument("--reset", action="store_true", help="delete and recreate benchmark projects")
    args = parser.parse_args()
    with _client(args.origin) as client:
        context = check(client)
        if args.check:
            return 0
        if not any(item.get("rows") for item in context["data_status"]["catalog"]["datasets"]):
            raise SystemExit("The runtime store has no data. Sync RQ data first; fixtures need real bars.")
        for fixture in args.fixtures:
            if fixture in PROJECTS:
                create_project(client, fixture, args.reset)
            else:
                run_backtest(client)
    return 0


if __name__ == "__main__":
    sys.exit(main())
