import asyncio

import pytest

from twinops.catalogue import change_set
from twinops.config import Settings
from twinops.engine import run_model
from twinops.planner.runbook import RunbookPlanner
from twinops.service import LiveIncident, Registry
from twinops.twin import create_context, evaluate_gates, run_experiment


def test_mixed_actions_cannot_hide_a_failed_dns_cache_challenge():
    async def scenario():
        session = await run_model("core", "dns_failure", 1)
        ctx = create_context(session.run["observation"], session.run["topology"], await session.demo.capture_supported())
        await session.twin.load(ctx)
        change = change_set("mixed", "Mixed routing and DNS fix", [
            {"action": "restart_service", "target": "B17", "params": {"service": "bgp"}},
            {"action": "restore_record", "target": "DNS-1", "params": {"host": "svc.demo", "value": "10.40.0.10"}},
        ], "llm", "A model may compose actions from different categories")
        exp = await run_experiment(ctx, session.twin, change)
        exp.rollback = await session.twin.rehearse_rollback(exp.after, exp.diff)
        kinds = await RunbookPlanner().select_challenges(change, session.twin.supported_challenges)
        assert "warm_cache" in kinds
        assert "session_continuity" in kinds
        challenges = [await session.twin.challenge(k, exp.after, change, exp.fixed) for k in kinds]
        assert evaluate_gates(session.run["reproduction"], exp, challenges)["decision"] == "rejected"
        # A planner omitting evidence must not turn the same change green.
        for incomplete in (None, [], [c for c in challenges if c["kind"] != "warm_cache"]):
            gate = evaluate_gates(session.run["reproduction"], exp, incomplete)
            assert gate["decision"] == "rejected"
            assert next(g for g in gate["gates"] if g["id"] == "G4")["status"] == "fail"

    asyncio.run(scenario())


def test_cancelled_apply_keeps_uncertain_lab_blocked(tmp_path):
    async def scenario():
        session = await run_model("core", "route_misconfig", 7)
        # Model adapter acts as the lab; no device or Docker access is needed.
        session.demo.backend = "emulated"
        registry = Registry(Settings(data_dir=tmp_path, twin="emulated"))
        await registry._lab_lock.acquire()
        live = LiveIncident(session=session, topo=session.run["topology"], seed=7)
        live.persist = lambda: registry._persist(live)
        reached_observe = asyncio.Event()

        async def blocked_observe():
            reached_observe.set()
            await asyncio.Event().wait()

        session.demo.observe = blocked_observe
        task = asyncio.create_task(registry.decide(live, "test-operator", "cancel fixture", "approve"))
        await reached_observe.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert session.status == "recovery_required"
        assert session.outcome["status"] == "recovery_required"
        assert registry.store.get(session.incident_id)["status"] == "recovery_required"
        assert registry._lab_lock.locked()
        assert registry.store.needs_recovery()

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["observe", "partial_apply", "restore"])
def test_apply_exceptions_have_a_verified_recovery_outcome(tmp_path, failure):
    async def scenario():
        session = await run_model("core", "route_misconfig", 7)
        before = await session.demo.state_hash()
        original_apply = session.demo.apply_approved

        async def fail_observe():
            raise TimeoutError("post-check unavailable")

        async def partial_apply(change, token):
            await original_apply(change, token)
            raise TimeoutError("connection lost after a device write")

        async def fail_restore(previous, token):
            raise TimeoutError("rollback unavailable")

        session.demo.observe = fail_observe
        if failure == "partial_apply":
            session.demo.apply_approved = partial_apply
        if failure == "restore":
            session.demo.restore = fail_restore
        live = LiveIncident(session=session, topo=session.run["topology"], seed=7)
        registry = Registry(Settings(data_dir=tmp_path))
        await registry.decide(live, "test-operator", "isolated fixture", "approve")
        assert live.finished
        assert session.outcome["status"] == ("recovery_required" if failure == "restore" else "rolled_back")
        if failure != "restore":
            assert await session.demo.state_hash() == before
        else:
            assert await session.demo.state_hash() != before

    asyncio.run(scenario())
