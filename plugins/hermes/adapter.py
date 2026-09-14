"""Ambiguous native Hermes platform. The supervised Node bridge owns transport.

Derived from MonsterMailbox's thin-trigger platform: turn output and internal
gateway notices never become Workspace messages. The handling skill owns writes.
"""

import asyncio
import json
import logging
import os
from pathlib import Path

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "settings.local.json"
os.environ.setdefault("AMBI_REALTIME_ALLOW_ALL", "true")
os.environ.setdefault("AMBI_REALTIME_HOME_CHANNEL", "disabled")


def requirements():
    try:
        config = json.loads(SETTINGS.read_text())
        return Path(config["nodePath"]).is_file() and Path(config["configFile"]).is_file()
    except (OSError, ValueError, KeyError):
        return False


class AmbiguousAdapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = 50_000

    def __init__(self, config):
        super().__init__(config, Platform("ambi-realtime"))
        self.logger = logging.getLogger("ambi-realtime")
        self._task = None
        self._process = None
        self._stopping = False

    async def connect(self, **kwargs):
        if self._task and not self._task.done():
            return True
        if not requirements():
            self.logger.error("Ambiguous settings or saved credential file is missing")
            return False
        self._stopping = False
        self._task = asyncio.create_task(self._supervise())
        return True

    async def disconnect(self, **kwargs):
        self._stopping = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _supervise(self):
        backoff = 2
        while not self._stopping:
            proc = None
            try:
                settings = json.loads(SETTINGS.read_text())
                proc = await asyncio.create_subprocess_exec(
                    settings["nodePath"], str(ROOT / "bin/ambi-plugins.mjs"),
                    "bridge", "--settings", str(SETTINGS),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=None, limit=1024 * 1024,
                )
                self._process = proc
                async for line in proc.stdout:
                    frame = json.loads(line)
                    if frame.get("kind") != "event":
                        continue
                    event = frame["event"]
                    ok = False
                    try:
                        await self._deliver(event, frame["prompt"], frame["sessionKey"])
                        ok = True
                        backoff = 2
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        self.logger.exception("Ambiguous native handoff failed")
                    proc.stdin.write((json.dumps({"handoff": frame["handoff"], "ok": ok}) + "\n").encode())
                    await proc.stdin.drain()
                await proc.wait()
                if not self._stopping:
                    self.logger.warning("Ambiguous bridge exited %s; restarting", proc.returncode)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.logger.warning("Ambiguous bridge failure (%s); restarting", type(exc).__name__)
            finally:
                if proc and proc.returncode is None:
                    proc.terminate()
                    try:
                        await asyncio.wait_for(proc.wait(), 6)
                    except asyncio.TimeoutError:
                        proc.kill()
                        await proc.wait()
                self._process = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _deliver(self, event, prompt, session_key):
        actor = event.get("actor") or {}
        group = session_key
        source = self.build_source(
            chat_id=group, chat_name="Ambiguous Workspace", chat_type="dm",
            user_id=str(actor.get("id") or "workspace"), user_name=str(actor.get("name") or "Workspace"),
            message_id=event["notification_id"],
        )
        message = MessageEvent(
            text=prompt, message_type=MessageType.TEXT, source=source,
            message_id=event["notification_id"], raw_message=event, allow_gateway_control=False,
        )
        await self.handle_message(message)
        if not getattr(message, "_gateway_accepted", False):
            raise RuntimeError("Hermes did not accept the notification")

    async def handle_message(self, event):
        if getattr(event, "internal", False):
            return
        return await super().handle_message(event)

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        return SendResult(success=True, message_id="not-auto-sent")

    async def send_typing(self, chat_id):
        return None

    async def send_image(self, chat_id, image_url, caption=None, **kwargs):
        return await self.send(chat_id, caption or "")

    async def get_chat_info(self, chat_id):
        return {"name": "Ambiguous Workspace", "type": "dm", "chat_id": chat_id}


def register(ctx):
    ctx.register_platform(
        name="ambi-realtime", label="Ambiguous Realtime", adapter_factory=AmbiguousAdapter,
        check_fn=requirements, is_connected=lambda config: requirements(), required_env=[],
        install_hint="Run node bin/ambi-plugins.mjs install hermes --config /path/.ambi/config.json",
        allowed_users_env="AMBI_REALTIME_ALLOWED_ACTORS", allow_all_env="AMBI_REALTIME_ALLOW_ALL",
        max_message_length=50_000, pii_safe=True,
        platform_hint=(
            "Ambiguous events are thin triggers. Use your ambi-realtime skill and the pinned CLI "
            "in the prompt to claim one notification, handle its request, and reply in its source "
            "conversation. Your final text is never posted automatically. Do not start listeners."
        ),
        allow_update_command=True,
    )
