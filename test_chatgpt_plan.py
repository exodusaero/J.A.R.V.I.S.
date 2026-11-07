"""Offline contract tests for ChatGPT plan OAuth and Responses integration."""
from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from jarvis.chatgpt_plan import ChatGPTPlan, ChatGPTPlanAssistant, ChatGPTPlanError
from jarvis.web import create_server


def oauth_answer() -> dict:
    return {"id_token": "validated.jwt", "access_token": "test-access",
            "refresh_token": "test-refresh", "scope": "openid offline_access chatgpt.tokens.use.direct",
            "expires_in": 3600}


class FakeMemory:
    def __init__(self) -> None:
        self.turns = []

    def recent_history(self, limit):
        return [{"role": "user", "content": "Earlier question"},
                {"role": "assistant", "content": "Earlier answer"}]

    def save_turn(self, question, answer):
        self.turns.append((question, answer))


class ChatGPTPlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.plan = ChatGPTPlan(Path(self.directory.name), port=8765)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def connect(self) -> None:
        params = parse_qs(urlsplit(self.plan.start_sign_in()).query)
        with (patch("jarvis.chatgpt_plan._json_request", return_value=oauth_answer()) as exchange,
              patch.object(ChatGPTPlan, "_verify_identity", return_value={"sub": "user-123", "email": "user@example.com"})):
            self.plan.finish_sign_in({"code": ["code-123"], "state": params["state"], "client_id": ["oaiapp_test"]})
            self.assertEqual(exchange.call_args.kwargs["payload"]["client_id"], "oaiapp_test")
        self.assertTrue(self.plan.status()["connected"])

    def test_initial_dynamic_registration_and_private_host(self) -> None:
        params = parse_qs(urlsplit(self.plan.start_sign_in()).query)
        self.assertEqual(params["client_id"], ["dynamic_agent_client"])
        self.assertEqual(params["redirect_uri"], ["http://127.0.0.1:8765/auth/callback"])
        self.assertEqual(params["resource"], ["https://api.openai.com/v1"])
        self.assertEqual(params["agent_name_hint"], ["J.A.R.V.I.S."])
        self.assertIn("chatgpt.tokens.use.direct", params["scope"][0])
        self.assertNotIn("code_verifier", params)
        self.assertNotIn("client_secret", params)
        self.assertEqual(os.stat(self.plan.directory).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.plan.host_path).st_mode & 0o777, 0o600)
        second = ChatGPTPlan(Path(self.directory.name), port=54321)
        self.assertEqual(second.host_id, self.plan.host_id)

    def test_verified_callback_and_returning_client(self) -> None:
        self.connect()
        self.assertEqual(os.stat(self.plan.credentials_path).st_mode & 0o777, 0o600)
        saved = json.loads(self.plan.credentials_path.read_text())
        self.assertEqual(saved["subject"], "user-123")
        self.assertEqual(saved["client_id"], "oaiapp_test")
        renewed = parse_qs(urlsplit(self.plan.start_sign_in()).query)
        self.assertEqual(renewed["client_id"], ["oaiapp_test"])
        self.assertNotIn("agent_name_hint", renewed)
        self.assertEqual(renewed["id_token_hint"], ["validated.jwt"])

    def test_identity_signature_audience_and_nonce_are_verified(self) -> None:
        try:
            import jwt
            from cryptography.hazmat.primitives.asymmetric import rsa
        except ImportError:
            self.skipTest("Optional PyJWT[crypto] dependency not installed")
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        claims = {"iss": "https://auth.openai.com", "sub": "user-123", "aud": "oaiapp_test",
                  "exp": int(time.time()) + 300, "iat": int(time.time()), "nonce": "expected"}
        token = jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": "test-key"})
        key = SimpleNamespace(key=private_key.public_key())
        with patch("jwt.PyJWKClient") as jwks:
            jwks.return_value.get_signing_key_from_jwt.return_value = key
            self.assertEqual(ChatGPTPlan._verify_identity(token, "oaiapp_test", "expected")["sub"], "user-123")
            with self.assertRaises(ChatGPTPlanError):
                ChatGPTPlan._verify_identity(token, "oaiapp_other", "expected")
            with self.assertRaises(ChatGPTPlanError):
                ChatGPTPlan._verify_identity(token, "oaiapp_test", "wrong-nonce")

    def test_callback_fails_closed_and_preserves_account(self) -> None:
        params = parse_qs(urlsplit(self.plan.start_sign_in()).query)
        with patch("jarvis.chatgpt_plan._json_request") as exchange:
            with self.assertRaises(ChatGPTPlanError):
                self.plan.finish_sign_in({"code": ["code"], "state": ["wrong"], "client_id": ["oaiapp_test"]})
            exchange.assert_not_called()
        self.assertFalse(self.plan.status()["connected"])
        self.connect()
        retained = self.plan.credentials_path.read_bytes()
        params = parse_qs(urlsplit(self.plan.start_sign_in()).query)
        with patch("jarvis.chatgpt_plan._json_request") as exchange:
            with self.assertRaises(ChatGPTPlanError):
                self.plan.finish_sign_in({"code": ["code"], "state": params["state"], "client_id": ["oaiapp_other"]})
            exchange.assert_not_called()
        self.assertEqual(retained, self.plan.credentials_path.read_bytes())

    def test_refresh_rotates_credentials(self) -> None:
        self.connect()
        self.plan._credentials["saved_at"] = time.time() - 3600
        answer = {"access_token": "access-new", "refresh_token": "refresh-new", "expires_in": 1800}
        with patch("jarvis.chatgpt_plan._json_request", return_value=answer) as exchange:
            self.assertEqual(self.plan._access_token(), "access-new")
            self.assertEqual(exchange.call_args.kwargs["payload"]["refresh_token"], "test-refresh")
            self.assertEqual(self.plan._access_token(), "access-new")
            self.assertEqual(exchange.call_count, 1)
        self.assertEqual(json.loads(self.plan.credentials_path.read_text())["refresh_token"], "refresh-new")

    def test_streaming_request_must_complete_and_never_store(self) -> None:
        self.connect()
        catalog = {"models": [{"slug": "gpt-6.1-sol", "visibility": "list", "display_name": "GPT"}]}
        with patch("jarvis.chatgpt_plan._json_request", return_value=catalog):
            with patch("jarvis.chatgpt_plan.request.urlopen", return_value=io.BytesIO(
                b'data: {"type":"response.output_text.delta","delta":"Hello, Sir."}\n\n'
                b'data: {"type":"response.completed"}\n\n'
                b'data: [DONE]\n\n')) as stream:
                self.assertEqual(self.plan.respond("Hello", []), "Hello, Sir.")
                data = json.loads(stream.call_args.args[0].data)
                self.assertEqual(data["model"], "gpt-6.1-sol")
                self.assertFalse(data["store"])
                self.assertTrue(data["stream"])
                self.assertNotIn("previous_response_id", data)
        with patch("jarvis.chatgpt_plan.request.urlopen", return_value=io.BytesIO(
            b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n')):
            with self.assertRaisesRegex(ChatGPTPlanError, "confirmed completion"):
                self.plan.respond("Hello", [])

    def test_model_catalog_selection_and_fallback(self) -> None:
        self.connect()
        available = {"models": [{"slug": "gpt-available", "visibility": "list", "display_name": "Available GPT"},
                                {"slug": "hidden", "visibility": "hidden"}]}
        with patch("jarvis.chatgpt_plan._json_request", return_value=available):
            self.assertEqual(self.plan.models(), [{"slug": "gpt-available", "name": "Available GPT"}])
            self.assertEqual(self.plan.status()["model"], "gpt-available")
            self.assertEqual(self.plan.select_model("gpt-available"), "gpt-available")
            with self.assertRaises(ChatGPTPlanError):
                self.plan.select_model("hidden")

    def test_assistant_only_saves_successful_responses(self) -> None:
        memory = FakeMemory()
        assistant = ChatGPTPlanAssistant(self.plan, SimpleNamespace(memory=memory))
        with patch.object(self.plan, "respond", return_value="Answer") as respond:
            self.assertEqual(assistant.ask("  Question  "), "Answer")
            self.assertEqual(respond.call_args.args[0], "Question")
        self.assertEqual(memory.turns, [("  Question  ", "Answer")])
        with patch.object(self.plan, "respond", side_effect=ChatGPTPlanError("Not connected")):
            with self.assertRaises(ChatGPTPlanError):
                assistant.ask("Another question")
        self.assertEqual(len(memory.turns), 1)


class ChatGPTWebTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        plan = ChatGPTPlan(Path(self.directory.name), port=8765)
        assistant = SimpleNamespace(plan=plan, client=None)
        toolkit = SimpleNamespace(workspace=Path(self.directory.name), memory=None, permission_handler=None)
        self.server = create_server(assistant, toolkit, port=0, tailnet_origin="https://mac.private-tailnet.ts.net")
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def call(self, path, *, method="GET", host=None, origin=None, token=True):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        headers = {"Host": host or f"127.0.0.1:{self.server.server_port}"}
        if token:
            headers["X-Jarvis-Token"] = self.server.csrf_token
        if origin:
            headers["Origin"] = origin
        if method == "POST":
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method, path, body="{}" if method == "POST" else None, headers=headers)
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_authorize_route_requires_csrf_and_callback_state(self) -> None:
        self.assertEqual(self.call("/api/chatgpt/start", method="POST", token=False)[0], 403)
        status, body = self.call("/api/chatgpt/start", method="POST")
        self.assertEqual(status, 200)
        self.assertEqual(urlsplit(json.loads(body)["authorize_url"]).hostname, "auth.openai.com")
        status, body = self.call("/auth/callback?code=fake&state=wrong", token=False)
        self.assertEqual(status, 400)
        self.assertIn(b"Sign-in expired", body)

    def test_tailnet_origin_is_exact_and_off_by_default(self) -> None:
        host = "mac.private-tailnet.ts.net"
        self.assertEqual(self.call("/", host=host, origin="https://" + host, token=False)[0], 200)
        self.assertEqual(self.call("/", host=host, origin="https://evil.ts.net", token=False)[0], 403)
        self.assertEqual(self.call("/", host="evil.example.com", token=False)[0], 403)
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        for url in ["http://mac.private-tailnet.ts.net", "https://example.com", "https://a.ts.net/path",
                    "https://mac.private-tailnet.ts.net:443"]:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    create_server(SimpleNamespace(), SimpleNamespace(), port=0, tailnet_origin=url)


if __name__ == "__main__":
    unittest.main()
