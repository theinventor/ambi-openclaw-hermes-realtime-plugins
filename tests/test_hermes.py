"""Fast adapter contract tests; scripts/compat-hermes.py uses the real runtime."""
import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class Base:
    def __init__(self, config, platform):
        self.platform = platform
        self.received = []
        self.accept = True

    def build_source(self, **kwargs):
        return types.SimpleNamespace(**kwargs)

    async def handle_message(self, event):
        self.received.append(event)
        event._gateway_accepted = self.accept


modules = {
    "gateway": types.ModuleType("gateway"),
    "gateway.config": types.SimpleNamespace(Platform=lambda name: name),
    "gateway.platforms": types.ModuleType("gateway.platforms"),
    "gateway.platforms.base": types.SimpleNamespace(BasePlatformAdapter=Base, SendResult=types.SimpleNamespace),
    "gateway.platforms.event": types.SimpleNamespace(MessageEvent=types.SimpleNamespace, MessageType=types.SimpleNamespace(TEXT="text")),
}
with patch.dict(sys.modules, modules):
    spec = importlib.util.spec_from_file_location("ambi_adapter_test", Path(__file__).parents[1] / "plugins/hermes/adapter.py")
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_handoff_uses_explicit_session_and_requester(self):
        instance = adapter.AmbiguousAdapter({})
        event = {"notification_id": "one", "actor": {"id": "requester", "name": "Requester"}}
        await instance._deliver(event, "test prompt", "session-one")
        received = instance.received[0]
        self.assertEqual(received.source.chat_id, "session-one")
        self.assertEqual(received.source.user_id, "requester")
        self.assertFalse(received.allow_gateway_control)
        self.assertEqual(received.raw_message, event)
        instance.accept = False
        with self.assertRaisesRegex(RuntimeError, "did not accept"):
            await instance._deliver(event, "test prompt", "session-one")

    async def test_internal_notices_and_final_text_cannot_send(self):
        instance = adapter.AmbiguousAdapter({})
        await instance.handle_message(types.SimpleNamespace(internal=True))
        self.assertEqual(instance.received, [])
        result = await instance.send("any", "Do not post this")
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, "not-auto-sent")
        self.assertIsNone(await instance.send_typing("any"))

    async def test_connect_is_idempotent_and_disconnect_cancels_supervisor(self):
        instance = adapter.AmbiguousAdapter({})
        calls = []

        async def supervise():
            calls.append(True)
            await asyncio.Event().wait()

        instance._supervise = supervise
        with patch.object(adapter, "requirements", return_value=True):
            self.assertTrue(await instance.connect())
            self.assertTrue(await instance.connect())
            await asyncio.sleep(0)
            self.assertEqual(len(calls), 1)
            await instance.disconnect()
            await instance.disconnect()
            self.assertIsNone(instance._task)

    def test_registration_scopes_permissions_and_does_not_add_delivery_route(self):
        registrations = []
        adapter.register(types.SimpleNamespace(register_platform=lambda **kwargs: registrations.append(kwargs)))
        config = registrations[0]
        self.assertEqual(config["name"], "ambi-realtime")
        self.assertEqual(config["allow_all_env"], "AMBI_REALTIME_ALLOW_ALL")
        self.assertEqual(config["required_env"], [])
        self.assertNotIn("delivery_handler", config)


if __name__ == "__main__":
    unittest.main()
