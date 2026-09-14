"""Run with the supported Hermes venv and HERMES_SOURCE pointing to its checkout."""
import asyncio
import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path

source = Path(os.environ["HERMES_SOURCE"]).resolve()
sys.path.insert(0, str(source))
root = Path(__file__).resolve().parents[1]


async def verify():
    from gateway.config import PlatformConfig
    from gateway.platforms.event import MessageEvent
    spec = importlib.util.spec_from_file_location("ambi_realtime_compat", root / "plugins/hermes/adapter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    registrations = []
    module.register(types.SimpleNamespace(register_platform=lambda **kwargs: registrations.append(kwargs)))
    from gateway.platform_registry import PlatformEntry, platform_registry
    platform_registry.register(PlatformEntry(**registrations[0], source="plugin"))
    adapter = module.AmbiguousAdapter(PlatformConfig(enabled=True))
    seen = []

    async def handler(event):
        seen.append(event)
        return "Must not be posted automatically"

    adapter.set_message_handler(handler)
    await adapter._deliver({"notification_id": "compat-one", "type": "mention", "actor": {"id": "fixture-user"}}, "Compatibility fixture only", "compat-thread")
    for _ in range(100):
        if seen:
            break
        await asyncio.sleep(0.01)
    assert len(seen) == 1 and isinstance(seen[0], MessageEvent), "Real Hermes handler never ran"
    assert seen[0].source.user_id == "fixture-user"
    result = await adapter.send("compat-thread", "Do not post")
    assert result.success and result.message_id == "not-auto-sent"
    internal = MessageEvent(text="completion notice", source=seen[0].source, internal=True)
    await adapter.handle_message(internal)
    assert len(seen) == 1
    await asyncio.sleep(0.1)
    print("Real Hermes registration, MessageEvent handoff and no-auto-send: PASS")


with tempfile.TemporaryDirectory(prefix="ambi-hermes-compat-") as home:
    os.environ["HERMES_HOME"] = home
    asyncio.run(verify())
