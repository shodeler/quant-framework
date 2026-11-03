"""Benchmark runner behaviour without a model, workstation or market data."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]


def _load():
    sys.path.insert(0, str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("agent_benchmark", ROOT / "scripts/agent_benchmark.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bench = _load()

TASK = {
    "id": "T99", "tier": "easy", "type": "read-only", "fixture": "F1", "request": "Describe the workspace.",
    "checks": {
        "requires_tool": ["use:workspace.context"],
        "forbids_confirm": ["confirm_write"],
        "max_count": {"use:backtest.run": 0},
        "final_status": ["completed"],
        "grader": "Names only real projects.",
    },
    "budget": {"max_model_calls": 3, "max_seconds": 600},
}


def _backend(trace_dir: Path, *, model_rows: int, ask: bool):
    """Simulated workstation: one run whose trace grows while it is polled."""

    calls: list[tuple[str, str, dict | None]] = []
    polls = {"count": 0}
    trace = trace_dir / "req-1.jsonl"

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        calls.append((request.method, request.url.path, body))
        if request.method == "POST" and request.url.path == "/api/conexus/runs":
            rows = [{"type": "run.meta", "requestId": "req-1", "at": "2026-11-03T00:00:00Z"}]
            rows += [{"type": "model", "at": "2026-11-03T00:00:01Z", "tokens_in": 15000, "tokens_out": 50}] * model_rows
            rows += [{"type": "tool", "label": "use:workspace.context", "confirms": [], "ok": True}]
            trace.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            return httpx.Response(202, json={"run": {"id": "run-1", "status": "queued"}, "accessToken": "token"})
        if request.url.path == "/api/conexus/runs/run-1/cancel":
            return httpx.Response(200, json={"run": {"id": "run-1", "status": "cancelled"}})
        if request.url.path.endswith("/answer"):
            return httpx.Response(200, json={"run": {"id": "run-1", "status": "running"}})
        if request.url.path == "/api/conexus/runs/run-1":
            assert request.headers["authorization"] == "Bearer token"
            polls["count"] += 1
            if ask and polls["count"] == 1:
                return httpx.Response(200, json={"run": {"id": "run-1", "status": "running",
                                                         "pendingInteraction": {"id": "q1", "question": "Which one?"}}})
            if polls["count"] < 3:
                return httpx.Response(200, json={"run": {"id": "run-1", "status": "running"}})
            return httpx.Response(200, json={"run": {"id": "run-1", "status": "completed", "summary": "Two projects."}})
        return httpx.Response(404)

    return httpx.Client(base_url="http://bench.test", transport=httpx.MockTransport(handler)), calls


def test_completed_run_answers_questions_and_scores_checks(tmp_path, monkeypatch):
    monkeypatch.setattr(bench.time, "sleep", lambda _seconds: None)
    client, calls = _backend(tmp_path, model_rows=2, ask=True)
    result = bench.run_task(client, "exposure", TASK, 1, tmp_path, "test")

    assert result["outcome"] == "completed"
    assert result["model_calls"] == 2 and result["tokens_in"] == 30000
    assert result["human_questions"] == 1
    assert result["auto_pass"] is True
    assert result["manual_checks"] == {"grader": "Names only real projects."}
    answer = next(body for method, path, body in calls if path.endswith("/answer"))
    assert "No further input" in answer["answer"]
    submitted = next(body for method, path, body in calls if path == "/api/conexus/runs")
    assert "conversation" not in submitted
    context = json.loads(submitted["input"]["request"])["workspaceContext"]
    assert context["selectedProjectId"] == "bench-momentum" and context["requestId"].startswith("bench-T99-1-")
    tagged = [json.loads(line) for line in (tmp_path / "req-1.jsonl").read_text(encoding="utf-8").splitlines()]
    assert tagged[-1] == {"type": "benchmark.task", "task_id": "T99", "repetition": 1, "label": "test", "run_id": "run-1"}


def test_budget_exhaustion_cancels_and_is_recorded_not_dropped(tmp_path, monkeypatch):
    monkeypatch.setattr(bench.time, "sleep", lambda _seconds: None)
    client, calls = _backend(tmp_path, model_rows=5, ask=False)
    result = bench.run_task(client, "exposure", TASK, 1, tmp_path, "test")

    assert ("POST", "/api/conexus/runs/run-1/cancel", None) in calls
    assert result["outcome"] == "budget_exhausted"
    assert result["status"] == "cancelled"
    assert result["auto_pass"] is False


def test_budget_cancel_is_sent_once_while_the_run_winds_down(tmp_path, monkeypatch):
    monkeypatch.setattr(bench.time, "sleep", lambda _seconds: None)
    cancels = []
    polls = {"count": 0}
    rows = [{"type": "model", "tokens_in": 1}] * 5

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/conexus/runs" and request.method == "POST":
            (tmp_path / "r.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            return httpx.Response(202, json={"run": {"id": "r", "status": "queued"}, "accessToken": "t"})
        if request.url.path.endswith("/cancel"):
            cancels.append(1)
            return httpx.Response(200, json={"run": {"id": "r", "status": "running"}})
        polls["count"] += 1
        status = "cancelled" if polls["count"] > 5 else "running"
        return httpx.Response(200, json={"run": {"id": "r", "status": status}})

    client = httpx.Client(base_url="http://bench.test", transport=httpx.MockTransport(handler))
    result = bench.run_task(client, "exposure", TASK, 1, tmp_path, "test")
    assert len(cancels) == 1
    assert result["outcome"] == "budget_exhausted"


def test_fixture_ids_are_filled_into_requests(tmp_path, monkeypatch):
    state = tmp_path / "fixtures.json"
    state.write_text(json.dumps({"F2_BACKTEST": "abc123"}), encoding="utf-8")
    monkeypatch.setattr(bench, "FIXTURE_STATE", state)
    task = {**TASK, "request": "Read backtest {F2_BACKTEST}.",
            "conversation": [{"role": "user", "content": "Earlier: {F2_BACKTEST}"}]}
    context = json.loads(bench.run_input(task, "req")["request"])
    assert context["userRequest"] == "Read backtest abc123."
    assert context["workspaceContext"]["conversationHistory"]["messages"][0]["content"] == "Earlier: abc123"


def test_checks_catch_forbidden_confirmations_and_counts():
    rows = [
        {"type": "tool", "label": "use:backtest.run", "confirms": ["confirm_python_execution"]},
        {"type": "tool", "label": "use:files.write", "confirms": ["confirm_write"]},
    ]
    checks = bench.evaluate(TASK, "completed", rows)
    assert checks["requires use:workspace.context"]["pass"] is False
    assert checks["never sends confirm_write"] == {"pass": False, "used_by": ["use:files.write"]}
    assert checks["at most 0 x use:backtest.run"]["pass"] is False
    assert checks["final status"]["pass"] is True


def test_benchmark_tasks_are_well_formed():
    spec = json.loads((ROOT / "benchmarks/agent/v1/tasks.json").read_text(encoding="utf-8"))
    ids = [task["id"] for task in spec["tasks"]]
    assert len(ids) == len(set(ids)) == 12
    for task in spec["tasks"]:
        assert task["fixture"] in spec["fixtures"]
        assert task["budget"]["max_model_calls"] > 0 and task["budget"]["max_seconds"] > 0
        for item in task.get("conversation", []):
            assert item["role"] in {"user", "assistant"} and item["content"]
